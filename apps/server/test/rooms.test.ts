import { beforeEach, describe, expect, it } from 'vitest'
import { DEG, simulate } from '../../../packages/physics/src'
import { initialLayout, judge, tableFor } from '../../../packages/rules/src'
import { clearElevation } from '../../../packages/game/src/cueGeometry'
import { rebuild } from '../../../packages/game/src'
import { cueById } from '../../../packages/game/src/progress'
import { type Conn, RECONNECT_MS, Rooms, type ServerMsg } from '../src/rooms'
import { type Account, Service } from '../src/service'

/** 받은 메시지를 모아 두는 가짜 연결 */
class Fake implements Conn {
  log: ServerMsg[] = []
  send(m: ServerMsg): void {
    // 실제 소켓처럼 복사본을 받는다 (서버의 객체를 같이 쓰지 않는다)
    this.log.push(structuredClone(m))
  }
  last<T extends ServerMsg['t']>(t: T): Extract<ServerMsg, { t: T }> | undefined {
    for (let i = this.log.length - 1; i >= 0; i--) if (this.log[i].t === t) return this.log[i] as Extract<ServerMsg, { t: T }>
    return undefined
  }
  count(t: ServerMsg['t']): number {
    return this.log.filter((m) => m.t === t).length
  }
}

let service: Service
let rooms: Rooms
let clock: number
let a: Account
let b: Account
let ca: Fake
let cb: Fake

beforeEach(() => {
  service = new Service(':memory:')
  clock = 1_000_000
  let r = 0
  rooms = new Rooms(service, () => clock, () => (r = (r + 0.37) % 1))
  a = service.signup('alice', 'secret12').account
  b = service.signup('bob', 'secret12').account
  ca = new Fake()
  cb = new Fake()
})

/** 두 사람이 방에서 만난다 */
function meet(target = 5, shotClock = 40): string {
  rooms.create(a, ca, { discipline: '3cushion', target, shotClock })
  const code = ca.last('room')!.code
  rooms.join(b, cb, { code, target })
  return code
}
/** 서버가 고정하는 조건(하우스 큐, 최소 고각)에서 초구 배치의 득점 샷을 찾는다 */
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
const SCORING = findScoring()
const MISS = { phi: 250 * DEG, theta: 0, side: 0, top: 0, speed: 0.5 }

describe('방 만들기와 참가', () => {
  it('방을 만들면 코드가 나오고 상대를 기다린다', () => {
    rooms.create(a, ca, { discipline: '3cushion', target: 10, shotClock: 40 })
    const m = ca.last('room')!
    expect(m.code).toMatch(/^[A-Z2-9]{5}$/)
    expect(m.status).toBe('waiting')
    expect(m.you).toBe(0)
    expect(m.record).toBeNull()
  })

  it('상대가 코드로 들어오면 경기가 시작된다', () => {
    meet()
    const ma = ca.last('room')!
    const mb = cb.last('room')!
    expect(ma.status).toBe('playing')
    expect([ma.you, mb.you]).toEqual([0, 1])
    expect(ma.record!.config.players.map((p) => p.name)).toEqual(['alice', 'bob'])
    expect(ma.record!.id).toBe(mb.record!.id)
    expect(ma.deadline).toBe(clock + 40_000)
  })

  it('코드는 대소문자와 공백을 가리지 않고, 없는 코드는 오류다', () => {
    rooms.create(a, ca, {})
    const code = ca.last('room')!.code
    rooms.join(b, cb, { code: `  ${code.toLowerCase()} ` })
    expect(cb.last('room')!.status).toBe('playing')
    const cc = new Fake()
    rooms.join(service.signup('carol', 'secret12').account, cc, { code: 'ZZZZZ' })
    expect(cc.last('error')).toBeDefined()
  })

  it('자리가 찬 방에 들어오면 관전자가 된다', () => {
    const code = meet()
    const cc = new Fake()
    rooms.join(service.signup('carol', 'secret12').account, cc, { code })
    expect(cc.last('room')!.you).toBe(-1)
    rooms.shot(cc, { input: SCORING })
    expect(cc.last('error')!.message).toContain('선수만')
    rooms.shot(ca, { input: MISS })
    expect(cc.last('shot')).toBeDefined()
  })
})

