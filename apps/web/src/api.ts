/**
 * 서버 호출. 서버가 없거나 로그인하지 않아도 게임은 손님 모드로 그대로 돌아간다.
 * 요청마다 로그인 토큰을 Authorization 헤더로 보낸다.
 */
import type { MatchConfig, MatchRecord, ShotRecord } from '../../../packages/game/src'
import type { Profile } from '../../../packages/game/src/progress'
import { idToken } from './auth'

export interface Account {
  id: string
  name: string
}

/** 서버가 알려 주는 방의 상태 */
export interface RoomView {
  code: string
  you: number
  status: 'waiting' | 'playing' | 'over'
  config: MatchConfig | null
  record: MatchRecord | null
  shots: ShotRecord[]
  from: number
  total: number
  seats: { name: string; connected: boolean; cue: string }[]
  deadline: number
  serverNow: number
  profile: Profile | null
  /** 서버가 계산한 지금 상태의 지문. 내 계산과 다르면 서버 것으로 맞춘다 */
  sig: string
}

export class ApiFailure extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message)
  }
}

async function call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), 12000)
  const token = await idToken()
  const headers: Record<string, string> = {}
  if (token) headers.Authorization = `Bearer ${token}`
  if (method === 'POST') headers['Content-Type'] = 'application/json'
  let res: Response
  try {
    res = await fetch(`/api${path}`, { method, headers, body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined, signal: ctl.signal })
  } catch {
    throw new ApiFailure(0, '서버에 연결할 수 없습니다')
  } finally {
    clearTimeout(timer)
  }
  let data: unknown = null
  try {
    data = await res.json()
  } catch {
    /* 본문이 JSON 이 아니면 아래에서 상태 코드로 처리 */
  }
  if (!res.ok) throw new ApiFailure(res.status, (data as { error?: string } | null)?.error ?? `서버 오류 (${res.status})`)
  return data as T
}

export const api = {
  me: () => call<{ account: Account | null; profile?: Profile }>('GET', '/me'),
  matches: () => call<{ matches: MatchRecord[] }>('GET', '/matches'),
  addMatch: (record: MatchRecord) => call<{ profile: Profile; duplicate: boolean }>('POST', '/matches', record),
  buyCue: (id: string) => call<{ profile: Profile }>('POST', '/cues/buy', { id }),
  equipCue: (id: string) => call<{ profile: Profile }>('POST', '/cues/equip', { id }),
  roomCreate: (o: { discipline: string; target: number; shotClock: number }) => call<RoomView>('POST', '/room/create', o),
  roomJoin: (code: string, target?: number) => call<RoomView>('POST', '/room/join', { code, target }),
  roomState: (code: string, have: number, beat: boolean) => call<RoomView>('GET', `/room?code=${encodeURIComponent(code)}&have=${have}&beat=${beat ? 1 : 0}`),
  roomShot: (code: string, input: unknown, stroke: unknown, have: number, chalked = false) => call<RoomView>('POST', '/room/shot', { code, input, stroke, have, chalked }),
  roomLeave: (code: string) => call<{ ok: boolean }>('POST', '/room/leave', { code }),
}
