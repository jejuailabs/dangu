import { describe, expect, it } from 'vitest'
import { dcos, dexp, dsin, firstDownCrossing, realRoots } from '../src'

describe('결정적 수학 함수', () => {
  it('dsin, dcos 가 넓은 범위에서 정확하다', () => {
    for (let i = -2000; i <= 2000; i++) {
      const x = i * 0.0137
      expect(Math.abs(dsin(x) - Math.sin(x))).toBeLessThan(1e-14)
      expect(Math.abs(dcos(x) - Math.cos(x))).toBeLessThan(1e-14)
    }
  })

  it('dexp 가 정확하다', () => {
    for (let i = -200; i <= 200; i++) {
      const x = i * 0.05
      const rel = Math.abs(dexp(x) - Math.exp(x)) / Math.exp(x)
      expect(rel).toBeLessThan(1e-14)
    }
  })
})

describe('다항식 근', () => {
  it('4차식 (t-1)(t-2)(t-3)(t-4) 의 근을 모두 찾는다', () => {
    const roots = realRoots([24, -50, 35, -10, 1], 0, 10)
    expect(roots.length).toBe(4)
    ;[1, 2, 3, 4].forEach((r, i) => expect(roots[i]).toBeCloseTo(r, 9))
  })

  it('구간 밖의 근은 제외한다', () => {
    expect(realRoots([24, -50, 35, -10, 1], 2.5, 3.5).length).toBe(1)
  })

  it('최고차 계수가 0 이어도 동작한다', () => {
    const roots = realRoots([-2, 1, 0, 0, 0], 0, 10)
    expect(roots).toEqual([2])
  })

  it('양수에서 0 이하로 내려가는 첫 시각을 찾는다', () => {
    // f = (t-1)(t-3) = 3 - 4t + t^2 : t=1 에서 내려감
    expect(firstDownCrossing([3, -4, 1], 10)).toBeCloseTo(1, 12)
    // tmax 가 근보다 앞이면 없음
    expect(firstDownCrossing([3, -4, 1], 0.5)).toBe(Infinity)
  })

  it('닿아 있고 멀어지는 중이면 무시하고, 가까워지는 중이면 0 을 돌려준다', () => {
    expect(firstDownCrossing([0, 1, 0], 10)).toBe(Infinity)
    expect(firstDownCrossing([0, -1, 0], 10)).toBe(0)
    expect(firstDownCrossing([-1e-15, 1, 0], 10)).toBe(Infinity)
  })

  it('멀어졌다가 다시 돌아오는 경우 재접근 시각을 찾는다', () => {
    // f = t (2 - t) = 2t - t^2 : 0 에서 출발해 올라갔다가 t=2 에서 다시 0
    expect(firstDownCrossing([0, 2, -1], 10)).toBeCloseTo(2, 12)
  })
})