describe('샷', () => {
  it('차례인 사람의 샷만 받고, 모두에게 같은 샷과 해시를 알린다', () => {
    meet()
    rooms.shot(cb, { input: MISS })
    expect(cb.last('error')!.message).toContain('차례')
    expect(ca.count('shot')).toBe(0)

    rooms.shot(ca, { input: MISS })
    const sa = ca.last('shot')!
    const sb = cb.last('shot')!
    expect(sa).toEqual(sb)
    expect(sa.index).toBe(0)
    expect(sa.hash).toMatch(/^[a-f0-9]{16}$/)
    // 실패했으니 차례가 넘어간다
    rooms.shot(cb, { input: MISS })
    expect(cb.last('shot')!.index).toBe(1)
  })

  it('받은 샷을 그대로 재생하면 서버와 같은 결과가 나온다', () => {
    meet()
    rooms.shot(ca, { input: SCORING })
    rooms.shot(ca, { input: MISS })
    rooms.shot(cb, { input: { ...MISS, phi: 1 } })
    // 클라이언트가 하는 일: 방 정보의 기록에 받은 샷을 차례로 붙여 다시 계산
    const rec = structuredClone(cb.log.find((m) => m.t === 'room' && m.status === 'playing') as Extract<ServerMsg, { t: 'room' }>).record!
    const shots = cb.log.filter((m): m is Extract<ServerMsg, { t: 'shot' }> => m.t === 'shot')
    for (const s of shots) rec.shots.push(s.shot)
    const re = rebuild(rec)
    shots.forEach((s, i) => expect(re.outcomes[i].result!.hash).toBe(s.hash))
    expect(re.state.players[0].score).toBe(1)
  })

  it('큐 사양과 한계는 서버가 정한다 (보낸 값을 믿지 않는다)', () => {
    meet()
    rooms.shot(ca, { input: { phi: 0.3, theta: 80 * DEG, side: 5, top: -5, speed: 999, cue: { tipRestitution: 9, miscueLimit: 9 } } })
    const input = ca.last('shot')!.shot.input!
    const house = cueById('house')
    expect(input.speed).toBe(house.maxSpeed)
    expect(input.cue).toEqual(house.spec)
    expect(input.side).toBe(0.9)
    expect(input.top).toBe(-0.9)
    // 하우스 큐는 20도까지만 세울 수 있다 (큐가 걸려서 더 들어야 하는 경우는 예외)
    expect(input.theta).toBeLessThanOrEqual(20 * DEG + 0.2)
    expect(input.ballId).toBe(0)
  })

  it('깨진 입력은 받지 않는다', () => {
    meet()
    for (const bad of [null, {}, { phi: 'x' }, { phi: Number.NaN }, { phi: Infinity }]) {
      rooms.shot(ca, { input: bad })
    }
    expect(ca.count('shot')).toBe(0)
    expect(ca.count('error')).toBe(5)
  })

  it('조준은 상대에게만 전해지고, 차례가 아닌 사람의 조준은 버린다', () => {
    meet()
    rooms.aim(ca, { phi: 1, theta: 0, side: 0.2, top: 0 })
    expect(cb.last('aim')!.phi).toBe(1)
    expect(ca.count('aim')).toBe(0)
    rooms.aim(cb, { phi: 2 })
    expect(ca.count('aim')).toBe(0)
  })
})

