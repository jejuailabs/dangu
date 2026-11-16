/**
 * 성장: 다마수(수지), 코인, 큐.
 *
 * 경기에서 득점하면 경험치와 코인을 얻는다. 경험치가 쌓이면 다마수가 오르고,
 * 다마수가 오르면 더 좋은 큐를 코인으로 살 수 있다.
 * 큐는 현금이 아니라 게임에서 번 코인으로만 산다.
 *
 * 큐가 바꾸는 것:
 * - 힘: 팁 반발(같은 스트로크로 공이 더 빠르다)과 낼 수 있는 최대 큐 속도
 * - 회전 범위: 미스큐 한계. 넓을수록 당점을 더 바깥에 줄 수 있어 회전(히네리)을 더 먹일 수 있다
 * - 고각: 큐를 세울 수 있는 한계. 세워치기와 마세는 상급 큐부터 가능하다
 * - 스쿼트: 큐 끝 질량. 작을수록 회전을 줄 때 공이 덜 밀린다
 *
 * 모든 수치는 [초기값] 이다. 실제 팁의 미스큐 한계는 약 0.5R 로 알려져 있으므로,
 * 기본 큐는 그보다 좁게(관리가 덜 된 팁), 최상급 큐는 약간 넓게 잡았다.
 */
import { DEFAULT_CUE, type CueSpec } from '../../physics/src'

export interface CueItem {
  id: string
  name: string
  blurb: string
  /** 살 수 있는 최소 다마수 */
  minDamasu: number
  price: number
  spec: CueSpec
  /** 낼 수 있는 최대 큐 속도 (m/s) */
  maxSpeed: number
  /** 세울 수 있는 최대 고각 (도) */
  maxElevation: number
  /** 화면에 그릴 때의 색 (손잡이, 포인트) */
  colors: { butt: number; accent: number }
}

const cue = (over: Partial<CueSpec>): CueSpec => ({ ...DEFAULT_CUE, ...over })

export const CUES: CueItem[] = [
  {
    id: 'house',
    name: '하우스 큐',
    blurb: '당구장에 꽂혀 있는 큐. 팁이 닳아 회전을 많이 주면 미끄러진다.',
    minDamasu: 0,
    price: 0,
    spec: cue({ miscueLimit: 0.38, tipRestitution: 0.68, endMass: 0.013, mass: 0.5 }),
    maxSpeed: 5.0,
    maxElevation: 20,
    colors: { butt: 0x3a2618, accent: 0x7a6a55 },
  },
  {
    id: 'oak',
    name: '오크',
    blurb: '첫 개인 큐. 팁이 살아 있어 회전이 조금 더 먹는다.',
    minDamasu: 80,
    price: 40,
    spec: cue({ miscueLimit: 0.42, tipRestitution: 0.71, endMass: 0.012, mass: 0.51 }),
    maxSpeed: 5.6,
    maxElevation: 25,
    colors: { butt: 0x5a3a1c, accent: 0xc9a66b },
  },
  {
    id: 'maple',
    name: '메이플',
    blurb: '단단한 단풍나무 상대. 힘 전달이 좋아진다.',
    minDamasu: 120,
    price: 120,
    spec: cue({ miscueLimit: 0.46, tipRestitution: 0.74, endMass: 0.011, mass: 0.52 }),
    maxSpeed: 6.3,
    maxElevation: 35,
    colors: { butt: 0x1f3a5a, accent: 0xe6e0d0 },
  },
  {
    id: 'carbon',
    name: '카본',
    blurb: '끝이 가벼워 공이 덜 밀린다. 큐를 세워 찍어칠 수 있다.',
    minDamasu: 200,
    price: 300,
    spec: cue({ miscueLimit: 0.5, tipRestitution: 0.76, endMass: 0.008, mass: 0.52 }),
    maxSpeed: 7.0,
    maxElevation: 60,
    colors: { butt: 0x16181c, accent: 0x4fb3ff },
  },
  {
    id: 'masse',
    name: '블랙 다이아',
    blurb: '마세 큐. 수직에 가깝게 세워 공을 크게 휘게 한다.',
    minDamasu: 300,
    price: 700,
    spec: cue({ miscueLimit: 0.53, tipRestitution: 0.78, endMass: 0.008, mass: 0.56 }),
    maxSpeed: 7.6,
    maxElevation: 85,
    colors: { butt: 0x0c0c10, accent: 0xb9c2ff },
  },
  {
    id: 'gold',
    name: '골드 마스터',
    blurb: '최상급. 힘, 회전, 마세 모두 한계까지.',
    minDamasu: 500,
    price: 1500,
    spec: cue({ miscueLimit: 0.56, tipRestitution: 0.8, endMass: 0.006, mass: 0.54 }),
    maxSpeed: 8.2,
    maxElevation: 85,
    colors: { butt: 0x2a1d06, accent: 0xe8b84a },
  },
]

/** 다마수 단계와, 그 단계에 오르는 데 필요한 누적 경험치 */
export const LEVELS: { damasu: number; xp: number }[] = [
  { damasu: 50, xp: 0 },
  { damasu: 80, xp: 15 },
  { damasu: 100, xp: 40 },
  { damasu: 120, xp: 80 },
  { damasu: 150, xp: 140 },
  { damasu: 200, xp: 230 },
  { damasu: 250, xp: 350 },
  { damasu: 300, xp: 520 },
  { damasu: 400, xp: 760 },
  { damasu: 500, xp: 1100 },
  { damasu: 700, xp: 1600 },
  { damasu: 1000, xp: 2300 },
]

