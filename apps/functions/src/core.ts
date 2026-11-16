/**
 * 서버 로직: 프로필, 경기 기록, 큐, 온라인 대전의 방.
 *
 * 원칙은 그대로다. 서버는 클라이언트가 보낸 점수를 믿지 않는다.
 * 샷 입력만 받아 같은 물리 코어로 직접 계산해 점수·보상·대전 결과를 정한다.
 *
 * 서버 함수는 요청마다 새로 뜰 수 있어 메모리에 방을 들고 있을 수 없다. 그래서 방은 저장소에 두고,
 * 요청이 올 때마다 읽어서 고친 뒤 "읽은 뒤로 바뀌지 않았을 때만" 저장한다(동시 요청 충돌 방지).
 * 시간 초과와 끊긴 사람의 기권도 따로 도는 타이머 없이, 누군가 방을 조회할 때 확인한다.
 */
import { CORE_VERSION, type ShotInput } from '../../../packages/physics/src'
import { DEFAULT_RULES, type Discipline } from '../../../packages/rules/src'
import {
  type MatchConfig,
  type MatchRecord,
  type ShotRecord,
  type StrokeMeta,
  cueIdOf,
  initialState,
  newMatch,
  play,
  rebuild,
  stateSig,
} from '../../../packages/game/src'
import { clearElevation } from '../../../packages/game/src/cueGeometry'
import { CUES, type Profile, cueById, cueStatus, levelOf, rewardFor } from '../../../packages/game/src/progress'
import type { Identity } from './google'
import type { RoomDoc, Store, UserDoc } from './store'

/** 접속을 알리지 않은 사람을 기다려 주는 시간 (ms). 넘으면 기권 */
export const RECONNECT_MS = 60_000
/** 이 시간 안에 접속을 알렸으면 "연결됨" 으로 보여 준다 */
const ONLINE_MS = 25_000
const WAITING_TTL_MS = 10 * 60_000
const MAX_RECORD_BYTES = 300_000
const MAX_SHOTS = 3000
const DEG = Math.PI / 180

const TARGETS: Record<Discipline, number[]> = {
  '3cushion': [5, 10, 15, 20, 25, 30, 40],
  '4ball': [5, 8, 10, 12, 15, 20, 25, 30, 40, 50],
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message)
  }
}

export interface RoomView {
  code: string
  /** 내 자리. 관전이면 -1 */
  you: number
  status: 'waiting' | 'playing' | 'over'
  config: MatchConfig | null
  /** 처음 받을 때(have 가 음수)만 전체 기록을 준다. 그 뒤로는 새 샷만 준다 */
  record: MatchRecord | null
  /** have 번째부터의 샷 */
  shots: ShotRecord[]
  from: number
  total: number
  seats: { name: string; connected: boolean; cue: string }[]
  deadline: number
  serverNow: number
  /** 경기가 끝났고 내가 선수면, 보상이 반영된 내 프로필 */
  profile: Profile | null
  /** 서버가 계산한 지금 상태의 지문 (클라이언트가 자기 계산과 비교한다) */
  sig: string
}

