/**
 * 자동 대국: 컴퓨터가 혼자 이닝을 반복해 에버리지를 잰다. 보정과 테스트에 쓴다.
 */
import { cloneBall, simulate } from '../../physics/src'
import { cueById } from '../../game/src/progress'
import { DEFAULT_RULES, type Discipline, initialLayout, judge, respot, tableFor } from '../../rules/src'
import { chooseShot, paramsForSkill } from './index'

export interface Measurement {
  /** 이닝당 평균 득점 */
  avg: number
  high: number
  shots: number
  /** 득점 가능한 샷을 찾은 비율 */
  foundRate: number
  msPerShot: number
}

export function measure(d: Discipline, skill: number, innings: number, cueId = 'gold', seed = 1): Measurement {
  const table = tableFor(d)
  const cue = cueById(cueId)
  const params = paramsForSkill(skill)
  let balls = initialLayout(d)
  let points = 0
  let high = 0
  let shots = 0
  let found = 0
  let ms = 0
  let s = seed
  for (let i = 0; i < innings; i++) {
    let run = 0
    // 한 이닝의 연속 득점은 60 에서 끊는다 (측정이 끝나지 않는 것을 막는다)
    for (let k = 0; k < 60; k++) {
      const t0 = performance.now()
      const dec = chooseShot({
        table,
        discipline: d,
        rules: DEFAULT_RULES,
        balls,
        cueId: 0,
        finishing: false,
        cue: cue.spec,
        maxSpeed: cue.maxSpeed,
        params,
        seed: s++,
      })
      ms += performance.now() - t0
      shots++
      if (dec.found > 0) found++
      const res = simulate(table, balls, dec.executed)
      const j = judge(d, res, 0, DEFAULT_RULES)
      balls = respot(d, res.final.map(cloneBall))
      if (!j.scored) break
      run++
    }
    points += run
    if (run > high) high = run
  }
  return { avg: points / innings, high, shots, foundRate: found / shots, msPerShot: ms / shots }
}
