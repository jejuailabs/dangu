import { describe, expect, it } from 'vitest'
import { DEFAULT_CUE, DEG, type ShotInput } from '../../physics/src'
import { DEFAULT_RULES } from '../../rules/src'
import { type MatchConfig, type ShotRecord, cueIdOf, initialState, miscueChance, newMatch, play, rebuild, summarize } from '../src'

const shot = (deg: number, speed = 3, side = 0): ShotRecord => ({
  player: 0,
  input: { ballId: 0, phi: deg * DEG, theta: 0, side, top: 0.2, speed, cue: DEFAULT_CUE } as ShotInput,
})
// 초구 배치에서 득점하는 샷 (rules 의 통합 테스트에서 찾은 값)
const SCORING = shot(2, 4)
// 아무 공도 맞히지 못하는 샷
const MISS = shot(250, 0.5)

const solo: MatchConfig = { discipline: '3cushion', players: [{ name: '나', target: 3 }], rules: DEFAULT_RULES, shotClock: 0 }
const versus: MatchConfig = {
  discipline: '3cushion',
  players: [
    { name: '가', target: 5 },
    { name: '나', target: 5 },
  ],
  rules: DEFAULT_RULES,
  shotClock: 40,
}

describe('혼자 치기', () => {
  it('득점하면 계속 치고, 실패하면 이닝이 넘어간다', () => {
    const rec = newMatch(solo, 'a', 0)
    let st = initialState(rec)
    const r1 = play(rec, st, SCORING)
    expect(r1.outcome.judgement.scored).toBe(true)
    st = r1.state
    expect([st.players[0].score, st.players[0].innings, st.turn]).toEqual([1, 1, 0])
    st = play(rec, st, MISS).state
    expect([st.players[0].score, st.players[0].innings, st.players[0].run]).toEqual([1, 2, 0])
    expect(st.players[0].inningPoints).toEqual([1, 0])
    expect(rec.shots.length).toBe(2)
  })
})

describe('2인 대전', () => {
  it('실패하면 차례가 넘어가고, 넘어간 사람의 이닝이 시작된다', () => {
    const rec = newMatch(versus, 'b', 0)
    let st = initialState(rec)
    expect(st.players.map((p) => p.innings)).toEqual([1, 0])
    st = play(rec, st, MISS).state
    expect(st.turn).toBe(1)
    expect(st.players.map((p) => p.innings)).toEqual([1, 1])
    st = play(rec, st, MISS).state
    expect(st.turn).toBe(0)
    expect(st.players.map((p) => p.innings)).toEqual([2, 1])
  })

  it('두 번째 사람은 노란 공을 친다', () => {
    const rec = newMatch(versus, 'c', 0)
    let st = initialState(rec)
    st = play(rec, st, MISS).state
    const yellowBefore = st.balls.find((b) => b.id === cueIdOf(1))!.r.slice()
    const whiteBefore = st.balls.find((b) => b.id === cueIdOf(0))!.r.slice()
    const r = play(rec, st, shot(90, 1))
    const yellowAfter = r.state.balls.find((b) => b.id === cueIdOf(1))!.r
    const whiteAfter = r.state.balls.find((b) => b.id === cueIdOf(0))!.r
    expect(yellowAfter).not.toEqual(yellowBefore)
    expect(whiteAfter).toEqual(whiteBefore)
  })

  it('시간 초과는 파울로 차례가 넘어간다', () => {
    const rec = newMatch(versus, 'd', 0)
    const r = play(rec, initialState(rec), { player: 0, timeout: true })
    expect(r.outcome.judgement.reason).toBe('시간 초과')
    expect(r.state.turn).toBe(1)
    expect(r.state.players[0].fouls).toBe(1)
  })

  it('목표 점수에 먼저 닿은 사람이 이긴다', () => {
    const rec = newMatch({ ...versus, players: [{ name: '가', target: 1 }, { name: '나', target: 1 }] }, 'e', 0)
    const r = play(rec, initialState(rec), SCORING)
    expect(r.state.finished).toBe(true)
    expect(r.state.winner).toBe(0)
    expect(() => play(rec, r.state, MISS)).toThrow()
  })
})

