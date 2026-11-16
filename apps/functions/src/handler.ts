/**
 * HTTP 요청을 서버 로직으로 잇는다. Vercel 함수와 개발용 서버가 같은 것을 쓴다.
 * 로그인 확인은 요청마다 Authorization: Bearer <Firebase 로그인 토큰> 으로 한다 (쿠키를 쓰지 않는다).
 */
import { ApiError, type Core } from './core'
import type { Identity } from './google'

export interface Req {
  method: string
  /** /api 로 시작하는 경로 */
  path: string
  query: URLSearchParams
  authorization: string | undefined
  body: unknown
}

export interface Res {
  status: number
  body: unknown
}

/** 로그인 토큰에서 사용자를 알아낸다. 유효하지 않으면 null */
export type Verifier = (token: string) => Promise<Identity | null>

export async function handle(core: Core, verify: Verifier, req: Req): Promise<Res> {
  try {
    const m = /^Bearer (.+)$/.exec(req.authorization ?? '')
    const id = m ? await verify(m[1]) : null
    const route = `${req.method} ${req.path.replace(/\/+$/, '')}`
    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>

    if (route === 'GET /api/me') return { status: 200, body: id ? await core.me(id) : { account: null } }
    if (route === 'GET /api/health') return { status: 200, body: { ok: true } }
    if (!id) throw new ApiError(401, '로그인이 필요합니다')

    switch (route) {
      case 'GET /api/matches':
        return { status: 200, body: { matches: await core.matches(id) } }
      case 'POST /api/matches':
        return { status: 200, body: await core.addMatch(id, req.body) }
      case 'POST /api/cues/buy':
        return { status: 200, body: { profile: await core.buyCue(id, body.id) } }
      case 'POST /api/cues/equip':
        return { status: 200, body: { profile: await core.equipCue(id, body.id) } }
      case 'POST /api/room/create':
        return { status: 200, body: await core.roomCreate(id, body) }
      case 'POST /api/room/join':
        return { status: 200, body: await core.roomJoin(id, body) }
      case 'GET /api/room':
        return {
          status: 200,
          body: await core.roomState(id, req.query.get('code'), Number(req.query.get('have') ?? '-1'), req.query.get('beat') === '1'),
        }
      case 'POST /api/room/shot':
        return { status: 200, body: await core.roomShot(id, body.code, body) }
      case 'POST /api/room/leave':
        return { status: 200, body: await core.roomLeave(id, body.code) }
      default:
        throw new ApiError(404, '없는 주소입니다')
    }
  } catch (e) {
    if (e instanceof ApiError) return { status: e.status, body: { error: e.message } }
    console.error(e)
    return { status: 500, body: { error: '서버 오류' } }
  }
}
