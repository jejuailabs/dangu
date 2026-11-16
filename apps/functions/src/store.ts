/**
 * 저장소. 실제로는 Firestore, 테스트와 자동 점검에서는 메모리.
 *
 * 이 Firebase 프로젝트는 다른 서비스와 함께 쓰므로, 모든 문서를 dangu_ 로 시작하는
 * 컬렉션에만 둔다. 기존 컬렉션(users, daily 등)은 읽지도 쓰지도 않는다.
 */
import type { MatchRecord, MatchState } from '../../../packages/game/src'
import type { Discipline } from '../../../packages/rules/src'
import { type Firestore, fsInt, fsRead, fsString } from './google'

export interface UserDoc {
  name: string
  owned: string[]
  equipped: string
  /** 검증된 경기들에서 얻은 누적 경험치·코인 (쓴 코인은 빼지 않은 값) */
  xp: number
  earned: number
  games: number
  wins: number
}

export interface MatchDoc {
  id: string
  createdAt: number
  /** 경기 기록 JSON */
  record: string
  score: number
  innings: number
  won: boolean
  xp: number
  coins: number
}

export interface RoomSeat {
  uid: string
  name: string
  target: number
  cueId: string
  /** 마지막으로 접속을 알린 시각 (ms) */
  seenAt: number
}

export interface RoomDoc {
  code: string
  discipline: Discipline
  shotClock: number
  status: 'waiting' | 'playing' | 'over'
  seats: RoomSeat[]
  record: MatchRecord | null
  state: MatchState | null
  deadline: number
  createdAt: number
  endedAt: number
}

export interface Store {
  getUser(uid: string): Promise<UserDoc | null>
  /** 처음 온 사람이면 기본값으로 만든다 */
  ensureUser(uid: string, name: string): Promise<UserDoc>
  setCues(uid: string, owned: string[], equipped: string): Promise<void>
  /** 경기를 저장하고 누적값을 올린다. 같은 경기가 이미 있으면 아무것도 하지 않고 false */
  addMatch(uid: string, m: MatchDoc): Promise<boolean>
  listMatches(uid: string, limit: number): Promise<string[]>
  getRoom(code: string): Promise<{ room: RoomDoc; version: string } | null>
  createRoom(room: RoomDoc): Promise<boolean>
  /** 읽은 뒤로 바뀌지 않았을 때만 저장한다. 그 사이 다른 요청이 고쳤으면 false */
  saveRoom(room: RoomDoc, version: string): Promise<boolean>
}

const newUser = (name: string): UserDoc => ({ name, owned: ['house'], equipped: 'house', xp: 0, earned: 0, games: 0, wins: 0 })

// ── 메모리 (테스트, 자동 점검) ────────────────────────
export class MemoryStore implements Store {
  private users = new Map<string, UserDoc>()
  private matches = new Map<string, MatchDoc[]>()
  private rooms = new Map<string, { json: string; version: number }>()

  async getUser(uid: string): Promise<UserDoc | null> {
    const u = this.users.get(uid)
    return u ? structuredClone(u) : null
  }
  async ensureUser(uid: string, name: string): Promise<UserDoc> {
    if (!this.users.has(uid)) this.users.set(uid, newUser(name))
    return structuredClone(this.users.get(uid)!)
  }
  async setCues(uid: string, owned: string[], equipped: string): Promise<void> {
    const u = this.users.get(uid)
    if (u) Object.assign(u, { owned: [...owned], equipped })
  }
  async addMatch(uid: string, m: MatchDoc): Promise<boolean> {
    const list = this.matches.get(uid) ?? []
    if (list.some((x) => x.id === m.id)) return false
    list.push({ ...m })
    this.matches.set(uid, list)
    const u = this.users.get(uid)
    if (u) {
      u.xp += m.xp
      u.earned += m.coins
      u.games += 1
      u.wins += m.won ? 1 : 0
    }
    return true
  }
  async listMatches(uid: string, limit: number): Promise<string[]> {
    return [...(this.matches.get(uid) ?? [])]
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit)
      .map((m) => m.record)
  }
  async getRoom(code: string): Promise<{ room: RoomDoc; version: string } | null> {
    const r = this.rooms.get(code)
    return r ? { room: JSON.parse(r.json) as RoomDoc, version: String(r.version) } : null
  }
  async createRoom(room: RoomDoc): Promise<boolean> {
    if (this.rooms.has(room.code)) return false
    this.rooms.set(room.code, { json: JSON.stringify(room), version: 1 })
    return true
  }
  async saveRoom(room: RoomDoc, version: string): Promise<boolean> {
    const cur = this.rooms.get(room.code)
    if (!cur || String(cur.version) !== version) return false
    this.rooms.set(room.code, { json: JSON.stringify(room), version: cur.version + 1 })
    return true
  }
}

