/**
 * 지난 경기 저장 (PRD 08 §8). 비로그인 상태에서는 브라우저에 둔다.
 * 저장 공간을 못 쓰는 환경(사생활 보호 모드 등)에서도 게임은 그대로 돌아가야 한다.
 */
import type { MatchRecord } from '../../../packages/game/src'

const KEY = 'dangu.matches.v1'
const MAX = 30

export function loadMatches(): MatchRecord[] {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return []
    const list = JSON.parse(raw)
    return Array.isArray(list) ? list : []
  } catch {
    return []
  }
}

/** 새 경기를 맨 앞에 넣는다. 오래된 것은 밀려난다. */
export function saveMatch(record: MatchRecord): void {
  try {
    const list = loadMatches().filter((m) => m.id !== record.id)
    list.unshift(record)
    localStorage.setItem(KEY, JSON.stringify(list.slice(0, MAX)))
  } catch {
    /* 저장하지 못해도 경기는 계속된다 */
  }
}

export function deleteMatch(id: string): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(loadMatches().filter((m) => m.id !== id)))
  } catch {
    /* 무시 */
  }
}

// ── 프로필 (다마수, 코인, 큐) ──────────────────────────
import { type Profile, newProfile, sanitizeProfile } from '../../../packages/game/src/progress'

const PROFILE_KEY = 'dangu.profile.v1'

export function loadProfile(): Profile {
  try {
    const raw = localStorage.getItem(PROFILE_KEY)
    return raw ? sanitizeProfile(JSON.parse(raw)) : newProfile()
  } catch {
    return newProfile()
  }
}

export function saveProfile(p: Profile): void {
  try {
    localStorage.setItem(PROFILE_KEY, JSON.stringify(p))
  } catch {
    /* 저장하지 못해도 이번 접속 동안은 유지된다 */
  }
}

// ── 진행 중인 경기 (이어하기) ──────────────────────────
const CURRENT_KEY = 'dangu.current.v1'

export interface SavedCurrent {
  kind: 'solo' | 'versus' | 'ai'
  record: MatchRecord
}

export function saveCurrent(c: SavedCurrent): void {
  try {
    localStorage.setItem(CURRENT_KEY, JSON.stringify(c))
  } catch {
    /* 저장하지 못해도 경기는 계속된다 */
  }
}

export function loadCurrent(): SavedCurrent | null {
  try {
    const raw = localStorage.getItem(CURRENT_KEY)
    if (!raw) return null
    const c = JSON.parse(raw) as SavedCurrent
    return c && c.record && Array.isArray(c.record.shots) && ['solo', 'versus', 'ai'].includes(c.kind) ? c : null
  } catch {
    return null
  }
}

export function clearCurrent(): void {
  try {
    localStorage.removeItem(CURRENT_KEY)
  } catch {
    /* 무시 */
  }
}
