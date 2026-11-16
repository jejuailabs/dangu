/**
 * 컴퓨터 상대의 수지 단계 (PRD 05 §2).
 *
 * 각 단계의 skill 은 직접 정하지 않고, 자동 대국으로 잰 "skill -> 에버리지" 표에서
 * 그 수지의 목표 에버리지에 해당하는 값을 찾아 쓴다.
 *
 * 목표 에버리지 [초기값, 동호인 검토 필요]:
 * - 4구: 수지 / 200  (수지만큼의 점수를 약 20이닝에 친다고 본 값. 예: 수지 300 = 이닝당 1.5개)
 * - 3쿠션: 점수 / 35  (예: 20점 = 0.57, 30점 = 0.86)
 */
import type { Discipline } from '../../rules/src'

export type Tier = 'easy' | 'normal' | 'hard' | 'pro'

export interface AiLevel {
  id: string
  discipline: Discipline
  /** 화면에 보이는 이름 */
  label: string
  /** 컴퓨터의 목표 점수 */
  target: number
  /** 목표 에버리지 (이닝당 득점) */
  targetAvg: number
  skill: number
  /** 쓰는 큐 */
  cue: string
  tier: Tier
  /** 이 단계와 겨루려면 필요한 내 다마수 */
  unlock: number
}

/**
 * 자동 대국 측정값: [skill, 에버리지].
 * `CAL=4ball pnpm exec vitest run packages/ai/test/calibrate.test.ts` 로 다시 잴 수 있다.
 * 측정 조건: 골드 마스터 큐, 혼자 치기. 표본 수는 아래 주석 참고.
 */
export const MEASURED: Record<Discipline, [number, number][]> = {
  // skill 0~0.6 은 40이닝씩, 0.8 과 1 은 6이닝씩 (연속 득점이 길어 측정이 오래 걸린다). 높은 쪽은 오차가 크다
  '4ball': [
    [0, 0.1],
    [0.2, 0.1],
    [0.4, 0.6],
    [0.6, 2.4],
    [0.8, 6.3],
    [1, 8.3],
  ],
  // 30이닝씩 (skill 1 은 12이닝). 표본이 작아 ±30% 정도의 오차가 있다
  '3cushion': [
    [0, 0.02],
    [0.2, 0.067],
    [0.4, 0.2],
    [0.6, 0.233],
    [0.8, 1.567],
    [1, 2.667],
  ],
}

/** 측정 표에서 목표 에버리지에 해당하는 skill 을 찾는다 (구간 선형 보간). 표의 범위를 벗어나면 끝값. */
export function skillForAverage(table: [number, number][], avg: number): number {
  if (avg <= table[0][1]) return table[0][0]
  for (let i = 1; i < table.length; i++) {
    const [s0, a0] = table[i - 1]
    const [s1, a1] = table[i]
    if (avg <= a1) return a1 === a0 ? s1 : s0 + ((avg - a0) / (a1 - a0)) * (s1 - s0)
  }
  return table[table.length - 1][0]
}

/** 표에서 낼 수 있는 가장 높은 에버리지 */
export function maxAverage(d: Discipline): number {
  return Math.max(...MEASURED[d].map((r) => r[1]))
}

/** 프로 단계의 목표 에버리지 [초기값]. 3쿠션 세계 정상급은 2.0 안팎으로 알려져 있다 */
const PRO_AVG: Record<Discipline, number> = { '4ball': 7, '3cushion': 1.8 }

const PLAYER_TIERS = [50, 80, 100, 120, 150, 200, 250, 300, 400, 500, 700, 1000]
const CUE_BY_INDEX = ['house', 'house', 'oak', 'oak', 'maple', 'carbon', 'carbon', 'masse', 'masse', 'gold', 'gold', 'gold', 'gold']
const tierOf = (i: number, n: number): Tier => (i === n - 1 ? 'pro' : i < n * 0.3 ? 'easy' : i < n * 0.65 ? 'normal' : 'hard')
/** 내 단계보다 두 단계 위까지 겨룰 수 있다 */
const unlockFor = (i: number) => PLAYER_TIERS[Math.max(0, Math.min(i - 2, PLAYER_TIERS.length - 1))]

function build(): AiLevel[] {
  const out: AiLevel[] = []
  const four = [50, 80, 100, 120, 150, 200, 250, 300, 400, 500, 700, 1000]
  four.forEach((d, i) => {
    const avg = d / 200
    out.push({
      id: `4b-${d}`,
      discipline: '4ball',
      label: `${d}`,
      target: d / 10,
      targetAvg: avg,
      skill: skillForAverage(MEASURED['4ball'], avg),
      cue: CUE_BY_INDEX[i],
      tier: tierOf(i, four.length + 1),
      unlock: unlockFor(i),
    })
  })
  out.push({
    id: '4b-pro',
    discipline: '4ball',
    label: '프로',
    target: 150,
    targetAvg: Math.min(PRO_AVG['4ball'], maxAverage('4ball')),
    skill: skillForAverage(MEASURED['4ball'], PRO_AVG['4ball']),
    cue: 'gold',
    tier: 'pro',
    unlock: unlockFor(12),
  })

  const three = [10, 15, 18, 20, 23, 25, 28, 30, 35, 40]
  three.forEach((pts, i) => {
    const avg = pts / 35
    out.push({
      id: `3c-${pts}`,
      discipline: '3cushion',
      label: `${pts}점`,
      target: pts,
      targetAvg: avg,
      skill: skillForAverage(MEASURED['3cushion'], avg),
      cue: CUE_BY_INDEX[Math.min(i + 1, 12)],
      tier: tierOf(i, three.length + 1),
      unlock: unlockFor(i),
    })
  })
  out.push({
    id: '3c-pro',
    discipline: '3cushion',
    label: '프로',
    target: 40,
    targetAvg: Math.min(PRO_AVG['3cushion'], maxAverage('3cushion')),
    skill: skillForAverage(MEASURED['3cushion'], PRO_AVG['3cushion']),
    cue: 'gold',
    tier: 'pro',
    unlock: unlockFor(10),
  })
  return out
}

export const AI_LEVELS: AiLevel[] = build()

export function levelsFor(d: Discipline): AiLevel[] {
  return AI_LEVELS.filter((l) => l.discipline === d)
}

export function levelById(id: string): AiLevel | undefined {
  return AI_LEVELS.find((l) => l.id === id)
}
