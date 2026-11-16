import { describe, expect, it } from 'vitest'
import type { EventType, ShotResult, SimEvent } from '../../physics/src'
import {
  DEFAULT_RULES,
  RED_A,
  RED_B,
  WHITE,
  YELLOW,
  applyJudgement,
  average,
  initialLayout,
  judge,
  newScore,
  respot,
  tableFor,
} from '../src'

/** 판정에 필요한 이벤트만 가진 가짜 결과를 만든다. 예: 'c c 2 c 1' = 쿠션 쿠션 공2 쿠션 공1 */
function fake(script: string, cue = WHITE, miscue = false): ShotResult {
  const events: SimEvent[] = [{ t: 0, type: 'strike', ids: [cue], miscue, balls: [] }]
  let t = 0
  for (const tok of script.split(' ').filter(Boolean)) {
    t += 0.1
    let type: EventType
    let ids: number[]
    if (tok === 'c') {
      type = 'cushion'
      ids = [cue]
    } else if (tok === 'out') {
      type = 'out'
      ids = [cue]
    } else if (tok.startsWith('x')) {
      // 다른 공의 쿠션 접촉 (수구와 무관)
      type = 'cushion'
      ids = [Number(tok.slice(1))]
    } else {
      type = 'ball-ball'
      ids = [cue, Number(tok)]
    }
    events.push({ t, type, ids, balls: [] })
  }
  return { events, final: [], duration: t, hash: '', truncated: false }
}

describe('3쿠션 판정', () => {
  const j = (s: string, miscue = false) => judge('3cushion', fake(s, WHITE, miscue), WHITE)

  it('공 - 쿠션 3개 - 공 은 득점', () => {
    const r = j('2 c c c 1')
    expect(r.scored).toBe(true)
    expect(r.cushionsBeforeSecond).toBe(3)
  })
  it('쿠션 3개를 먼저 맞히고 두 공을 맞혀도 득점 (빈쿠션)', () => {
    expect(j('c c c 1 2').scored).toBe(true)
  })
  it('쿠션이 두 번째 공 전에 2개뿐이면 실패, 이후 쿠션은 세지 않는다', () => {
    const r = j('2 c c 1 c c')
    expect(r.scored).toBe(false)
    expect(r.cushionsBeforeSecond).toBe(2)
    expect(r.cushions).toBe(4)
  })
  it('같은 공을 두 번 맞힌 것은 두 번째 목적구가 아니다', () => {
    const r = j('2 c c c 2')
    expect(r.scored).toBe(false)
    expect(r.hits).toEqual([2])
  })
  it('다른 공의 쿠션 접촉은 세지 않는다', () => {
    expect(j('2 x2 x2 x2 c 1').scored).toBe(false)
  })
  it('공을 못 맞히면 실패, 장외와 미스큐는 파울', () => {
    expect(j('c c c').scored).toBe(false)
    expect(j('c c c').foul).toBe(false)
    expect(j('2 c out').foul).toBe(true)
    expect(j('2 c c c 1', true).foul).toBe(true)
  })
})

describe('4구 판정', () => {
  const j = (s: string, finish = false) => judge('4ball', fake(s), WHITE, DEFAULT_RULES, finish)

  it('빨간 공 두 개를 맞히면 득점', () => {
    expect(j(`${RED_A} ${RED_B}`).scored).toBe(true)
    expect(j(`${RED_B} c ${RED_A}`).points).toBe(1)
  })
  it('빨간 공 하나만 맞히면 실패 (파울 아님)', () => {
    const r = j(`${RED_A} c c`)
    expect(r.scored).toBe(false)
    expect(r.foul).toBe(false)
    expect(r.points).toBe(0)
  })
  it('상대 수구를 맞히면 득점 조건을 채워도 파울과 감점', () => {
    const r = j(`${RED_A} ${RED_B} ${YELLOW}`)
    expect(r.foul).toBe(true)
    expect(r.scored).toBe(false)
    expect(r.points).toBe(-1)
  })
  it('아무 공도 못 맞히면 파울', () => {
    expect(j('c c').foul).toBe(true)
  })
  it('마무리 단계에서는 3쿠션 조건이 필요하다', () => {
    expect(j(`${RED_A} ${RED_B}`, true).scored).toBe(false)
    expect(j(`${RED_A} c c c ${RED_B}`, true).scored).toBe(true)
  })
  it('감점 없는 규칙을 고를 수 있다', () => {
    const r = judge('4ball', fake('c'), WHITE, { ...DEFAULT_RULES, foulPenalty4Ball: false })
    expect(r.foul).toBe(true)
    expect(r.points).toBe(0)
  })
})

