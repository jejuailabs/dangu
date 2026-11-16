/**
 * Node 의 HTTP 요청·응답을 handler 에 잇는다. Vercel 함수(entry.ts)와 개발용 서버(dev.ts)가 함께 쓴다.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Core } from './core'
import { Firestore, serviceAccountFromEnv, verifyIdToken } from './google'
import { type Verifier, handle } from './handler'
import { FirestoreStore, MemoryStore } from './store'

const MAX_BODY = 400_000

function readBody(req: IncomingMessage): Promise<unknown> {
  // Vercel 은 본문을 이미 읽어 req.body 에 넣어 주기도 한다
  const pre = (req as IncomingMessage & { body?: unknown }).body
  if (pre !== undefined) return Promise.resolve(typeof pre === 'string' ? safeJson(pre) : pre)
  return new Promise((resolve) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size <= MAX_BODY) chunks.push(c)
    })
    req.on('end', () => resolve(size > MAX_BODY || chunks.length === 0 ? {} : safeJson(Buffer.concat(chunks).toString('utf8'))))
    req.on('error', () => resolve({}))
  })
}
function safeJson(s: string): unknown {
  try {
    return JSON.parse(s)
  } catch {
    return {}
  }
}

/**
 * 환경에 맞는 서버 로직과 로그인 확인 방법을 만든다.
 * - 기본: Firestore + Firebase 로그인 토큰 검증
 * - DANGU_STORE=memory: 메모리 저장소 + 이름만으로 들어오는 가짜 로그인. 자동 점검 전용이다.
 *   Vercel 에서는 이 값을 설정하지 않으므로 배포본에서는 켜질 수 없다.
 */
export function createBackend(env: Record<string, string | undefined> = process.env): { core: Core; verify: Verifier } {
  if (env.DANGU_STORE === 'memory' && !env.VERCEL) {
    const verify: Verifier = async (token) => {
      const m = /^dev:([\p{L}\p{N}_]{2,12})$/u.exec(token)
      return m ? { uid: `dev_${m[1]}`, name: m[1] } : null
    }
    return { core: new Core(new MemoryStore()), verify }
  }
  const sa = serviceAccountFromEnv(env)
  const core = new Core(new FirestoreStore(new Firestore(sa)))
  return { core, verify: (token) => verifyIdToken(token, sa.projectId) }
}

export function nodeHandler(backend: { core: Core; verify: Verifier }) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    // Vercel 의 주소 규칙이 원래 경로를 __path 로 넘겨 준다 (예: /api/room/shot -> /api?__path=room/shot)
    const sub = url.searchParams.get('__path')
    const out = await handle(backend.core, backend.verify, {
      method: req.method ?? 'GET',
      path: sub !== null ? `/api/${sub}` : url.pathname,
      query: url.searchParams,
      authorization: req.headers.authorization,
      body: req.method === 'GET' ? {} : await readBody(req),
    })
    res.writeHead(out.status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end(JSON.stringify(out.body))
  }
}