// ── Firestore ────────────────────────────────────────
const USERS = 'dangu_users'
const ROOMS = 'dangu_rooms'

export class FirestoreStore implements Store {
  constructor(private fs: Firestore) {}

  async getUser(uid: string): Promise<UserDoc | null> {
    const d = await this.fs.get(`${USERS}/${uid}`)
    if (!d) return null
    const f = d.fields
    let owned: string[] = ['house']
    try {
      owned = JSON.parse(String(fsRead(f, 'owned') ?? '["house"]')) as string[]
    } catch {
      /* 기본값 */
    }
    return {
      name: String(fsRead(f, 'name') ?? '플레이어'),
      owned,
      equipped: String(fsRead(f, 'equipped') ?? 'house'),
      xp: Number(fsRead(f, 'xp') ?? 0),
      earned: Number(fsRead(f, 'earned') ?? 0),
      games: Number(fsRead(f, 'games') ?? 0),
      wins: Number(fsRead(f, 'wins') ?? 0),
    }
  }

  async ensureUser(uid: string, name: string): Promise<UserDoc> {
    const cur = await this.getUser(uid)
    if (cur) return cur
    const u = newUser(name)
    await this.fs.create(`${USERS}/${uid}`, {
      name: fsString(u.name),
      owned: fsString(JSON.stringify(u.owned)),
      equipped: fsString(u.equipped),
      xp: fsInt(0),
      earned: fsInt(0),
      games: fsInt(0),
      wins: fsInt(0),
    })
    // 동시에 두 요청이 만들었더라도 저장된 것을 다시 읽어 돌려준다
    return (await this.getUser(uid)) ?? u
  }

  async setCues(uid: string, owned: string[], equipped: string): Promise<void> {
    await this.fs.merge(`${USERS}/${uid}`, { owned: fsString(JSON.stringify(owned)), equipped: fsString(equipped) })
  }

  async addMatch(uid: string, m: MatchDoc): Promise<boolean> {
    // 경기 문서 만들기와 누적값 올리기를 한 묶음으로 한다. 경기가 이미 있으면 묶음 전체가 취소된다.
    const r = await this.fs.commit([
      {
        update: {
          name: this.fs.docName(`${USERS}/${uid}/matches/${m.id}`),
          fields: {
            createdAt: fsInt(m.createdAt),
            record: fsString(m.record),
            score: fsInt(m.score),
            innings: fsInt(m.innings),
            won: { booleanValue: m.won },
            xp: fsInt(m.xp),
            coins: fsInt(m.coins),
          },
        },
        currentDocument: { exists: false },
      },
      {
        update: { name: this.fs.docName(`${USERS}/${uid}`), fields: {} },
        updateMask: { fieldPaths: [] },
        updateTransforms: [
          { fieldPath: 'xp', increment: fsInt(m.xp) },
          { fieldPath: 'earned', increment: fsInt(m.coins) },
          { fieldPath: 'games', increment: fsInt(1) },
          { fieldPath: 'wins', increment: fsInt(m.won ? 1 : 0) },
        ],
      },
    ])
    return r === 'ok'
  }

  async listMatches(uid: string, limit: number): Promise<string[]> {
    const docs = await this.fs.query(`${USERS}/${uid}`, 'matches', 'createdAt', limit)
    return docs.map((d) => String(fsRead(d.fields, 'record') ?? '')).filter((s) => s.length > 0)
  }

  async getRoom(code: string): Promise<{ room: RoomDoc; version: string } | null> {
    const d = await this.fs.get(`${ROOMS}/${code}`)
    if (!d) return null
    try {
      return { room: JSON.parse(String(fsRead(d.fields, 'json'))) as RoomDoc, version: d.updateTime }
    } catch {
      return null
    }
  }

  async createRoom(room: RoomDoc): Promise<boolean> {
    return this.fs.create(`${ROOMS}/${room.code}`, { json: fsString(JSON.stringify(room)), createdAt: fsInt(room.createdAt) })
  }

  async saveRoom(room: RoomDoc, version: string): Promise<boolean> {
    return this.fs.replaceIfUnchanged(`${ROOMS}/${room.code}`, { json: fsString(JSON.stringify(room)), createdAt: fsInt(room.createdAt) }, version)
  }
}