describe('시간과 끝', () => {
  it('제한 시간을 넘기면 서버가 시간 초과로 차례를 넘긴다', () => {
    meet(5, 20)
    clock += 19_000
    rooms.tick()
    expect(ca.count('shot')).toBe(0)
    clock += 2_000
    rooms.tick()
    const s = ca.last('shot')!
    expect(s.shot.timeout).toBe(true)
    expect(s.shot.player).toBe(0)
    rooms.shot(cb, { input: MISS })
    expect(cb.last('shot')!.index).toBe(1)
  })

  it('목표에 닿으면 끝나고, 두 사람 모두 서버에 기록과 보상이 남는다', () => {
    meet(5)
    // 목표 5 를 한 번에 채우기는 어려우니 목표를 1 로 낮춘 방을 따로 만든다
    rooms.leave(ca)
    ca.log = []
    cb.log = []
    rooms.create(a, ca, { discipline: '3cushion', target: 5, shotClock: 0 })
    // 가능한 목표 중 가장 작은 5 를 쓰되, 득점 샷을 반복할 수 없으므로 기권으로 끝을 본다
    rooms.join(b, cb, { code: ca.last('room')!.code, target: 5 })
    rooms.shot(ca, { input: SCORING })
    rooms.leave(cb)
    expect(ca.last('over')!.profile!.wins).toBeGreaterThanOrEqual(1)
    const mine = service.listMatches(a.id)[0]
    expect(mine.online).toBe(true)
    expect(mine.viewSeat).toBe(0)
    expect(service.listMatches(b.id)[0].viewSeat).toBe(1)
    // 이긴 사람: 득점 1 (경험치 1) + 코인 2 + 완주 10 + 승리 20
    const p = service.profile(a.id)
    expect(p.xp).toBeGreaterThanOrEqual(1)
    expect(p.coins).toBeGreaterThanOrEqual(32)
  })

  it('경기 중에 나가면 기권이고 상대가 이긴다', () => {
    meet()
    rooms.leave(ca)
    const s = cb.last('shot')!
    expect(s.shot.forfeit).toBe(true)
    expect(s.shot.player).toBe(0)
    expect(cb.last('over')).toBeDefined()
    expect(service.profile(b.id).wins).toBe(1)
    expect(service.profile(a.id).wins).toBe(0)
  })

  it('끊겨도 바로 지지 않고, 같은 계정으로 돌아오면 이어서 한다', () => {
    const code = meet(5, 0)
    rooms.shot(ca, { input: MISS })
    rooms.disconnect(cb)
    expect(ca.last('presence')).toEqual({ t: 'presence', seat: 1, connected: false })
    clock += RECONNECT_MS - 5_000
    rooms.tick()
    expect(ca.count('over')).toBe(0)

    const cb2 = new Fake()
    rooms.join(b, cb2, { code })
    const m = cb2.last('room')!
    expect(m.you).toBe(1)
    expect(m.status).toBe('playing')
    expect(m.record!.shots.length).toBe(1)
    rooms.shot(cb2, { input: MISS })
    expect(ca.last('shot')!.index).toBe(1)
  })

  it('끊긴 채로 기다리는 시간을 넘기면 기권이다', () => {
    meet(5, 0)
    rooms.disconnect(cb)
    clock += RECONNECT_MS + 1_000
    rooms.tick()
    expect(ca.last('shot')!.shot.forfeit).toBe(true)
    expect(ca.last('over')).toBeDefined()
    expect(service.profile(a.id).wins).toBe(1)
  })

  it('상대가 오지 않은 방과 끝난 방은 정리된다', () => {
    rooms.create(a, ca, {})
    expect(rooms.size).toBe(1)
    clock += 11 * 60_000
    rooms.tick()
    expect(rooms.size).toBe(0)
    meet()
    rooms.leave(ca)
    clock += 3 * 60_000
    rooms.tick()
    expect(rooms.size).toBe(0)
  })

  it('클라이언트는 온라인 기록을 직접 올릴 수 없다', () => {
    meet()
    rooms.leave(ca)
    const rec = service.listMatches(b.id)[0]
    expect(() => service.addMatch(a.id, { ...rec, id: 'forged01' })).toThrow()
  })
})
