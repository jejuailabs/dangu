/**
 * 구글 API 를 라이브러리 없이 직접 부른다 (서비스 계정 토큰, Firebase 로그인 토큰 검증, Firestore REST).
 *
 * firebase-admin 을 쓰지 않는 이유: 서버 함수는 요청마다 새로 뜰 수 있어 가벼워야 하고,
 * 필요한 것은 "토큰 서명 확인" 과 "문서 읽기·쓰기" 뿐이다. Node 내장 crypto 와 fetch 로 충분하다.
 */
import { X509Certificate, createSign, createVerify } from 'node:crypto'

export interface ServiceAccount {
  projectId: string
  clientEmail: string
  privateKey: string
}

/** 환경변수에서 서비스 계정을 읽는다. 개인 키의 \n 은 실제 줄바꿈으로 되돌린다. */
export function serviceAccountFromEnv(env: Record<string, string | undefined> = process.env): ServiceAccount {
  const projectId = env.FIREBASE_PROJECT_ID?.trim()
  const clientEmail = env.FIREBASE_CLIENT_EMAIL?.trim()
  const privateKey = env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n')
  if (!projectId || !clientEmail || !privateKey) throw new Error('FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY 환경변수가 필요합니다')
  return { projectId, clientEmail, privateKey }
}

const b64url = (v: string | object) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url')

// ── 서비스 계정 접근 토큰 ─────────────────────────────
let cached: { token: string; exp: number; email: string } | null = null

/** Firestore 를 부를 때 쓰는 접근 토큰. 만료 전까지 재사용한다. */
export async function accessToken(sa: ServiceAccount): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  if (cached && cached.email === sa.clientEmail && cached.exp - 60 > now) return cached.token
  const head = b64url({ alg: 'RS256', typ: 'JWT' })
  const claim = b64url({
    iss: sa.clientEmail,
    scope: 'https://www.googleapis.com/auth/datastore',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  })
  const sig = createSign('RSA-SHA256').update(`${head}.${claim}`).sign(sa.privateKey).toString('base64url')
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=${encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer')}&assertion=${head}.${claim}.${sig}`,
  })
  const j = (await r.json()) as { access_token?: string; expires_in?: number }
  if (!j.access_token) throw new Error('서비스 계정 토큰을 받지 못했습니다')
  cached = { token: j.access_token, exp: now + (j.expires_in ?? 3600), email: sa.clientEmail }
  return j.access_token
}

// ── Firebase 로그인 토큰 검증 ─────────────────────────
const CERT_URL = 'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com'
let certs: { map: Record<string, string>; exp: number } | null = null

async function publicCerts(): Promise<Record<string, string>> {
  if (certs && certs.exp > Date.now()) return certs.map
  const r = await fetch(CERT_URL)
  if (!r.ok) throw new Error('구글 공개 키를 받지 못했습니다')
  const maxAge = Number(/max-age=(\d+)/.exec(r.headers.get('cache-control') ?? '')?.[1] ?? 3600)
  certs = { map: (await r.json()) as Record<string, string>, exp: Date.now() + maxAge * 1000 }
  return certs.map
}

export interface Identity {
  uid: string
  name: string
}

/**
 * 브라우저가 보낸 Firebase 로그인 토큰(JWT)을 검증한다.
 * 구글의 공개 키로 서명을 확인하고, 이 프로젝트용 토큰인지와 만료를 본다. 통과하지 못하면 null.
 */
export async function verifyIdToken(token: string, projectId: string, now = Date.now()): Promise<Identity | null> {
  const parts = token.split('.')
  if (parts.length !== 3) return null
  let head: { alg?: string; kid?: string }
  let body: { aud?: string; iss?: string; sub?: string; exp?: number; iat?: number; name?: string; email?: string }
  try {
    head = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'))
    body = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
  } catch {
    return null
  }
  // 서명 방식을 토큰이 정하게 두지 않는다 (alg 를 none 이나 HS256 으로 바꿔치는 공격을 막는다)
  if (head.alg !== 'RS256' || !head.kid) return null
  const pem = (await publicCerts())[head.kid]
  if (!pem) return null
  const ok = createVerify('RSA-SHA256')
    .update(`${parts[0]}.${parts[1]}`)
    .verify(new X509Certificate(pem).publicKey, Buffer.from(parts[2], 'base64url'))
  if (!ok) return null
  const sec = Math.floor(now / 1000)
  if (body.aud !== projectId || body.iss !== `https://securetoken.google.com/${projectId}`) return null
  if (!body.sub || typeof body.sub !== 'string' || body.sub.length > 128) return null
  if (!body.exp || body.exp <= sec || !body.iat || body.iat > sec + 300) return null
  const raw = (body.name || body.email?.split('@')[0] || '플레이어').trim()
  return { uid: body.sub, name: raw.slice(0, 12) || '플레이어' }
}

