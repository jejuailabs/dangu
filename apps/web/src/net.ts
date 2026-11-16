/**
 * 온라인 대전의 서버 연결 (웹소켓).
 * 끊기면 방 코드를 기억해 두었다가 자동으로 다시 들어간다 (서버는 60초 기다려 준다).
 */
import type { MatchConfig, MatchRecord, ShotRecord } from '../../../packages/game/src'
import type { Profile } from '../../../packages/game/src/progress'

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
  | { t: 'shot'; index: number; shot: ShotRecord; hash: string; deadline: number; serverNow: number }
  | { t: 'aim'; phi: number; theta: number; side: number; top: number }
  | { t: 'presence'; seat: number; connected: boolean }
  | { t: 'over'; profile: Profile | null }
  | { t: 'error'; message: string }
  | { t: 'left' }

export class Net {
  private ws: WebSocket | null = null
  private queue: string[] = []
  private retry = 0
  private timer = 0
  /** 지금 들어가 있는 방. 다시 연결되면 이 방으로 돌아간다 */
  room = ''
  /** 일부러 끊은 경우 다시 연결하지 않는다 */
  private wanted = false

  constructor(
    private onMessage: (m: ServerMsg) => void,
    private onState: (connected: boolean) => void,
  ) {}

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN
  }

  connect(): void {
    this.wanted = true
    if (this.ws && this.ws.readyState <= WebSocket.OPEN) return
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    const ws = new WebSocket(`${proto}://${location.host}/ws`)
    this.ws = ws
    ws.onopen = () => {
      this.retry = 0
      this.onState(true)
      // 끊겼다가 돌아온 경우 방으로 복귀
      if (this.room) ws.send(JSON.stringify({ t: 'join', code: this.room }))
      for (const m of this.queue) ws.send(m)
      this.queue = []
    }
    ws.onmessage = (e) => {
      try {
        this.onMessage(JSON.parse(String(e.data)) as ServerMsg)
      } catch {
        /* 알 수 없는 메시지는 버린다 */
      }
    }
    ws.onclose = () => {
      if (this.ws !== ws) return
      this.ws = null
      this.onState(false)
      if (!this.wanted) return
      // 점점 길게 기다리며 다시 시도한다 (최대 5초)
      this.retry++
      window.clearTimeout(this.timer)
      this.timer = window.setTimeout(() => this.connect(), Math.min(500 * this.retry, 5000))
    }
  }

  send(msg: Record<string, unknown>): void {
    const text = JSON.stringify(msg)
    if (this.connected) this.ws!.send(text)
    else {
      // 조준 같은 일시적인 것은 쌓아 두지 않는다
      if (msg.t !== 'aim') this.queue.push(text)
      this.connect()
    }
  }

  /** 연결만 끊는다 (점검용). 방은 기억하고 있으므로 곧 다시 들어간다 */
  drop(): void {
    this.ws?.close()
  }

  close(): void {
    this.wanted = false
    this.room = ''
    this.queue = []
    window.clearTimeout(this.timer)
    this.ws?.close()
    this.ws = null
  }
}
