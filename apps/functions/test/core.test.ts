import { beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_CUE, DEG, type ShotInput, simulate } from '../../../packages/physics/src'
import { DEFAULT_RULES, initialLayout, judge, tableFor } from '../../../packages/rules/src'
import { type MatchConfig, type MatchRecord, type ShotRecord, initialState, newMatch, play, rebuild } from '../../../packages/game/src'
import { clearElevation } from '../../../packages/game/src/cueGeometry'
import { cueById } from '../../../packages/game/src/progress'
import { ApiError, Core, RECONNECT_MS } from '../src/core'
import { type Identity, verifyIdToken } from '../src/google'
import { handle } from '../src/handler'
import { createBackend } from '../src/node'
import { MemoryStore, type RoomDoc, type Store } from '../src/store'

const A: Identity = { uid: 'ua', name: 'alice' }
const B: Identity = { uid: 'ub', name: 'bob' }
const C: Identity = { uid: 'uc', name: 'carol' }

const shot = (deg: number, speed = 3): ShotRecord => ({
  player: 0,
  input: { ballId: 0, phi: deg * DEG, theta: 0, side: 0, top: 0.2, speed, cue: DEFAULT_CUE } as ShotInput,
})
const SCORING = shot(2, 4)
const MISS_IN = { phi: 250 * DEG, theta: 0, side: 0, top: 0, speed: 0.5 }

function finished(id: string, versus = false): MatchRecord {
  const config: MatchConfig = {
    discipline: '3cushion',
    players: versus ? [{ name: '나', target: 1 }, { name: '상대', target: 1 }] : [{ name: '나', target: 1 }],
    rules: DEFAULT_RULES,
    shotClock: 0,
  }
  const rec = newMatch(config, id, 1000)
  expect(play(rec, initialState(rec), SCORING).state.finished).toBe(true)
  return rec
}

/** 서버가 고정하는 조건(하우스 큐, 최소 고각)에서 초구 배치의 득점 샷 */
function findScoring() {
  const table = tableFor('3cushion')
  const balls = initialLayout('3cushion')
  const house = cueById('house')
  for (let d = 0; d < 360; d += 1)
    for (const speed of [3, 4.5, 5]) {
      const phi = d * DEG
      const theta = clearElevation(table, balls, balls[0], phi, 0, 0, 0.2)
      const res = simulate(table, balls, { ballId: 0, phi, theta, side: 0, top: 0.2, speed, cue: house.spec })
      if (judge('3cushion', res, 0).scored) return { phi, theta: 0, side: 0, top: 0.2, speed }
    }
  throw new Error('득점 샷을 찾지 못함')
}
const SCORE_IN = findScoring()

const status = async (p: Promise<unknown>): Promise<number> => {
  try {
    await p
    return 200
  } catch (e) {
    if (e instanceof ApiError) return e.status
    throw e
  }
}

let store: MemoryStore
let core: Core
let clock: number
beforeEach(() => {
  store = new MemoryStore()
  clock = 1_000_000
  let r = 0
  core = new Core(store, () => clock, () => (r = (r + 0.37) % 1))
})

