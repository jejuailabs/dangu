import { describe, expect, it } from 'vitest'
import { CAROM_LARGE as T, CORE_VERSION, DEFAULT_CUE, DEG, makeBall, selfTestHash, simulate } from '../src'

/**
 * 기준 해시. 물리 결과가 바뀌면 이 테스트가 깨진다.
 * 의도한 변경이면 CORE_VERSION 을 올리고 해시를 갱신한다.
 */
describe(`기준 해시 (코어 ${CORE_VERSION})`, () => {
  it('기본 배치, 방향 12도, 큐 속도 3 m/s', () => {
    const balls = [makeBall(0, 0.71, 0.5, T), makeBall(1, 2.13, 0.71, T), makeBall(2, 1.42, 1.0, T)]
    const res = simulate(T, balls, {
      ballId: 0,
      phi: 12 * DEG,
      theta: 0,
      side: 0,
      top: 0,
      speed: 3,
      accel: 0,
      cue: DEFAULT_CUE,
    })
    expect(res.hash).toBe('ca464d9698f58d3b')
  })

  it('자가 점검 묶음 (200 샷)', () => {
    const h = selfTestHash()
    expect(h).toBe('2063bf16b36628c7')
  })
})
