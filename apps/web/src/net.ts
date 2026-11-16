/**
 * 온라인 대전의 서버 연결.
 *
 * 서버 함수는 연결을 계속 붙들고 있을 수 없어서 웹소켓 대신 "주기적으로 물어보기" 를 쓴다.
 * 당구는 번갈아 치는 경기라 1초 안팎의 지연은 문제가 되지 않는다.
 * - 0.9초마다 방의 새 샷을 물어본다 (공이 구르는 중에는 물어보지 않는다)
 * - 8초마다 "나 아직 있다" 를 함께 알린다. 60초 동안 알리지 않으면 서버가 기권으로 처리한다
 *
 * 화면 쪽은 메시지 형태로 받는다: room(방 상태), shot(확정된 샷), presence, over, check, error.
 */
import type { MatchConfig, MatchRecord, ShotRecord } from '../../../packages/game/src'
import type { Profile } from '../../../packages/game/src/progress'
import { type ApiFailure, type RoomView, api } from './api'

export type ServerMsg =
  | {
      t: 'room'
      code: string
      you: number
      status: 'waiting' | 'playing' | 'over'
      config: MatchConfig | null
      record: MatchRecord | null
      seats: { name: string; connected: boolean; cue: string }[]
      deadline: number
      serverNow: number
    }
  | { t: 'shot'; index: number; shot: ShotRecord; deadline: number; serverNow: number }
  | { t: 'presence'; seat: number; connected: boolean }
  | { t: 'over'; profile: Profile | null }
  /** 서버가 계산한 상태의 지문. total 개의 샷을 적용한 내 상태와 비교한다 */
  | { t: 'check'; total: number; sig: string }
  | { t: 'error'; message: string }

const POLL_MS = 900
const BEAT_MS = 8000

export class Net {
  /** 지금 들어가 있는 방 */
  room = ''
  /** 서버에서 받아 화면에 넘긴 샷의 수 */
  private have = 0
  private status: 'none' | 'waiting' | 'playing' | 'over' = 'none'
  private timer = 0
  private busy = false
  private lastBeat = 0
  private fails = 0
  private seats: boolean[] = []
  private overSent = false
  /** 공이 구르는 중처럼 새 샷을 받을 필요가 없을 때 true 를 돌려주는 함수 */
  paused: () => boolean = () => false

  constructor(
    private onMessage: (m: ServerMsg) => void,
    private onState: (connected: boolean) => void,
  ) {}

  private start(): void {
    window.clearInterval(this.timer)
    this.timer = window.setInterval(() => void this.poll(), POLL_MS)
  }

  private enter(v: RoomView): void {
    this.room = v.code
    this.status = v.status
    this.have = v.record ? v.record.shots.length : 0
    this.seats = v.seats.map((s) => s.connected)
    this.overSent = false
    this.fails = 0
    this.lastBeat = Date.now()
    this.onMessage({ t: 'room', code: v.code, you: v.you, status: v.status, config: v.config, record: v.record, seats: v.seats, deadline: v.deadline, serverNow: v.serverNow })
    this.after(v)
    this.start()
  }

  /** 서버 응답에서 새 샷, 접속 상태, 종료를 화면에 알린다. */
  private after(v: RoomView): void {
    v.shots.forEach((shot, i) => {
      const index = v.from + i
      if (index < this.have) return
      this.have = index + 1
      this.onMessage({ t: 'shot', index, shot, deadline: v.deadline, serverNow: v.serverNow })
    })
    v.seats.forEach((s, i) => {
      if (this.seats[i] !== undefined && this.seats[i] !== s.connected) this.onMessage({ t: 'presence', seat: i, connected: s.connected })
    })
    this.seats = v.seats.map((s) => s.connected)
    this.status = v.status
    if (v.status !== 'waiting') this.onMessage({ t: 'check', total: v.total, sig: v.sig })
    if (v.status === 'over' && !this.overSent && (v.profile || v.you < 0)) {
      this.overSent = true
      this.onMessage({ t: 'over', profile: v.profile })
    }
  }

  private fail(e: unknown): void {
    const err = e as ApiFailure
    this.onMessage({ t: 'error', message: err.message || '서버 오류' })
  }

  private async poll(): Promise<void> {
    if (!this.room || this.busy || this.paused()) return
    if (this.status === 'over' && this.overSent) return
    this.busy = true
    try {
      const beat = Date.now() - this.lastBeat > BEAT_MS
      // 상대를 기다리는 동안에는 전체 기록을 받는다 (경기가 시작되는 순간 필요하다)
      const waiting = this.status === 'waiting'
      const v = await api.roomState(this.room, waiting ? -1 : this.have, beat)
      if (beat) this.lastBeat = Date.now()
      if (this.fails >= 3) this.onState(true)
      this.fails = 0
      if (waiting && v.status !== 'waiting') this.enter(v)
      else this.after(v)
    } catch (e) {
      const err = e as ApiFailure
      if (err.status === 404) {
        this.fail(e)
        this.close()
      } else if (++this.fails === 3) this.onState(false)
    } finally {
      this.busy = false
    }
  }

  /** 방으로 들어가(또는 다시 들어가) 서버의 전체 기록을 받는다. */
  async join(code: string, target?: number): Promise<void> {
    try {
      this.enter(await api.roomJoin(code, target))
    } catch (e) {
      this.fail(e)
    }
  }

  async create(o: { discipline: string; target: number; shotClock: number }): Promise<void> {
    try {
      this.enter(await api.roomCreate(o))
    } catch (e) {
      this.fail(e)
    }
  }

  async shot(input: unknown, stroke: unknown): Promise<void> {
    if (!this.room) return
    this.busy = true
    try {
      this.after(await api.roomShot(this.room, input, stroke, this.have))
    } catch (e) {
      this.fail(e)
    } finally {
      this.busy = false
    }
  }

  /** 방에서 나간다 (경기 중이면 기권). */
  leave(): void {
    const code = this.room
    this.close()
    if (code) void api.roomLeave(code).catch(() => undefined)
  }

  close(): void {
    window.clearInterval(this.timer)
    this.room = ''
    this.status = 'none'
    this.have = 0
  }
}
