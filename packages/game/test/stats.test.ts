import { describe, expect, it } from 'vitest'
import { DEFAULT_CUE, DEG, type ShotInput } from '../../physics/src'
import { DEFAULT_RULES } from '../../rules/src'
import { type MatchConfig, type MatchRecord, type ShotRecord, initialState, newMatch, play } from '../src'
import { careerStats, trendLine } from '../src/stats'

const shot = (deg: number, speed = 3): ShotRecord => ({
  player: 0,
  input: { ballId: 0, phi: deg * DEG, theta: 0, side: 0, top: 0.2, speed, cue: DEFAULT_CUE } as ShotInput,
})
const SCORING = shot(2, 4)
const MISS = shot(250, 0.5)

function playMatch(config: MatchConfig, id: string, at: number, seq: ShotRecord[]): MatchRecord {
  const rec = newMatch(config, id, at)
  let st = initialState(rec)
  for (const s of seq) {
    if (st.finished) break
    st = play(rec, st, s).state
  }
  return rec
}
const solo: MatchConfig = { discipline: '3cushion', players: [{ name: '나', target: 1 }], rules: DEFAULT_RULES, shotClock: 0 }
const versus: MatchConfig = {
  discipline: '3cushion',
  players: [
    { name: '나', target: 1 },
    { name: '상대', target: 1 },
  ],
  rules: DEFAULT_RULES,
  shotClock: 0,
}

describe('통산 기록', () => {
  it('경기가 없으면 모두 0 이다', () => {
    const s = careerStats([])
    expect(s.games).toBe(0)
    expect(s.average).toBe(0)
    expect(s.winRate).toBe(0)
    expect(trendLine(s.trend)).toEqual([])
  })

  it('득점과 이닝을 모아 에버리지를 낸다', () => {
    const a = playMatch(solo, 'a', 100, [SCORING]) // 1이닝 1점
    const b = playMatch(solo, 'b', 200, [MISS, MISS, SCORING]) // 실패 2번 뒤 득점: 3이닝 1점 (배치에 따라 다를 수 있다)
    const s = careerStats([b, a])
    expect(s.games).toBe(2)
    expect(s.points).toBeGreaterThanOrEqual(1)
    expect(s.average).toBeCloseTo(s.points / s.innings)
    expect(s.successRate).toBeCloseTo(s.madeShots / s.shots)
    // 추이는 오래된 경기부터
    expect(s.trend.map((t) => t.id)).toEqual(['a', 'b'])
    expect(s.trend[0].average).toBe(1)
    expect(s.trend[0].won).toBeNull()
  })

  it('상대가 있는 경기의 승률을 낸다', () => {
    const win = playMatch(versus, 'w', 1, [SCORING])
    const solo1 = playMatch(solo, 's', 2, [SCORING])
    const s = careerStats([win, solo1])
    expect(s.versusGames).toBe(1)
    expect(s.wins).toBe(1)
    expect(s.winRate).toBe(1)
    expect(s.trend.find((t) => t.id === 'w')!.opponent).toBe('상대')
  })

  it('종목별로 나눠 볼 수 있다', () => {
    const three = playMatch(solo, 'x', 1, [SCORING])
    const four = playMatch({ ...solo, discipline: '4ball' }, 'y', 2, [MISS])
    expect(careerStats([three, four], '3cushion').games).toBe(1)
    expect(careerStats([three, four], '4ball').games).toBe(1)
    expect(careerStats([three, four]).games).toBe(2)
  })

  it('추이 꺾은선은 0..1 범위이고 가장 높은 값이 1 이다', () => {
    const pts = trendLine([
      { id: 'a', createdAt: 1, discipline: '3cushion', average: 0.5, score: 5, innings: 10, highRun: 2, won: null, opponent: null },
      { id: 'b', createdAt: 2, discipline: '3cushion', average: 1.0, score: 10, innings: 10, highRun: 3, won: null, opponent: null },
      { id: 'c', createdAt: 3, discipline: '3cushion', average: 0.25, score: 5, innings: 20, highRun: 1, won: null, opponent: null },
    ])
    expect(pts.map((p) => p.x)).toEqual([0, 0.5, 1])
    expect(pts.map((p) => p.y)).toEqual([0.5, 1, 0.25])
  })
})
