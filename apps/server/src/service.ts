/**
 * 계정과 기록 저장 (PRD 06 §9, 08 §8).
 *
 * 원칙: 서버는 클라이언트가 보낸 점수를 믿지 않는다.
 * 클라이언트는 경기 기록(초기 배치 + 샷 입력 목록)만 보내고, 서버가 같은 물리 코어로
 * 처음부터 다시 계산해 점수·보상을 정한다. 경험치와 코인은 저장하지 않고,
 * 검증된 경기들의 보상 합계에서 큐 구매액을 뺀 값으로 그때그때 계산한다.
 */
import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite'
import { CORE_VERSION } from '../../../packages/physics/src'
import { type MatchRecord, rebuild } from '../../../packages/game/src'
import { CUES, type Profile, cueStatus, levelOf, rewardFor } from '../../../packages/game/src/progress'

// Node 내장 SQLite. 번들러(Vite)가 아직 이 모듈 이름을 모르므로 require 로 직접 불러온다.
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as { DatabaseSync: typeof DatabaseSyncType }
type DatabaseSync = DatabaseSyncType

const SESSION_DAYS = 30
const MAX_RECORD_BYTES = 300_000
const MAX_SHOTS = 3000
const MAX_MATCHES_PER_USER = 500

export class ServiceError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message)
  }
}

export interface Account {
  id: number
  name: string
}

export interface MatchSummary {
  id: string
  createdAt: number
  score: number
  innings: number
  xp: number
  coins: number
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex')

function hashPassword(password: string, salt: string): string {
  return scryptSync(password, salt, 64).toString('hex')
}

export class Service {
  private db: DatabaseSync