describe('기록과 다시 계산', () => {
  function playSome() {
    const rec = newMatch(versus, 'f', 123)
    let st = initialState(rec)
    const seq = [SCORING, shot(40, 3, 0.3), MISS, shot(120, 2.5), shot(10, 4, -0.2), MISS, shot(300, 3)]
    for (const s of seq) {
      if (st.finished) break
      st = play(rec, st, s).state
    }
    return { rec, st }
  }

  it('기록을 다시 계산하면 진행 중의 상태와 똑같다', () => {
    const { rec, st } = playSome()
    const re = rebuild(rec)
    expect(re.state).toEqual(st)
    expect(re.outcomes.length).toBe(rec.shots.length)
  })

  it('JSON 으로 저장했다 읽어도 결과가 같다', () => {
    const { rec, st } = playSome()
    const loaded = JSON.parse(JSON.stringify(rec))
    expect(rebuild(loaded).state).toEqual(st)
  })

  it('기록지의 이닝별 점수 합은 점수와 같다', () => {
    const { st } = playSome()
    for (const p of st.players) {
      expect(p.inningPoints.reduce((a, b) => a + b, 0)).toBe(p.score)
      expect(p.inningPoints.length).toBe(p.innings)
    }
  })

  it('요약 통계', () => {
    const { rec, st } = playSome()
    const sum = summarize(rec, st)
    expect(sum[0].name).toBe('가')
    expect(sum[0].shots + sum[1].shots).toBe(rec.shots.length)
    expect(sum[0].average).toBeCloseTo(st.players[0].score / st.players[0].innings)
    expect(sum[0].successRate).toBeGreaterThan(0)
  })

  it('한 경기의 기록은 작다', () => {
    const { rec } = playSome()
    expect(JSON.stringify(rec).length).toBeLessThan(6000)
  })
})

describe('초크와 미스큐', () => {
  const spin = (side: number, chalked = false): ShotRecord => ({ player: 0, chalked, input: { ...shot(250, 0.5, side).input!, top: 0 } })
  const miscued = (id: string, s: ShotRecord, n = 1) => {
    const rec = newMatch({ ...solo, players: [{ name: '나', target: 999 }] }, id, 0)
    let st = initialState(rec)
    let last = false
    for (let i = 0; i < n; i++) {
      const r = play(rec, st, s)
      st = r.state
      last = r.outcome.result!.events[0].miscue === true
    }
    return { last, st, rec }
  }

  it('확률: 안전한 범위에서는 0, 한계를 넘어가면 커지고, 초크가 없으면 더 일찍 위험해진다', () => {
    const L = DEFAULT_CUE.miscueLimit
    expect(miscueChance(L * 0.99, L, 1)).toBe(0)
    expect(miscueChance(L * 1.14, L, 1)).toBeCloseTo(0.5, 5)
    expect(miscueChance(L * 1.3, L, 1)).toBe(1)
    expect(miscueChance(L * 0.9, L, 0)).toBeGreaterThan(0.5)
    expect(miscueChance(L * 0.8, L, 0)).toBe(0)
  })

  it('한계 근처에서는 미스큐가 나기도 하고 안 나기도 한다', () => {
    const side = DEFAULT_CUE.miscueLimit * 1.14
    let n = 0
    for (let i = 0; i < 200; i++) if (miscued(`m${i}`, spin(side, true)).last) n++
    expect(n).toBeGreaterThan(70)
    expect(n).toBeLessThan(130)
  })

  it('칠할수록 초크가 닳고, 칠하면 다시 찬다', () => {
    const a = miscued('w', spin(0.2), 4)
    expect(a.st.players[0].chalk!).toBeLessThan(0.5)
    const r = play(a.rec, a.st, spin(0, true))
    expect(r.state.players[0].chalk!).toBeCloseTo(0.92, 5)
  })

  it('초크 없이 계속 치면 한계 안쪽 당점에서도 미스큐가 난다', () => {
    const side = DEFAULT_CUE.miscueLimit * 0.95
    expect(miscued('x', spin(side, true)).last).toBe(false)
    const r = miscued('x', spin(side), 6)
    expect(r.st.players[0].chalk).toBe(0)
  })

  it('기록에 미스큐 여부를 적어 보내도 무시하고 다시 정한다', () => {
    const cheat = spin(0.85, true)
    cheat.input = { ...cheat.input!, miscue: false }
    expect(miscued('c', cheat).last).toBe(true)
  })

  it('예전 기록(초크 없음)은 예전 방식으로 다시 계산한다', () => {
    const rec = newMatch(solo, 'old', 0)
    delete rec.chalk
    const r = play(rec, initialState(rec), spin(DEFAULT_CUE.miscueLimit * 1.05, true))
    expect(r.outcome.result!.events[0].miscue).toBe(true)
    expect(r.state.players[0].chalk).toBeUndefined()
  })
})
