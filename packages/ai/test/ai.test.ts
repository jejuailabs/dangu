import { describe, expect, it } from 'vitest'
import { simulate } from '../../physics/src'
import { cueById } from '../../game/src/progress'
import { DEFAULT_RULES, type Discipline, initialLayout, judge, tableFor } from '../../rules/src'
import { type AiContext, chooseShot, makeRng, paramsForSkill } from '../src'
import { AI_LEVELS, MEASURED, levelsFor, skillForAverage } from '../src/levels'

function ctx(d: Discipline, skill: number, seed = 7): AiContext {
  const cue = cueById('gold')
  return {
    table: tableFor(d),
    discipline: d,
    rules: DEFAULT_RULES,
    balls: initialLayout(d),
    cueId: 0,
    finishing: false,
    cue: cue.spec,
    maxSpeed: cue.maxSpeed,
    params: paramsForSkill(skill),
    seed,
  }
}

describe('수준별 동작 값', () => {
  it('수준이 높을수록 오차가 작고, 더 많이 찾아보고, 실수를 덜 한다', () => {
    let prev = paramsForSkill(0)
    for (const s of [0.2, 0.4, 0.6, 0.8, 1]) {
      const p = paramsForSkill(s)
      expect(p.aimSigma).toBeLessThan(prev.aimSigma)
      expect(p.speedSigma).toBeLessThan(prev.speedSigma)
      expect(p.tipSigma).toBeLessThan(prev.tipSigma)
      expect(p.thickSamples).toBeGreaterThanOrEqual(prev.thickSamples)
      expect(p.blunder).toBeLessThanOrEqual(prev.blunder)
      expect(p.maxSpin).toBeGreaterThanOrEqual(prev.maxSpin)
      prev = p
    }
  })
  it('가장 낮은 수준은 회전을 쓰지 않고 직접 맞히는 샷만 친다', () => {
    const p = paramsForSkill(0)
    expect(p.maxSpin).toBe(0)
    expect(p.maxCushions4).toBe(0)
    expect(p.positionWeight).toBe(0)
  })
  it('난수는 시드가 같으면 같은 값을 낸다', () => {
    const a = makeRng(5)
    const b = makeRng(5)
    for (let i = 0; i < 10; i++) expect(a.gauss()).toBe(b.gauss())
  })
})

describe('샷 고르기', () => {
  it('같은 상황과 시드면 같은 샷을 고른다', () => {
    const a = chooseShot(ctx('4ball', 0.5))
    const b = chooseShot(ctx('4ball', 0.5))
    expect(a.executed).toEqual(b.executed)
  })

  it('실제로 친 샷은 치려던 샷에서 조금 벗어나고, 낮은 수준일수록 많이 벗어난다', () => {
    const spread = (skill: number) => {
      let sum = 0
      for (let seed = 1; seed <= 6; seed++) {
        const d = chooseShot(ctx('4ball', skill, seed))
        sum += Math.abs(d.executed.phi - d.intended.phi)
      }
      return sum
    }
    const low = spread(0)
    const high = spread(1)
    expect(low).toBeGreaterThan(0)
    expect(low).toBeGreaterThan(high * 3)
  })

  it('높은 수준은 4구 초구에서 득점하는 샷을 찾아 실제로 넣는다', () => {
    let made = 0
    for (let seed = 1; seed <= 4; seed++) {
      const c = ctx('4ball', 1, seed)
      const d = chooseShot(c)
      expect(d.found).toBeGreaterThan(0)
      expect(d.pSuccess).toBeGreaterThan(0.5)
      if (judge('4ball', simulate(c.table, c.balls, d.executed), 0).scored) made++
    }
    expect(made).toBeGreaterThanOrEqual(3)
  })

  it('컴퓨터의 샷도 큐의 한계를 지킨다', () => {
    const house = cueById('house')
    const c = { ...ctx('4ball', 1), cue: house.spec, maxSpeed: house.maxSpeed }
    const d = chooseShot(c)
    expect(d.executed.speed).toBeLessThanOrEqual(house.maxSpeed)
    expect(d.executed.cue).toBe(house.spec)
    // 치려던 당점은 미스큐 한계 안이다
    expect(Math.hypot(d.intended.side, d.intended.top)).toBeLessThanOrEqual(house.spec.miscueLimit)
  })

  it('득점할 샷을 못 찾으면 적어도 빨간 공을 향해 친다 (4구에서 헛치지 않게)', () => {
    // 훑어볼 후보가 거의 없는 가장 낮은 수준
    const c = ctx('4ball', 0, 3)
    const d = chooseShot(c)
    const res = simulate(c.table, c.balls, d.intended)
    const j = judge('4ball', res, 0)
    expect(j.hits.length).toBeGreaterThan(0)
  })
})

describe('수지 단계표', () => {
  it('측정 표에서 목표 에버리지에 맞는 skill 을 찾는다', () => {
    const table: [number, number][] = [
      [0, 0.1],
      [0.5, 1],
      [1, 5],
    ]
    expect(skillForAverage(table, 0.05)).toBe(0)
    expect(skillForAverage(table, 0.55)).toBeCloseTo(0.25)
    expect(skillForAverage(table, 3)).toBeCloseTo(0.75)
    expect(skillForAverage(table, 99)).toBe(1)
  })

  it('측정 표는 skill 순으로 정렬되어 있고 에버리지가 줄어들지 않는다', () => {
    for (const d of ['4ball', '3cushion'] as const) {
      const t = MEASURED[d]
      for (let i = 1; i < t.length; i++) {
        expect(t[i][0]).toBeGreaterThan(t[i - 1][0])
        expect(t[i][1]).toBeGreaterThanOrEqual(t[i - 1][1])
      }
    }
  })

  it('4구 13단계, 3쿠션 11단계가 있고 위로 갈수록 skill 이 줄지 않는다', () => {
    expect(levelsFor('4ball').length).toBe(13)
    expect(levelsFor('3cushion').length).toBe(11)
    for (const d of ['4ball', '3cushion'] as const) {
      const list = levelsFor(d)
      for (let i = 1; i < list.length; i++) {
        expect(list[i].skill).toBeGreaterThanOrEqual(list[i - 1].skill)
        expect(list[i].unlock).toBeGreaterThanOrEqual(list[i - 1].unlock)
      }
      expect(list[list.length - 1].label).toBe('프로')
      expect(list[list.length - 1].skill).toBeGreaterThan(0.5)
      expect(list[list.length - 1].skill).toBeLessThanOrEqual(1)
    }
  })

  it('처음 시작한 사람(다마 50)도 겨룰 상대가 세 단계 있다', () => {
    for (const d of ['4ball', '3cushion'] as const) {
      expect(levelsFor(d).filter((l) => l.unlock <= 50).length).toBe(3)
    }
    expect(new Set(AI_LEVELS.map((l) => l.id)).size).toBe(AI_LEVELS.length)
  })
})