  constructor(path = ':memory:') {
    this.db = new DatabaseSync(path)
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE COLLATE NOCASE,
        pass_hash TEXT NOT NULL,
        salt TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        owned TEXT NOT NULL DEFAULT '["house"]',
        equipped TEXT NOT NULL DEFAULT 'house'
      );
      CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL,
        expires INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS matches (
        user_id INTEGER NOT NULL,
        id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        record TEXT NOT NULL,
        score INTEGER NOT NULL,
        innings INTEGER NOT NULL,
        won INTEGER NOT NULL,
        xp INTEGER NOT NULL,
        coins INTEGER NOT NULL,
        PRIMARY KEY (user_id, id)
      );
    `)
  }

  close(): void {
    this.db.close()
  }

  // ── 계정 ───────────────────────────────────────────
  private checkCredentials(name: unknown, password: unknown): { name: string; password: string } {
    if (typeof name !== 'string' || typeof password !== 'string') throw new ServiceError(400, '아이디와 비밀번호를 입력하세요')
    const n = name.trim()
    if (!/^[\p{L}\p{N}_]{2,12}$/u.test(n)) throw new ServiceError(400, '아이디는 2~12자의 한글, 영문, 숫자, 밑줄만 쓸 수 있습니다')
    if (password.length < 6 || password.length > 100) throw new ServiceError(400, '비밀번호는 6자 이상이어야 합니다')
    return { name: n, password }
  }

  signup(name: unknown, password: unknown, now = Date.now()): { account: Account; token: string } {
    const c = this.checkCredentials(name, password)
    if (this.db.prepare('SELECT id FROM users WHERE name = ?').get(c.name)) throw new ServiceError(409, '이미 있는 아이디입니다')
    const salt = randomBytes(16).toString('hex')
    const r = this.db
      .prepare('INSERT INTO users (name, pass_hash, salt, created_at) VALUES (?, ?, ?, ?)')
      .run(c.name, hashPassword(c.password, salt), salt, now)
    const account = { id: Number(r.lastInsertRowid), name: c.name }
    return { account, token: this.newSession(account.id, now) }
  }

  login(name: unknown, password: unknown, now = Date.now()): { account: Account; token: string } {
    const fail = new ServiceError(401, '아이디 또는 비밀번호가 맞지 않습니다')
    if (typeof name !== 'string' || typeof password !== 'string') throw fail
    const row = this.db.prepare('SELECT id, name, pass_hash, salt FROM users WHERE name = ?').get(name.trim()) as
      | { id: number; name: string; pass_hash: string; salt: string }
      | undefined
    // 없는 아이디여도 같은 시간이 걸리게 해시는 한 번 계산한다
    const expected = Buffer.from(row?.pass_hash ?? '0'.repeat(128), 'hex')
    const given = Buffer.from(hashPassword(password.slice(0, 100), row?.salt ?? 'x'), 'hex')
    if (!row || expected.length !== given.length || !timingSafeEqual(expected, given)) throw fail
    return { account: { id: row.id, name: row.name }, token: this.newSession(row.id, now) }
  }

  private newSession(userId: number, now: number): string {
    const token = randomBytes(32).toString('hex')
    // 토큰 원문은 저장하지 않는다 (DB 가 새어도 세션을 훔칠 수 없게)
    this.db.prepare('INSERT INTO sessions (token_hash, user_id, expires) VALUES (?, ?, ?)').run(sha(token), userId, now + SESSION_DAYS * 86_400_000)
    this.db.prepare('DELETE FROM sessions WHERE expires < ?').run(now)
    return token
  }

  /** 세션 토큰의 주인. 없거나 만료되었으면 null */
  auth(token: unknown, now = Date.now()): Account | null {
    if (typeof token !== 'string' || token.length !== 64) return null
    const row = this.db
      .prepare('SELECT u.id, u.name FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires > ?')
      .get(sha(token), now) as { id: number; name: string } | undefined
    return row ?? null
  }

  logout(token: unknown): void {
    if (typeof token === 'string') this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha(token))
  }

  // ── 프로필 ─────────────────────────────────────────
  profile(userId: number): Profile {
    const u = this.db.prepare('SELECT owned, equipped FROM users WHERE id = ?').get(userId) as { owned: string; equipped: string } | undefined
    if (!u) throw new ServiceError(404, '없는 계정입니다')
    const t = this.db
      .prepare('SELECT COALESCE(SUM(xp), 0) AS xp, COALESCE(SUM(coins), 0) AS coins, COUNT(*) AS games, COALESCE(SUM(won), 0) AS wins FROM matches WHERE user_id = ?')
      .get(userId) as { xp: number; coins: number; games: number; wins: number }
    const owned = JSON.parse(u.owned) as string[]
    const spent = owned.reduce((sum, id) => sum + (CUES.find((c) => c.id === id)?.price ?? 0), 0)
    return { xp: t.xp, coins: Math.max(0, t.coins - spent), owned, equipped: u.equipped, games: t.games, wins: t.wins }
  }

  buyCue(userId: number, cueId: unknown): Profile {
    const p = this.profile(userId)
    const cue = CUES.find((c) => c.id === cueId)
    if (!cue) throw new ServiceError(400, '없는 큐입니다')
    const st = cueStatus(p, cue)
    if (st === 'locked') throw new ServiceError(403, `다마 ${cue.minDamasu} 부터 살 수 있습니다 (지금 ${levelOf(p.xp).damasu})`)
    if (st === 'poor') throw new ServiceError(403, '코인이 모자랍니다')
    if (st !== 'available') throw new ServiceError(409, '이미 가진 큐입니다')
    this.db.prepare('UPDATE users SET owned = ?, equipped = ? WHERE id = ?').run(JSON.stringify([...p.owned, cue.id]), cue.id, userId)
    return this.profile(userId)
  }

  equipCue(userId: number, cueId: unknown): Profile {
    const p = this.profile(userId)
    if (typeof cueId !== 'string' || !p.owned.includes(cueId)) throw new ServiceError(403, '가지고 있지 않은 큐입니다')
    this.db.prepare('UPDATE users SET equipped = ? WHERE id = ?').run(cueId, userId)
    return this.profile(userId)
  }

  // ── 경기 기록 ──────────────────────────────────────
  /**
   * 끝난 경기를 저장한다. 기록을 처음부터 다시 계산해 점수와 보상을 정한다.
   * 같은 경기를 다시 보내도 보상은 한 번만 준다.
   */
  addMatch(userId: number, raw: unknown): { summary: MatchSummary; profile: Profile; duplicate: boolean } {
    const text = JSON.stringify(raw)
    if (!raw || typeof raw !== 'object' || text.length > MAX_RECORD_BYTES) throw new ServiceError(400, '기록 형식이 올바르지 않습니다')
    const rec = raw as MatchRecord
    if (typeof rec.id !== 'string' || !/^[a-z0-9]{4,40}$/.test(rec.id)) throw new ServiceError(400, '기록 번호가 올바르지 않습니다')
    // 온라인 대전 기록은 서버가 직접 만든다. 클라이언트가 보낸 것은 받지 않는다
    if (rec.online) throw new ServiceError(400, '온라인 대전 기록은 서버에서만 저장합니다')
    if (rec.coreVersion !== CORE_VERSION) throw new ServiceError(409, `물리 코어 버전이 다릅니다 (서버 ${CORE_VERSION}, 기록 ${String(rec.coreVersion)})`)
    if (!Array.isArray(rec.shots) || rec.shots.length === 0 || rec.shots.length > MAX_SHOTS) throw new ServiceError(400, '샷 목록이 올바르지 않습니다')
    const players = rec.config?.players
    if (!Array.isArray(players) || players.length < 1 || players.length > 2) throw new ServiceError(400, '선수 정보가 올바르지 않습니다')
    for (const p of players) {
      if (typeof p?.target !== 'number' || !(p.target >= 1 && p.target <= 200)) throw new ServiceError(400, '목표 점수가 올바르지 않습니다')
    }

    const existing = this.db.prepare('SELECT id, created_at, score, innings, xp, coins FROM matches WHERE user_id = ? AND id = ?').get(userId, rec.id) as
      | { id: string; created_at: number; score: number; innings: number; xp: number; coins: number }
      | undefined
    if (existing) {
      const summary = { id: existing.id, createdAt: existing.created_at, score: existing.score, innings: existing.innings, xp: existing.xp, coins: existing.coins }
      return { summary, profile: this.profile(userId), duplicate: true }
    }
    const count = this.db.prepare('SELECT COUNT(*) AS n FROM matches WHERE user_id = ?').get(userId) as { n: number }
    if (count.n >= MAX_MATCHES_PER_USER) {
      // 가장 오래된 기록의 본문만 비운다 (보상 합계는 유지)
      this.db.prepare("UPDATE matches SET record = '' WHERE user_id = ? AND id = (SELECT id FROM matches WHERE user_id = ? AND record != '' ORDER BY created_at LIMIT 1)").run(userId, userId)
    }

    let state
    try {
      state = rebuild(rec).state
    } catch {
      throw new ServiceError(400, '기록을 다시 계산할 수 없습니다')
    }
    if (!state.finished) throw new ServiceError(400, '끝나지 않은 경기입니다')
    const me = state.players[0]
    const won = players.length > 1 && state.winner === 0
    const reward = rewardFor(me.score, true, won)
    const createdAt = typeof rec.createdAt === 'number' && Number.isFinite(rec.createdAt) ? Math.min(rec.createdAt, Date.now()) : Date.now()
    this.db
      .prepare('INSERT INTO matches (user_id, id, created_at, record, score, innings, won, xp, coins) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(userId, rec.id, createdAt, text, me.score, me.innings, won ? 1 : 0, reward.xp, reward.coins)
    return {
      summary: { id: rec.id, createdAt, score: me.score, innings: me.innings, xp: reward.xp, coins: reward.coins },
      profile: this.profile(userId),
      duplicate: false,
    }
  }

  /**
   * 서버가 직접 진행한 온라인 대전을 저장한다. seat 는 이 사람의 자리다.
   * 기록은 서버가 만든 것이므로 다시 검증하지 않는다.
   */
  addServerMatch(userId: number, record: MatchRecord, seat: number): Profile {
    const state = rebuild(record).state
    const me = state.players[seat]
    const won = state.winner === seat
    const reward = rewardFor(me.score, true, won)
    const text = JSON.stringify({ ...record, viewSeat: seat, online: true })
    this.db
      .prepare('INSERT OR IGNORE INTO matches (user_id, id, created_at, record, score, innings, won, xp, coins) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(userId, record.id, record.createdAt, text, me.score, me.innings, won ? 1 : 0, reward.xp, reward.coins)
    return this.profile(userId)
  }

  /** 저장된 경기 기록 (최근 것부터) */
  listMatches(userId: number, limit = 30): MatchRecord[] {
    const rows = this.db
      .prepare("SELECT record FROM matches WHERE user_id = ? AND record != '' ORDER BY created_at DESC LIMIT ?")
      .all(userId, Math.min(Math.max(limit, 1), 100)) as { record: string }[]
    return rows.map((r) => JSON.parse(r.record) as MatchRecord)
  }
}