describe('프로필과 기록', () => {
  it('처음 온 사람은 하우스 큐와 0 에서 시작한다', async () => {
    const me = await core.me(A)
    expect(me.account).toEqual({ id: 'ua', name: 'alice' })
    expect(me.profile).toEqual({ xp: 0, coins: 0, owned: ['house'], equipped: 'house', games: 0, wins: 0 })
  })

  it('끝난 경기를 다시 계산해 보상을 주고, 같은 경기는 한 번만 인정한다', async () => {
    const r = await core.addMatch(A, finished('match01'))
    expect(r.duplicate).toBe(false)
    expect(r.profile.xp).toBe(1)
    expect(r.profile.coins).toBe(12)
    const again = await core.addMatch(A, finished('match01'))
    expect(again.duplicate).toBe(true)
    expect(again.profile.coins).toBe(12)
    expect((await core.matches(A)).map((m) => m.id)).toEqual(['match01'])
    expect(await core.matches(B)).toEqual([])
  })

  it('대전 승리 보너스', async () => {
    expect((await core.addMatch(A, finished('match02', true))).profile).toMatchObject({ coins: 32, wins: 1 })
  })

  it('끝나지 않은 경기, 부풀린 목표, 다른 코어 버전, 온라인 표시, 깨진 기록은 받지 않는다', async () => {
    const cfg: MatchConfig = { discipline: '3cushion', players: [{ name: '나', target: 5 }], rules: DEFAULT_RULES, shotClock: 0 }
    const open = newMatch(cfg, 'open01', 1)
    play(open, initialState(open), shot(250, 0.5))
    expect(await status(core.addMatch(A, open))).toBe(400)
    const cheat = { ...finished('cheat01') }
    cheat.config = { ...cheat.config, players: [{ name: '나', target: 50 }] }
    expect(await status(core.addMatch(A, cheat))).toBe(400)
    expect(await status(core.addMatch(A, { ...finished('ver01'), coreVersion: '0.0.1' }))).toBe(409)
    expect(await status(core.addMatch(A, { ...finished('onl01'), online: true }))).toBe(400)
    expect(await status(core.addMatch(A, null))).toBe(400)
    expect(await status(core.addMatch(A, { ...finished('bad01'), shots: [{ player: 0, input: { phi: 'x' } }] }))).toBe(400)
    expect((await core.me(A)).profile.games).toBe(0)
  })

  it('큐는 다마수와 코인이 되어야 살 수 있다', async () => {
    expect(await status(core.buyCue(A, 'oak'))).toBe(403)
    for (let i = 0; i < 15; i++) await core.addMatch(A, finished(`grind${String(i).padStart(3, '0')}`))
    const p = await core.buyCue(A, 'oak')
    expect(p).toMatchObject({ equipped: 'oak', coins: 180 - 40 })
    expect((await core.me(A)).profile.owned).toEqual(['house', 'oak'])
    expect(await status(core.buyCue(A, 'oak'))).toBe(409)
    expect(await status(core.buyCue(A, 'gold'))).toBe(403)
    expect(await status(core.buyCue(A, 'nope'))).toBe(400)
    expect((await core.equipCue(A, 'house')).equipped).toBe('house')
    expect(await status(core.equipCue(A, 'gold'))).toBe(403)
  })
})

