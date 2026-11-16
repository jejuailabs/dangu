/**
 * 온라인 대전의 방 (PRD 06 §3).
 *
 * 서버가 경기의 원본을 가진다. 클라이언트는 샷 입력만 보내고, 서버가
 *   ① 차례인지 확인  ② 입력을 그 사람의 큐 한계 안으로 고정  ③ 물리 코어로 직접 계산해 판정
 * 한 뒤, 확정된 샷을 모두에게 알린다. 클라이언트는 같은 샷을 같은 코어로 재생할 뿐이라
 * 결과를 바꿀 수 없다. 결과 해시를 함께 보내 서로 어긋났는지 확인한다.
 *
 * 소켓과 분리된 순수 로직이라 테스트에서 가짜 연결로 돌릴 수 있다.
 */
import { type ShotInput } from '../../../packages/physics/src'
import { DEFAULT_RULES, type Discipline } from '../../../packages/rules/src'
import {
  type MatchConfig,
  type MatchRecord,
  type MatchState,
  type ShotRecord,
  type StrokeMeta,
  cueIdOf,
  initialState,
  newMatch,
  play,
} from '../../../packages/game/src'
import { clearElevation } from '../../../packages/game/src/cueGeometry'
import { type Profile, cueById } from '../../../packages/game/src/progress'
import type { Account, Service } from './service'

/** 끊긴 사람을 기다려 주는 시간 (ms). 넘으면 기권 */
export const RECONNECT_MS = 60_000
/** 상대를 기다리는 빈 방이 사라지는 시간 */
const WAITING_TTL_MS = 10 * 60_000
/** 끝난 방이 남아 있는 시간 */
const OVER_TTL_MS = 2 * 60_000
const DEG = Math.PI / 180

export interface Conn {
  send(msg: ServerMsg): void
}

export type ServerMsg =
  | {
      t: 'room'
      code: string
      /** 내 자리. 관전이면 -1 */
      you: number
      status: 'waiting' | 'playing' | 'over'
      config: MatchConfig | null
      record: MatchRecord | null
      seats: { name: string; connected: boolean; cue: string }[]
      /** 이번 샷의 제한 시각 (서버 시계, ms). 없으면 0 */
      deadline: number
      serverNow: number
    }
  | { t: 'shot'; index: number; shot: ShotRecord; hash: string; deadline: number; serverNow: number }
  | { t: 'aim'; phi: number; theta: number; side: number; top: number }
  | { t: 'presence'; seat: number; connected: boolean }
  | { t: 'over'; profile: Profile | null }
  | { t: 'error'; message: string }
  | { t: 'left' }

interface Seat {
  userId: number
  name: string
  target: number
  cueId: string
  conn: Conn | null
  /** 끊긴 시각. 연결되어 있으면 0 */
  goneAt: number
}

interface Room {
  code: string
  discipline: Discipline
  shotClock: number
  seats: Seat[]
  spectators: Set<Conn>
  status: 'waiting' | 'playing' | 'over'
  record: MatchRecord | null
  state: MatchState | null
  deadline: number
  createdAt: number
  endedAt: number
}