const num = (v: unknown, lo: number, hi: number, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(Math.max(v, lo), hi) : fallback

export function profileOf(u: UserDoc): Profile {
  const spent = u.owned.reduce((sum, id) => sum + (CUES.find((c) => c.id === id)?.price ?? 0), 0)
  return { xp: u.xp, coins: Math.max(0, u.earned - spent), owned: u.owned, equipped: u.equipped, games: u.games, wins: u.wins }
}

export class Core {
  constructor(
    private store: Store,
    private now: () => number = () => Date.now(),
    private random: () => number = Math.random,
  ) {}

  // ── 프로필과 큐 ─────────────────────────────────────
  async me(id: Identity): Promise<{ account: { id: string; name: string }; profile: Profile }> {
    const u = await this.store.ensureUser(id.uid, id.name)
    return { account: { id: id.uid, name: u.name }, profile: profileOf(u) }
  }

  async buyCue(id: Identity, cueId: unknown): Promise<Profile> {
    const u = await this.store.ensureUser(id.uid, id.name)
    const p = profileOf(u)
    const cue = CUES.find((c) => c.id === cueId)
    if (!cue) throw new ApiError(400, '없는 큐입니다')
    const st = cueStatus(p, cue)
    if (st === 'locked') throw new ApiError(403, `다마 ${cue.minDamasu} 부터 살 수 있습니다 (지금 ${levelOf(p.xp).damasu})`)
    if (st === 'poor') throw new ApiError(403, '코인이 모자랍니다')
    if (st !== 'available') throw new ApiError(409, '이미 가진 큐입니다')
    await this.store.setCues(id.uid, [...u.owned, cue.id], cue.id)
    return profileOf({ ...u, owned: [...u.owned, cue.id], equipped: cue.id })
  }

  async equipCue(id: Identity, cueId: unknown): Promise<Profile> {
    const u = await this.store.ensureUser(id.uid, id.name)
    if (typeof cueId !== 'string' || !u.owned.includes(cueId)) throw new ApiError(403, '가지고 있지 않은 큐입니다')
    await this.store.setCues(id.uid, u.owned, cueId)
    return profileOf({ ...u, equipped: cueId })
  }

  // ── 경기 기록 ──────────────────────────────────────
  /** 클라이언트가 올린 끝난 경기. 처음부터 다시 계산해 점수와 보상을 정한다. 같은 경기는 한 번만 인정한다. */
  async addMatch(id: Identity, raw: unknown): Promise<{ profile: Profile; duplicate: boolean }> {
    const text = JSON.stringify(raw)
    if (!raw || typeof raw !== 'object' || text.length > MAX_RECORD_BYTES) throw new ApiError(400, '기록 형식이 올바르지 않습니다')
    const rec = raw as MatchRecord
    if (typeof rec.id !== 'string' || !/^[a-z0-9]{4,40}$/.test(rec.id)) throw new ApiError(400, '기록 번호가 올바르지 않습니다')
    // 온라인 대전 기록은 서버가 직접 만든다. 클라이언트가 보낸 것은 받지 않는다
    if (rec.online) throw new ApiError(400, '온라인 대전 기록은 서버에서만 저장합니다')
    if (rec.coreVersion !== CORE_VERSION) throw new ApiError(409, `물리 코어 버전이 다릅니다 (서버 ${CORE_VERSION}, 기록 ${String(rec.coreVersion)})`)
    if (!Array.isArray(rec.shots) || rec.shots.length === 0 || rec.shots.length > MAX_SHOTS) throw new ApiError(400, '샷 목록이 올바르지 않습니다')
    const players = rec.config?.players
    if (!Array.isArray(players) || players.length < 1 || players.length > 2) throw new ApiError(400, '선수 정보가 올바르지 않습니다')
    for (const p of players) {
      if (typeof p?.target !== 'number' || !(p.target >= 1 && p.target <= 200)) throw new ApiError(400, '목표 점수가 올바르지 않습니다')
    }
    let state
    try {
      state = rebuild(rec).state
    } catch {
      throw new ApiError(400, '기록을 다시 계산할 수 없습니다')
    }
    if (!state.finished) throw new ApiError(400, '끝나지 않은 경기입니다')
    await this.store.ensureUser(id.uid, id.name)
    const me = state.players[0]
    const won = players.length > 1 && state.winner === 0
    const reward = rewardFor(me.score, true, won)
    const createdAt = typeof rec.createdAt === 'number' && Number.isFinite(rec.createdAt) ? Math.min(rec.createdAt, this.now()) : this.now()
    const created = await this.store.addMatch(id.uid, { id: rec.id, createdAt, record: text, score: me.score, innings: me.innings, won, xp: reward.xp, coins: reward.coins })
    return { profile: profileOf((await this.store.getUser(id.uid))!), duplicate: !created }
  }

  async matches(id: Identity): Promise<MatchRecord[]> {
    const list = await this.store.listMatches(id.uid, 30)
    const out: MatchRecord[] = []
    for (const s of list) {
      try {
        out.push(JSON.parse(s) as MatchRecord)
      } catch {
        /* 깨진 기록은 건너뛴다 */
      }
    }
    return out
  }

  // ── 온라인 대전 ────────────────────────────────────
  private newCode(): string {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789' // 헷갈리는 글자(0, O, 1, I)는 뺐다
    let c = ''
    for (let i = 0; i < 5; i++) c += chars[Math.floor(this.random() * chars.length)]
    return c
  }

  private view(room: RoomDoc, uid: string, have: number, profile: Profile | null = null): RoomView {
    const now = this.now()
    const shots = room.record?.shots ?? []
    const from = have < 0 ? shots.length : Math.min(have, shots.length)
    return {
      code: room.code,
      you: room.seats.findIndex((s) => s.uid === uid),
      status: room.status,
      config: room.record?.config ?? null,
      record: have < 0 ? room.record : null,
      shots: shots.slice(from),
      from,
      total: shots.length,
      seats: room.seats.map((s) => ({ name: s.name, connected: now - s.seenAt < ONLINE_MS, cue: s.cueId })),
      deadline: room.deadline,
      serverNow: now,
      profile,
      sig: room.state ? stateSig(room.state) : '',
    }
  }

  private apply(room: RoomDoc, shot: ShotRecord): void {
    if (!room.record || !room.state) return
    const r = play(room.record, room.state, shot)
    room.state = r.state
    if (r.state.finished) {
      room.status = 'over'
      room.endedAt = this.now()
      room.deadline = 0
    } else {
      room.deadline = room.shotClock > 0 ? this.now() + room.shotClock * 1000 : 0
    }
  }

  /** 시간이 지나서 생기는 일: 끊긴 사람의 기권, 샷 제한 시간 초과. 바뀐 것이 있으면 true */
  private tick(room: RoomDoc): boolean {
    if (room.status !== 'playing' || !room.state) return false
    const now = this.now()
    const gone = room.seats.findIndex((s) => now - s.seenAt > RECONNECT_MS)
    if (gone >= 0) {
      this.apply(room, { player: gone, forfeit: true })
      return true
    }
    if (room.deadline > 0 && now > room.deadline) {
      this.apply(room, { player: room.state.turn, timeout: true })
      return true
    }
    return false
  }

  /** 끝난 방의 결과를 두 사람의 계정에 저장한다. 여러 번 불려도 한 번만 반영된다. */
  private async saveResult(room: RoomDoc): Promise<void> {
    if (room.status !== 'over' || !room.record || !room.state || room.seats.length < 2) return
    for (let i = 0; i < room.seats.length; i++) {
      const me = room.state.players[i]
      const won = room.state.winner === i
      const reward = rewardFor(me.score, true, won)
      await this.store.addMatch(room.seats[i].uid, {
        id: room.record.id,
        createdAt: room.record.createdAt,
        record: JSON.stringify({ ...room.record, viewSeat: i, online: true }),
        score: me.score,
        innings: me.innings,
        won,
        xp: reward.xp,
        coins: reward.coins,
      })
    }
  }

  /**
   * 방을 읽어 고치고 저장한다. 그 사이 다른 요청이 고쳤으면 다시 읽어서 한다.
   * fn 은 바꾼 것이 있으면 true 를 돌려준다.
   */
  private async mutate(code: string, fn: (room: RoomDoc) => boolean): Promise<RoomDoc> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const cur = await this.store.getRoom(code)
      if (!cur) throw new ApiError(404, '없는 방입니다. 코드를 확인하세요')
      const room = cur.room
      if (room.status === 'waiting' && this.now() - room.createdAt > WAITING_TTL_MS) throw new ApiError(404, '상대가 오지 않아 방이 닫혔습니다')
      const wasOver = room.status === 'over'
      const ticked = this.tick(room)
      const changed = fn(room) || ticked
      if (!changed) return room
      if (await this.store.saveRoom(room, cur.version)) {
        if (!wasOver && room.status === 'over') await this.saveResult(room)
        return room
      }
    }
    throw new ApiError(503, '잠시 후 다시 시도하세요')
  }

  private async overProfile(room: RoomDoc, id: Identity): Promise<Profile | null> {
    if (room.status !== 'over' || !room.seats.some((s) => s.uid === id.uid)) return null
    // 결과 저장이 다른 요청에서 진행 중일 수 있으니 한 번 더 확실히 한다 (이미 됐으면 아무 일도 없다)
    await this.saveResult(room)
    const u = await this.store.getUser(id.uid)
    return u ? profileOf(u) : null
  }

  private async seat(id: Identity, d: Discipline, target: unknown) {
    const u = await this.store.ensureUser(id.uid, id.name)
    const list = TARGETS[d]
    return { uid: id.uid, name: u.name, target: typeof target === 'number' && list.includes(target) ? target : list[1], cueId: u.equipped, seenAt: this.now() }
  }

  async roomCreate(id: Identity, opts: { discipline?: unknown; target?: unknown; shotClock?: unknown }): Promise<RoomView> {
    const d: Discipline = opts.discipline === '4ball' ? '4ball' : '3cushion'
    const clock = [0, 20, 30, 40, 60].includes(opts.shotClock as number) ? (opts.shotClock as number) : 40
    const seat = await this.seat(id, d, opts.target)
    for (let attempt = 0; attempt < 6; attempt++) {
      const room: RoomDoc = {
        code: this.newCode(),
        discipline: d,
        shotClock: clock,
        status: 'waiting',
        seats: [seat],
        record: null,
        state: null,
        deadline: 0,
        createdAt: this.now(),
        endedAt: 0,
      }
      if (await this.store.createRoom(room)) return this.view(room, id.uid, -1)
    }
    throw new ApiError(503, '방을 만들지 못했습니다. 다시 시도하세요')
  }

  async roomJoin(id: Identity, opts: { code?: unknown; target?: unknown }): Promise<RoomView> {
    const code = typeof opts.code === 'string' ? opts.code.trim().toUpperCase() : ''
    if (!/^[A-Z2-9]{5}$/.test(code)) throw new ApiError(404, '없는 방입니다. 코드를 확인하세요')
    const peek = await this.store.getRoom(code)
    if (!peek) throw new ApiError(404, '없는 방입니다. 코드를 확인하세요')
    const fresh = peek.room.seats.some((s) => s.uid === id.uid) ? null : await this.seat(id, peek.room.discipline, opts.target)
    const room = await this.mutate(code, (r) => {
      const mine = r.seats.find((s) => s.uid === id.uid)
      if (mine) {
        // 다시 들어온 것이다 (끊겼다가 복귀)
        mine.seenAt = this.now()
        return true
      }
      if (r.status === 'waiting' && r.seats.length < 2 && fresh) {
        r.seats.push({ ...fresh, seenAt: this.now() })
        r.seats[0].seenAt = this.now()
        const config: MatchConfig = {
          discipline: r.discipline,
          players: r.seats.map((s) => ({ name: s.name, target: s.target })),
          rules: DEFAULT_RULES,
          shotClock: r.shotClock,
        }
        const mid = `o${this.now().toString(36)}${Math.floor(this.random() * 1679616).toString(36)}`
        r.record = { ...newMatch(config, mid, this.now()), online: true }
        r.state = initialState(r.record)
        r.status = 'playing'
        r.deadline = r.shotClock > 0 ? this.now() + r.shotClock * 1000 : 0
        return true
      }
      return false // 자리가 찼으면 관전
    })
    return this.view(room, id.uid, -1, await this.overProfile(room, id))
  }

  /** 방의 지금 상태. have 는 내가 이미 가진 샷의 수, beat 는 접속을 알릴지 여부 */
  async roomState(id: Identity, codeRaw: unknown, have: number, beat: boolean): Promise<RoomView> {
    const code = typeof codeRaw === 'string' ? codeRaw.trim().toUpperCase() : ''
    if (!/^[A-Z2-9]{5}$/.test(code)) throw new ApiError(404, '없는 방입니다')
    const room = await this.mutate(code, (r) => {
      const mine = r.seats.find((s) => s.uid === id.uid)
      if (!mine || !beat || r.status === 'over') return false
      mine.seenAt = this.now()
      return true
    })
    return this.view(room, id.uid, have, await this.overProfile(room, id))
  }

  /** 클라이언트가 보낸 입력을 그 사람의 큐 한계 안으로 고정한다. 큐 사양은 서버가 정한다. */
  private sanitize(room: RoomDoc, seat: number, raw: unknown): ShotInput | null {
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
      theta: clearElevation(room.record.table, room.state.balls, cueBall, r.phi, want, side, top),
      side,
      top,
      speed: num(r.speed, 0.05, cue.maxSpeed, 0.05),
      accel: num(r.accel, -200, 200, 0),
      cue: cue.spec,
    }
  }

  async roomShot(id: Identity, codeRaw: unknown, raw: { input?: unknown; stroke?: unknown; have?: unknown; chalked?: unknown }): Promise<RoomView> {
    const code = typeof codeRaw === 'string' ? codeRaw.trim().toUpperCase() : ''
    const have = num(raw.have, 0, MAX_SHOTS, 0)
    const room = await this.mutate(code, (r) => {
      const seat = r.seats.findIndex((s) => s.uid === id.uid)
      if (seat < 0) throw new ApiError(403, '선수만 칠 수 있습니다')
      if (r.status !== 'playing' || !r.state) throw new ApiError(409, '진행 중인 경기가 아닙니다')
      if (r.state.turn !== seat) throw new ApiError(409, '내 차례가 아닙니다')
      const input = this.sanitize(r, seat, raw.input)
      if (!input) throw new ApiError(400, '샷 입력이 올바르지 않습니다')
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
      r.seats[seat].seenAt = this.now()
      this.apply(r, { player: seat, input, stroke, chalked: raw.chalked === true })
      return true
    })
    return this.view(room, id.uid, have, await this.overProfile(room, id))
  }

  /** 방에서 나간다. 경기 중인 선수가 나가면 기권이다. */
  async roomLeave(id: Identity, codeRaw: unknown): Promise<{ ok: boolean }> {
    const code = typeof codeRaw === 'string' ? codeRaw.trim().toUpperCase() : ''
    if (!/^[A-Z2-9]{5}$/.test(code)) return { ok: true }
    try {
      await this.mutate(code, (r) => {
        const seat = r.seats.findIndex((s) => s.uid === id.uid)
        if (seat < 0) return false
        if (r.status === 'waiting') {
          r.status = 'over'
          r.endedAt = this.now()
          return true
        }
        if (r.status === 'playing') {
          this.apply(r, { player: seat, forfeit: true })
          return true
        }
        return false
      })
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 404)) throw e
    }
    return { ok: true }
  }
}