describe('온라인 방', () => {
  async function meet(target = 5, shotClock = 0): Promise<string> {
    const r = await core.roomCreate(A, { discipline: '3cushion', target, shotClock })
    await core.roomJoin(B, { code: r.code, target })
    return r.code
  }

  it('방을 만들면 코드가 나오고, 상대가 들어오면 시작한다', async () => {
    const r = await core.roomCreate(A, { discipline: '3cushion', target: 10, shotClock: 40 })
    expect(r.code).toMatch(/^[A-Z2-9]{5}$/)
    expect(r).toMatchObject({ status: 'waiting', you: 0, record: null })
    const j = await core.roomJoin(B, { code: ` ${r.code.toLowerCase()} `, target: 10 })
    expect(j).toMatchObject({ status: 'playing', you: 1, deadline: clock + 40_000 })
    expect(j.record!.config.players.map((p) => p.name)).toEqual(['alice', 'bob'])
    expect(await status(core.roomJoin(C, { code: 'ZZZZZ' }))).toBe(404)
  })

  it('자리가 찬 방에 들어오면 관전자다', async () => {
    const code = await meet()
    const v = await core.roomJoin(C, { code })
    expect(v.you).toBe(-1)
    expect(await status(core.roomShot(C, code, { input: MISS_IN }))).toBe(403)
  })

  it('차례인 사람의 샷만 받고, 상대는 조회로 새 샷만 받아 간다', async () => {
    const code = await meet()
    expect(await status(core.roomShot(B, code, { input: MISS_IN }))).toBe(409)
    const mine = await core.roomShot(A, code, { input: MISS_IN, have: 0 })
    expect(mine.total).toBe(1)
    expect(mine.shots.length).toBe(1)
    const theirs = await core.roomState(B, code, 0, false)
    expect(theirs.shots).toEqual(mine.shots)
    expect((await core.roomState(B, code, 1, false)).shots).toEqual([])
    await core.roomShot(B, code, { input: MISS_IN, have: 1 })
    expect((await core.roomState(A, code, 1, false)).shots.length).toBe(1)
  })

  it('받은 샷을 그대로 다시 계산하면 서버와 같은 상태가 된다', async () => {
    const code = await meet()
    const first = await core.roomJoin(B, { code })
    await core.roomShot(A, code, { input: SCORE_IN })
    await core.roomShot(A, code, { input: MISS_IN })
    await core.roomShot(B, code, { input: { ...MISS_IN, phi: 1 } })
    const rec = structuredClone(first.record!)
    rec.shots.push(...(await core.roomState(B, code, 0, false)).shots)
    const mineState = rebuild(rec).state
    const server = (await store.getRoom(code))!.room.state!
    expect(mineState).toEqual(server)
    expect(mineState.players[0].score).toBe(1)
  })

  it('큐 사양과 한계는 서버가 정한다', async () => {
    const code = await meet()
    const v = await core.roomShot(A, code, { input: { phi: 0.3, theta: 80 * DEG, side: 5, top: -5, speed: 999, cue: { tipRestitution: 9 } } })
    const input = v.shots[v.shots.length - 1].input!
    const house = cueById('house')
    expect(input.speed).toBe(house.maxSpeed)
    expect(input.cue).toEqual(house.spec)
    expect([input.side, input.top]).toEqual([0.9, -0.9])
    for (const bad of [null, {}, { phi: 'x' }, { phi: Number.NaN }]) {
      expect(await status(core.roomShot(B, code, { input: bad }))).toBeGreaterThanOrEqual(400)
    }
  })

  it('제한 시간을 넘기면, 누가 방을 조회할 때 시간 초과로 넘어간다', async () => {
    const code = await meet(5, 20)
    clock += 19_000
    expect((await core.roomState(B, code, 0, true)).total).toBe(0)
    clock += 2_000
    const v = await core.roomState(B, code, 0, true)
    expect(v.total).toBe(1)
    expect(v.shots[0]).toMatchObject({ timeout: true, player: 0 })
    expect((await core.roomShot(B, code, { input: MISS_IN })).total).toBe(2)
  })

  it('접속을 알리지 않는 사람은 60초 뒤 기권이고, 상대가 이긴다', async () => {
    const code = await meet()
    clock += RECONNECT_MS - 5_000
    // A 만 계속 접속을 알린다
    expect((await core.roomState(A, code, 0, true)).status).toBe('playing')
    clock += 10_000
    const v = await core.roomState(A, code, 0, true)
    expect(v.status).toBe('over')
    expect(v.shots[0]).toMatchObject({ forfeit: true, player: 1 })
    expect(v.profile!.wins).toBe(1)
    expect((await core.me(B)).profile.wins).toBe(0)
  })

  it('끊겼다가 돌아오면 놓친 샷을 받아 이어서 한다', async () => {
    const code = await meet()
    await core.roomShot(A, code, { input: MISS_IN })
    clock += 30_000
    await core.roomState(A, code, 1, true)
    const back = await core.roomJoin(B, { code })
    expect(back).toMatchObject({ you: 1, status: 'playing', total: 1 })
    expect(back.record!.shots.length).toBe(1)
    expect((await core.roomShot(B, code, { input: MISS_IN })).total).toBe(2)
  })

  it('나가면 기권이고, 두 사람 모두 자기 자리 기준의 기록이 남는다', async () => {
    const code = await meet()
    await core.roomShot(A, code, { input: SCORE_IN })
    await core.roomLeave(B, code)
    const v = await core.roomState(A, code, 0, false)
    expect(v.status).toBe('over')
    expect(v.profile).toMatchObject({ wins: 1, xp: 1 })
    expect(v.profile!.coins).toBe(1 * 2 + 10 + 20)
    const ra = (await core.matches(A))[0]
    const rb = (await core.matches(B))[0]
    expect([ra.viewSeat, rb.viewSeat]).toEqual([0, 1])
    expect(ra.online && rb.online).toBe(true)
    // 여러 번 조회해도 보상은 한 번만
    await core.roomState(A, code, 0, false)
    expect((await core.me(A)).profile.games).toBe(1)
  })

  it('상대가 오기 전에 나가거나 오래 지나면 방이 닫힌다', async () => {
    const r = await core.roomCreate(A, {})
    await core.roomLeave(A, r.code)
    expect((await core.roomJoin(B, { code: r.code })).status).toBe('over')
    const r2 = await core.roomCreate(A, {})
    clock += 11 * 60_000
    expect(await status(core.roomJoin(B, { code: r2.code }))).toBe(404)
  })

  it('두 요청이 동시에 방을 고치면 한쪽이 다시 읽어서 처리한다', async () => {
    // 첫 저장을 일부러 실패시키는 저장소
    let failNext = true
    const flaky: Store = new Proxy(store, {
      get(target, prop, recv) {
        if (prop === 'saveRoom') {
          return async (room: RoomDoc, version: string) => {
            if (failNext) {
              failNext = false
              return false
            }
            return target.saveRoom(room, version)
          }
        }
        const v = Reflect.get(target, prop, recv)
        return typeof v === 'function' ? v.bind(target) : v
      },
    })
    const c2 = new Core(flaky, () => clock, () => 0.5)
    const r = await c2.roomCreate(A, {})
    const j = await c2.roomJoin(B, { code: r.code })
    expect(j.status).toBe('playing')
    expect(failNext).toBe(false)
  })
})

