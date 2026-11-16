import { describe, expect, it } from 'vitest'
import { DEFAULT_CUE, DEG, simulate } from '../../physics/src'
import { WHITE, initialLayout, judge, tableFor, type Discipline } from '../src'

/** 초구 배치에서 방향·당점·속도를 훑어 득점하는 샷을 찾는다. */
function search(d: Discipline) {
  const table = tableFor(d)
  const found: { phi: number; side: number; speed: number; cushions: number }[] = []
  let fouls = 0
  let total = 0
  for (let deg = 0; deg < 360; deg += 2)
    for (const side of [-0.4, 0, 0.4])
      for (const speed of [2.5, 4]) {
        const res = simulate(table, initialLayout(d), {
          ballId: WHITE,
          phi: deg * DEG,
          theta: 0,
          side,
          top: 0.2,
          speed,
          cue: DEFAULT_CUE,
        })
        expect(res.truncated).toBe(false)
        const j = judge(d, res, WHITE)
        total++
        if (j.foul) fouls++
        if (j.scored) found.push({ phi: deg, side, speed, cushions: j.cushionsBeforeSecond })
      }
  return { found, fouls, total }
}

describe('물리와 규칙을 이은 판정', () => {
  it('3쿠션: 초구 배치에서 득점하는 샷이 있고, 모두 3쿠션 이상이다', () => {
    const { found, total } = search('3cushion')
    console.log(`3쿠션 득점 샷 ${found.length} / ${total}, 예: ${JSON.stringify(found[0])}`)
    expect(found.length).toBeGreaterThan(0)
    for (const f of found) expect(f.cushions).toBeGreaterThanOrEqual(3)
    // 아무렇게나 쳐서 득점할 확률은 낮아야 한다
    expect(found.length / total).toBeLessThan(0.2)
  })

  it('4구: 득점하는 샷이 있고, 파울(상대 수구 맞힘, 헛침)도 나온다', () => {
    const { found, fouls, total } = search('4ball')
    console.log(`4구 득점 샷 ${found.length} / ${total}, 파울 ${fouls}, 예: ${JSON.stringify(found[0])}`)
    expect(found.length).toBeGreaterThan(0)
    expect(fouls).toBeGreaterThan(0)
  })
})