export interface Profile {
  xp: number
  coins: number
  owned: string[]
  equipped: string
  games: number
  wins: number
}

export function newProfile(): Profile {
  return { xp: 0, coins: 0, owned: ['house'], equipped: 'house', games: 0, wins: 0 }
}

/** 저장된 값이 깨졌거나 예전 형식이어도 쓸 수 있는 프로필로 고친다. */
export function sanitizeProfile(raw: unknown): Profile {
  const base = newProfile()
  if (!raw || typeof raw !== 'object') return base
  const r = raw as Partial<Profile>
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0)
  const owned = Array.isArray(r.owned) ? r.owned.filter((id) => CUES.some((c) => c.id === id)) : []
  if (!owned.includes('house')) owned.unshift('house')
  const equipped = typeof r.equipped === 'string' && owned.includes(r.equipped) ? r.equipped : 'house'
  return { xp: num(r.xp), coins: num(r.coins), owned, equipped, games: num(r.games), wins: num(r.wins) }
}

export function cueById(id: string): CueItem {
  return CUES.find((c) => c.id === id) ?? CUES[0]
}

export function equippedCue(p: Profile): CueItem {
  return cueById(p.equipped)
}

export interface LevelInfo {
  damasu: number
  /** 다음 단계. 최고 단계면 null */
  next: number | null
  /** 현재 단계 안에서의 진행도 0..1 */
  progress: number
  /** 다음 단계까지 남은 경험치 */
  remaining: number
}

export function levelOf(xp: number): LevelInfo {
  let i = 0
  while (i + 1 < LEVELS.length && xp >= LEVELS[i + 1].xp) i++
  const cur = LEVELS[i]
  const nxt = LEVELS[i + 1]
  if (!nxt) return { damasu: cur.damasu, next: null, progress: 1, remaining: 0 }
  return {
    damasu: cur.damasu,
    next: nxt.damasu,
    progress: (xp - cur.xp) / (nxt.xp - cur.xp),
    remaining: nxt.xp - xp,
  }
}

export type CueStatus = 'equipped' | 'owned' | 'available' | 'poor' | 'locked'

export function cueStatus(p: Profile, c: CueItem): CueStatus {
  if (p.equipped === c.id) return 'equipped'
  if (p.owned.includes(c.id)) return 'owned'
  if (levelOf(p.xp).damasu < c.minDamasu) return 'locked'
  return p.coins >= c.price ? 'available' : 'poor'
}

/** 큐를 산다. 살 수 없으면 프로필을 그대로 돌려준다. 산 큐는 바로 든다. */
export function buyCue(p: Profile, id: string): Profile {
  const c = CUES.find((x) => x.id === id)
  if (!c || cueStatus(p, c) !== 'available') return p
  return { ...p, coins: p.coins - c.price, owned: [...p.owned, c.id], equipped: c.id }
}

export function equipCue(p: Profile, id: string): Profile {
  return p.owned.includes(id) ? { ...p, equipped: id } : p
}

export interface Reward {
  xp: number
  coins: number
  /** 승급했으면 [이전 다마수, 새 다마수] */
  levelUp: [number, number] | null
  /** 이번 승급으로 새로 살 수 있게 된 큐 */
  unlocked: CueItem[]
}

/**
 * 경기 결과의 보상. 득점 1점당 경험치 1, 코인 2. 완주 보너스 코인 10, 대전 승리 보너스 20.
 */
export function rewardFor(scored: number, finished: boolean, wonVersus: boolean): { xp: number; coins: number } {
  const s = Math.max(0, Math.floor(scored))
  return { xp: s, coins: s * 2 + (finished ? 10 : 0) + (wonVersus ? 20 : 0) }
}

export function applyReward(p: Profile, scored: number, finished: boolean, wonVersus: boolean): { profile: Profile; reward: Reward } {
  const r = rewardFor(scored, finished, wonVersus)
  const before = levelOf(p.xp).damasu
  const profile: Profile = {
    ...p,
    xp: p.xp + r.xp,
    coins: p.coins + r.coins,
    games: p.games + 1,
    wins: p.wins + (wonVersus ? 1 : 0),
  }
  const after = levelOf(profile.xp).damasu
  return {
    profile,
    reward: {
      ...r,
      levelUp: after > before ? [before, after] : null,
      unlocked: CUES.filter((c) => c.minDamasu > before && c.minDamasu <= after),
    },
  }
}

/** 큐 능력을 0..1 로 나타낸다 (상점의 막대 표시용) */
export function cueRatings(c: CueItem): { power: number; spin: number; elevation: number; control: number } {
  const lerp = (v: number, lo: number, hi: number) => Math.min(Math.max((v - lo) / (hi - lo), 0), 1)
  return {
    power: lerp(c.maxSpeed, 4.5, 8.2),
    spin: lerp(c.spec.miscueLimit, 0.34, 0.56),
    elevation: lerp(c.maxElevation, 10, 85),
    control: lerp(0.014 - c.spec.endMass, 0, 0.008),
  }
}
