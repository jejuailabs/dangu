/**
 * 서버 호출 (계정, 기록 동기화). 서버가 없어도 게임은 손님 모드로 그대로 돌아간다.
 * 세션은 HttpOnly 쿠키라서 여기서는 토큰을 다루지 않는다.
 */
import type { MatchRecord } from '../../../packages/game/src'
import type { Profile } from '../../../packages/game/src/progress'

export interface Account {
  id: number
  name: string
}

async function call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), 8000)
  let res: Response
  try {
    res = await fetch(`/api${path}`, {
      method,
      credentials: 'same-origin',
      headers: method === 'POST' ? { 'Content-Type': 'application/json' } : undefined,
      body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined,
      signal: ctl.signal,
    })
  } catch {
    throw new Error('서버에 연결할 수 없습니다')
  } finally {
    clearTimeout(timer)
  }
  let data: unknown = null
  try {
    data = await res.json()
  } catch {
    /* 본문이 JSON 이 아니면 아래에서 상태 코드로 처리 */
  }
  if (!res.ok) throw new Error((data as { error?: string } | null)?.error ?? `서버 오류 (${res.status})`)
  return data as T
}

export const api = {
  me: () => call<{ account: Account | null; profile?: Profile }>('GET', '/me'),
  signup: (name: string, password: string) => call<{ account: Account; profile: Profile }>('POST', '/signup', { name, password }),
  login: (name: string, password: string) => call<{ account: Account; profile: Profile }>('POST', '/login', { name, password }),
  logout: () => call<{ ok: boolean }>('POST', '/logout'),
  matches: () => call<{ matches: MatchRecord[] }>('GET', '/matches'),
  addMatch: (record: MatchRecord) => call<{ profile: Profile; duplicate: boolean }>('POST', '/matches', record),
  buyCue: (id: string) => call<{ profile: Profile }>('POST', '/cues/buy', { id }),
  equipCue: (id: string) => call<{ profile: Profile }>('POST', '/cues/equip', { id }),
}