// ── Firestore REST ───────────────────────────────────
export type FsValue = { stringValue: string } | { integerValue: string } | { doubleValue: number } | { booleanValue: boolean }
export type FsFields = Record<string, FsValue>
export interface FsDoc {
  name: string
  fields?: FsFields
  updateTime: string
}

export const fsString = (v: string): FsValue => ({ stringValue: v })
export const fsInt = (v: number): FsValue => ({ integerValue: String(Math.trunc(v)) })
export function fsRead(f: FsFields | undefined, key: string): string | number | boolean | undefined {
  const v = f?.[key]
  if (!v) return undefined
  if ('stringValue' in v) return v.stringValue
  if ('integerValue' in v) return Number(v.integerValue)
  if ('doubleValue' in v) return v.doubleValue
  if ('booleanValue' in v) return v.booleanValue
  return undefined
}

export class Firestore {
  readonly root: string
  constructor(private sa: ServiceAccount) {
    this.root = `projects/${sa.projectId}/databases/(default)/documents`
  }
  private url(path: string): string {
    return `https://firestore.googleapis.com/v1/${this.root}${path}`
  }
  private async call(method: string, url: string, body?: unknown): Promise<{ status: number; json: any }> {
    const r = await fetch(url, {
      method,
      headers: { Authorization: `Bearer ${await accessToken(this.sa)}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    let json: any = null
    try {
      json = await r.json()
    } catch {
      /* 본문 없음 */
    }
    return { status: r.status, json }
  }

  docName(path: string): string {
    return `${this.root}/${path}`
  }

  async get(path: string): Promise<FsDoc | null> {
    const r = await this.call('GET', this.url(`/${path}`))
    if (r.status === 404) return null
    if (r.status !== 200) throw new Error(`Firestore 읽기 실패 (${r.status})`)
    return r.json as FsDoc
  }

  /** 문서가 없을 때만 만든다. 이미 있으면 false */
  async create(path: string, fields: FsFields): Promise<boolean> {
    const r = await this.call('PATCH', this.url(`/${path}?currentDocument.exists=false`), { fields })
    if (r.status === 200) return true
    if (r.status === 409 || r.json?.error?.status === 'ALREADY_EXISTS') return false
    throw new Error(`Firestore 만들기 실패 (${r.status})`)
  }

  /** 읽은 뒤로 바뀌지 않았을 때만 덮어쓴다 (동시에 두 요청이 같은 문서를 고치는 것을 막는다). 바뀌었으면 false */
  async replaceIfUnchanged(path: string, fields: FsFields, updateTime: string): Promise<boolean> {
    const r = await this.call('PATCH', this.url(`/${path}?currentDocument.updateTime=${encodeURIComponent(updateTime)}`), { fields })
    if (r.status === 200) return true
    const st = r.json?.error?.status
    if (r.status === 409 || r.status === 400 || st === 'FAILED_PRECONDITION' || st === 'ABORTED') return false
    throw new Error(`Firestore 쓰기 실패 (${r.status})`)
  }

  /** 일부 필드만 고친다 (없으면 만든다) */
  async merge(path: string, fields: FsFields): Promise<void> {
    const mask = Object.keys(fields)
      .map((k) => `updateMask.fieldPaths=${encodeURIComponent(k)}`)
      .join('&')
    const r = await this.call('PATCH', this.url(`/${path}?${mask}`), { fields })
    if (r.status !== 200) throw new Error(`Firestore 고치기 실패 (${r.status})`)
  }

  /**
   * 여러 쓰기를 한 번에 (모두 되거나 모두 안 된다).
   * 이미 있는 문서를 만들려 해서 실패했으면 'exists' 를 돌려준다.
   */
  async commit(writes: unknown[]): Promise<'ok' | 'exists'> {
    const r = await this.call('POST', this.url(':commit'), { writes })
    if (r.status === 200) return 'ok'
    const st = r.json?.error?.status
    if (r.status === 409 || st === 'ALREADY_EXISTS' || st === 'FAILED_PRECONDITION') return 'exists'
    throw new Error(`Firestore 묶음 쓰기 실패 (${r.status})`)
  }

  /** 하위 컬렉션을 한 필드로 정렬해 읽는다 */
  async query(parentPath: string, collectionId: string, orderField: string, limit: number): Promise<FsDoc[]> {
    const r = await this.call('POST', this.url(`/${parentPath}:runQuery`), {
      structuredQuery: {
        from: [{ collectionId }],
        orderBy: [{ field: { fieldPath: orderField }, direction: 'DESCENDING' }],
        limit,
      },
    })
    if (r.status !== 200) throw new Error(`Firestore 조회 실패 (${r.status})`)
    return ((r.json as { document?: FsDoc }[]) ?? []).filter((x) => x.document).map((x) => x.document!)
  }

  async remove(path: string): Promise<void> {
    await this.call('DELETE', this.url(`/${path}`))
  }
}