describe('점수 기록', () => {
  const hit = { scored: true, foul: false, points: 1, hits: [], cushions: 3, cushionsBeforeSecond: 3, reason: '' }
  const miss = { ...hit, scored: false, points: 0 }
  const foul = { ...miss, foul: true, points: -1 }

  it('득점은 런을 늘리고, 실패는 이닝을 넘긴다', () => {
    let s = newScore(10)
    s = applyJudgement(s, hit)
    s = applyJudgement(s, hit)
    expect([s.score, s.run, s.innings, s.highRun]).toEqual([2, 2, 1, 2])
    s = applyJudgement(s, miss)
    expect([s.score, s.run, s.innings, s.highRun]).toEqual([2, 0, 2, 2])
    s = applyJudgement(s, hit)
    expect(average(s)).toBeCloseTo(3 / 2)
  })
  it('파울 감점은 0 아래로 내려가지 않는다', () => {
    let s = newScore(10)
    s = applyJudgement(s, foul)
    expect(s.score).toBe(0)
    expect(s.fouls).toBe(1)
  })
  it('목표 점수에 도달하면 끝난다', () => {
    let s = newScore(2)
    s = applyJudgement(s, hit)
    s = applyJudgement(s, hit)
    expect(s.finished).toBe(true)
  })
  it('마무리 규칙이 있으면 목표 도달 후 한 번 더 성공해야 끝난다', () => {
    const opts = { ...DEFAULT_RULES, finishWithThreeCushion: true }
    let s = newScore(1)
    s = applyJudgement(s, hit, opts)
    expect(s.finished).toBe(false)
    expect(s.finishing).toBe(true)
    s = applyJudgement(s, miss, opts)
    expect(s.finished).toBe(false)
    s = applyJudgement(s, hit, opts)
    expect(s.finished).toBe(true)
    expect(s.score).toBe(1)
  })
})

describe('배치', () => {
  it('초구 배치의 공들은 테이블 안에 있고 겹치지 않는다', () => {
    for (const d of ['3cushion', '4ball'] as const) {
      const t = tableFor(d)
      const balls = initialLayout(d)
      expect(balls.length).toBe(d === '3cushion' ? 3 : 4)
      for (const b of balls) {
        expect(b.r[0]).toBeGreaterThan(t.R)
        expect(b.r[0]).toBeLessThan(t.length - t.R)
        expect(b.r[1]).toBeGreaterThan(t.R)
        expect(b.r[1]).toBeLessThan(t.width - t.R)
      }
      for (let i = 0; i < balls.length; i++)
        for (let k = i + 1; k < balls.length; k++)
          expect(Math.hypot(balls[i].r[0] - balls[k].r[0], balls[i].r[1] - balls[k].r[1])).toBeGreaterThan(2 * t.R)
    }
  })
  it('장외 공은 겹치지 않는 자리로 돌아온다', () => {
    const t = tableFor('3cushion')
    const balls = initialLayout('3cushion')
    balls[2].s = 'out'
    // 빨간 공 자리를 흰 공이 차지하고 있는 경우
    balls[0].r = [balls[2].r[0], balls[2].r[1], t.R]
    const fixed = respot('3cushion', balls)
    expect(fixed[2].s).toBe('stationary')
    expect(Math.hypot(fixed[2].r[0] - fixed[0].r[0], fixed[2].r[1] - fixed[0].r[1])).toBeGreaterThan(2 * t.R)
  })
})