const TARGETS: Record<Discipline, number[]> = {
  '3cushion': [5, 10, 15, 20, 25, 30, 40],
  '4ball': [5, 8, 10, 12, 15, 20, 25, 30, 40, 50],
}
const num = (v: unknown, lo: number, hi: number, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(Math.max(v, lo), hi) : fallback

export class Rooms {
  private rooms = new Map<string, Room>()
  private where = new Map<Conn, { room: Room; seat: number }>()
  private seq = 0

  constructor(
    private service: Service,
    private now: () => number = () => Date.now(),
    /** 방 코드를 만드는 난수 (테스트에서 고정할 수 있다) */
    private random: () => number = Math.random,
  ) {}

  private newCode(): string {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789' // 헷갈리는 글자(0, O, 1, I)는 뺐다
    for (;;) {
      let c = ''
      for (let i = 0; i < 5; i++) c += chars[Math.floor(this.random() * chars.length)]
      if (!this.rooms.has(c)) return c
    }
  }

  private seatFor(user: Account, conn: Conn, d: Discipline, target: unknown): Seat {
    const list = TARGETS[d]
    const t = typeof target === 'number' && list.includes(target) ? target : list[1]
    return { userId: user.id, name: user.name, target: t, cueId: this.service.profile(user.id).equipped, conn, goneAt: 0 }
  }

  private roomMsg(room: Room, you: number): ServerMsg {
    return {
      t: 'room',
      code: room.code,
      you,
      status: room.status,
      config: room.record?.config ?? null,
      record: room.record,
      seats: room.seats.map((s) => ({ name: s.name, connected: s.conn !== null, cue: s.cueId })),
      deadline: room.deadline,
      serverNow: this.now(),
    }
  }

  private broadcast(room: Room, msg: ServerMsg): void {
    for (const s of room.seats) s.conn?.send(msg)
    for (const c of room.spectators) c.send(msg)
  }

  /** 이미 다른 방에 있으면 먼저 나온다 */
  private detach(conn: Conn): void {
    if (this.where.has(conn)) this.leave(conn)
  }

  create(user: Account, conn: Conn, opts: { discipline?: unknown; target?: unknown; shotClock?: unknown }): void {
    this.detach(conn)
    const d: Discipline = opts.discipline === '4ball' ? '4ball' : '3cushion'
    const clock = [0, 20, 30, 40, 60].includes(opts.shotClock as number) ? (opts.shotClock as number) : 40
    const room: Room = {
      code: this.newCode(),
      discipline: d,
      shotClock: clock,
      seats: [this.seatFor(user, conn, d, opts.target)],
      spectators: new Set(),
      status: 'waiting',
      record: null,
      state: null,
      deadline: 0,
      createdAt: this.now(),
      endedAt: 0,
    }
    this.rooms.set(room.code, room)
    this.where.set(conn, { room, seat: 0 })
    conn.send(this.roomMsg(room, 0))
  }

  join(user: Account, conn: Conn, opts: { code?: unknown; target?: unknown }): void {
    const code = typeof opts.code === 'string' ? opts.code.trim().toUpperCase() : ''
    const room = this.rooms.get(code)
    if (!room) return conn.send({ t: 'error', message: '없는 방입니다. 코드를 확인하세요' })
    this.detach(conn)

    // 이미 이 방의 선수면 다시 들어온 것이다 (끊겼다가 복귀)
    const mine = room.seats.findIndex((s) => s.userId === user.id)
    if (mine >= 0) {
      const seat = room.seats[mine]
      const old = seat.conn
      seat.conn = conn
      seat.goneAt = 0
      if (old && old !== conn) {
        this.where.delete(old)
        old.send({ t: 'left' })
      }
      this.where.set(conn, { room, seat: mine })
      conn.send(this.roomMsg(room, mine))
      this.broadcast(room, { t: 'presence', seat: mine, connected: true })
      return
    }

    if (room.status === 'waiting' && room.seats.length < 2) {
      room.seats.push(this.seatFor(user, conn, room.discipline, opts.target))
      this.where.set(conn, { room, seat: 1 })
      this.start(room)
      return
    }
    // 자리가 찼으면 관전
    room.spectators.add(conn)
    this.where.set(conn, { room, seat: -1 })
    conn.send(this.roomMsg(room, -1))
  }

  private start(room: Room): void {
    const config: MatchConfig = {
      discipline: room.discipline,
      players: room.seats.map((s) => ({ name: s.name, target: s.target })),
      rules: DEFAULT_RULES,
      shotClock: room.shotClock,
    }
    const id = `o${this.now().toString(36)}${(this.seq++).toString(36)}${Math.floor(this.random() * 46656).toString(36)}`
    room.record = { ...newMatch(config, id, this.now()), online: true }
    room.state = initialState(room.record)
    room.status = 'playing'
    room.deadline = room.shotClock > 0 ? this.now() + room.shotClock * 1000 : 0
    room.seats.forEach((s, i) => s.conn?.send(this.roomMsg(room, i)))
  }

  /** 클라이언트가 보낸 입력을 그 사람의 큐 한계 안으로 고정한다. 큐 사양은 서버가 정한다. */
  private sanitize(room: Room, seat: number, raw: unknown): ShotInput | null {
    if (!raw || typeof raw !== 'object' || !room.record || !room.state) return null
    const r = raw as Record<string, unknown>
    if (typeof r.phi !== 'number' || !Number.isFinite(r.phi)) return null
    const cue = cueById(room.seats[seat].cueId)
    const side = num(r.side, -0.9, 0.9, 0)
    const top = num(r.top, -0.9, 0.9, 0)
    const want = num(r.theta, 0, cue.maxElevation * DEG, 0)
    const cueBall = room.state.balls.find((b) => b.id === cueIdOf(seat))
    if (!cueBall) return null
    return {
      ballId: cueIdOf(seat),
      phi: r.phi,
      // 사람이 치는 화면과 같은 제약: 큐가 쿠션이나 다른 공에 걸리면 들어야 한다
      theta: clearElevation(room.record.table, room.state.balls, cueBall, r.phi, want, side, top),
      side,
      top,
      speed: num(r.speed, 0.05, cue.maxSpeed, 0.05),
      accel: num(r.accel, -200, 200, 0),
      cue: cue.spec,
    }
  }

  private apply(room: Room, shot: ShotRecord): void {
    if (!room.record || !room.state) return
    const r = play(room.record, room.state, shot)
    room.state = r.state
    const finished = r.state.finished
    room.deadline = !finished && room.shotClock > 0 ? this.now() + room.shotClock * 1000 : 0
    this.broadcast(room, {
      t: 'shot',
      index: room.record.shots.length - 1,
      shot: room.record.shots[room.record.shots.length - 1],
      hash: r.outcome.result?.hash ?? '',
      deadline: room.deadline,
      serverNow: this.now(),
    })
    if (finished) this.finish(room)
  }

  private finish(room: Room): void {
    if (!room.record) return
    room.status = 'over'
    room.endedAt = this.now()
    room.deadline = 0
    room.seats.forEach((s, i) => {
      let profile: Profile | null = null
      try {
        profile = this.service.addServerMatch(s.userId, room.record!, i)
      } catch (e) {
        console.error('경기 저장 실패', e)
      }
      s.conn?.send({ t: 'over', profile })
    })
    for (const c of room.spectators) c.send({ t: 'over', profile: null })
  }

  shot(conn: Conn, raw: { input?: unknown; stroke?: unknown }): void {
    const at = this.where.get(conn)
    if (!at || at.seat < 0) return conn.send({ t: 'error', message: '선수만 칠 수 있습니다' })
    const { room, seat } = at
    if (room.status !== 'playing' || !room.state) return conn.send({ t: 'error', message: '진행 중인 경기가 아닙니다' })
    if (room.state.turn !== seat) return conn.send({ t: 'error', message: '내 차례가 아닙니다' })
    const input = this.sanitize(room, seat, raw.input)
    if (!input) return conn.send({ t: 'error', message: '샷 입력이 올바르지 않습니다' })
    let stroke: StrokeMeta | undefined
    const st = raw.stroke as Partial<StrokeMeta> | undefined
    if (st && typeof st === 'object') {
      stroke = {
        accel: num(st.accel, -200, 200, 0),
        backswing: num(st.backswing, 0, 2, 0),
        aimError: num(st.aimError, -1, 1, 0),
        label: typeof st.label === 'string' ? st.label.slice(0, 30) : '',
      }
    }
    this.apply(room, { player: seat, input, stroke })
  }

  /** 조준하는 모습을 상대와 관전자에게 전한다 (결과에는 영향이 없다). */
  aim(conn: Conn, raw: Record<string, unknown>): void {
    const at = this.where.get(conn)
    if (!at || at.seat < 0 || at.room.status !== 'playing' || at.room.state?.turn !== at.seat) return
    const msg: ServerMsg = { t: 'aim', phi: num(raw.phi, -1000, 1000, 0), theta: num(raw.theta, 0, 1.6, 0), side: num(raw.side, -0.9, 0.9, 0), top: num(raw.top, -0.9, 0.9, 0) }
    at.room.seats.forEach((s, i) => {
      if (i !== at.seat) s.conn?.send(msg)
    })
    for (const c of at.room.spectators) c.send(msg)
  }

  /** 방에서 나간다. 경기 중인 선수가 나가면 기권이다. */
  leave(conn: Conn): void {
    const at = this.where.get(conn)
    if (!at) return
    this.where.delete(conn)
    const { room, seat } = at
    if (seat < 0) {
      room.spectators.delete(conn)
      return
    }
    room.seats[seat].conn = null
    if (room.status === 'waiting') {
      this.rooms.delete(room.code)
    } else if (room.status === 'playing') {
      this.apply(room, { player: seat, forfeit: true })
    }
  }

  /** 연결이 끊겼다. 바로 기권시키지 않고 돌아오기를 기다린다. */
  disconnect(conn: Conn): void {
    const at = this.where.get(conn)
    if (!at) return
    this.where.delete(conn)
    const { room, seat } = at
    if (seat < 0) {
      room.spectators.delete(conn)
      return
    }
    room.seats[seat].conn = null
    room.seats[seat].goneAt = this.now()
    if (room.status === 'waiting') this.rooms.delete(room.code)
    else this.broadcast(room, { t: 'presence', seat, connected: false })
  }

  /** 주기적으로 호출한다: 시간 초과, 끊긴 사람의 기권, 오래된 방 정리. */
  tick(): void {
    const now = this.now()
    for (const room of [...this.rooms.values()]) {
      if (room.status === 'playing' && room.state) {
        const gone = room.seats.findIndex((s) => s.goneAt > 0 && now - s.goneAt > RECONNECT_MS)
        if (gone >= 0) {
          this.apply(room, { player: gone, forfeit: true })
          continue
        }
        if (room.deadline > 0 && now > room.deadline) this.apply(room, { player: room.state.turn, timeout: true })
      } else if (room.status === 'waiting' && now - room.createdAt > WAITING_TTL_MS) {
        room.seats[0]?.conn?.send({ t: 'error', message: '상대가 오지 않아 방이 닫혔습니다' })
        this.close(room)
      } else if (room.status === 'over' && now - room.endedAt > OVER_TTL_MS) {
        this.close(room)
      }
    }
  }

  private close(room: Room): void {
    for (const s of room.seats) if (s.conn) this.where.delete(s.conn)
    for (const c of room.spectators) this.where.delete(c)
    this.rooms.delete(room.code)
  }

  /** 테스트와 점검용 */
  get size(): number {
    return this.rooms.size
  }
}