describe('요청 처리와 로그인 확인', () => {
  const dev = createBackend({ DANGU_STORE: 'memory' })
  const call = (method: string, path: string, token?: string, body?: unknown) =>
    handle(dev.core, dev.verify, { method, path: path.split('?')[0], query: new URLSearchParams(path.split('?')[1] ?? ''), authorization: token ? `Bearer ${token}` : undefined, body })

  it('로그인하지 않으면 /api/me 는 빈 계정, 나머지는 401', async () => {
    expect((await call('GET', '/api/me')).body).toEqual({ account: null })
    expect((await call('GET', '/api/matches')).status).toBe(401)
    expect((await call('POST', '/api/room/create', undefined, {})).status).toBe(401)
    expect((await call('GET', '/api/matches', 'garbage')).status).toBe(401)
  })

  it('로그인하면 경로대로 동작하고, 없는 주소는 404', async () => {
    expect((await call('GET', '/api/me', 'dev:tester')).body).toMatchObject({ account: { name: 'tester' } })
    const room = await call('POST', '/api/room/create', 'dev:tester', { discipline: '4ball' })
    expect(room.status).toBe(200)
    const code = (room.body as { code: string }).code
    expect((await call('GET', `/api/room?code=${code}&have=-1`, 'dev:tester')).status).toBe(200)
    expect((await call('GET', '/api/nope', 'dev:tester')).status).toBe(404)
  })

  it('가짜 로그인은 Vercel 환경에서는 켜지지 않는다', () => {
    // VERCEL 이 설정되어 있으면 메모리 모드를 무시하고 Firebase 설정을 요구한다
    expect(() => createBackend({ DANGU_STORE: 'memory', VERCEL: '1' })).toThrow()
  })

  it('형식이 틀리거나 서명 방식을 바꿔친 로그인 토큰은 거절한다', async () => {
    const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url')
    const body = b64({ aud: 'p', iss: 'https://securetoken.google.com/p', sub: 'x', exp: 9e9, iat: 1 })
    expect(await verifyIdToken('not-a-token', 'p')).toBeNull()
    expect(await verifyIdToken(`${b64({ alg: 'none' })}.${body}.`, 'p')).toBeNull()
    expect(await verifyIdToken(`${b64({ alg: 'HS256', kid: 'k' })}.${body}.sig`, 'p')).toBeNull()
    expect(await verifyIdToken(`${b64({ alg: 'RS256' })}.${body}.sig`, 'p')).toBeNull()
  })
})
