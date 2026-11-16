import { describe, expect, it } from 'vitest'
import { DEFAULT_STROKE as S, analyzeStroke, tipGap, type StrokeSample } from '../src/stroke'

/** 위치 함수 y(t)[px], x(t)[px] 를 8ms 간격으로 표본화한다 */
function sample(y: (t: number) => number, x: (t: number) => number, until: number, step = 8): StrokeSample[] {
  const out: StrokeSample[] = []
  for (let t = 0; t <= until; t += step) out.push({ t, y: y(t), x: x(t) })
  return out
}
const gapPx = S.startGap / S.metersPerPx

describe('스트로크 분석', () => {
  it('팁이 공에 닿기 전에는 결과가 없다', () => {
    const s = sample((t) => -t * 0.5, () => 0, 300)
    expect(analyzeStroke(s)).toBeNull()
    expect(tipGap(s, S)).toBeGreaterThan(S.startGap)
  })

  it('일정한 속도로 밀면 그 속도가 나오고 가속도는 0 에 가깝다', () => {
    // 200ms 동안 150px 당긴 뒤, 2 px/ms 로 전진 = 2 * 1000 * 0.0006 = 1.2 m/s
    const y = (t: number) => (t < 200 ? -0.75 * t : -150 + 2 * (t - 200))
    const a = analyzeStroke(sample(y, () => 0, 400))!
    expect(a).not.toBeNull()
    expect(a.speed).toBeCloseTo(1.2, 1)
    expect(Math.abs(a.accel)).toBeLessThan(3)
    expect(a.backswing).toBeCloseTo(150 * S.metersPerPx, 3)
    expect(a.aimError).toBeCloseTo(0, 6)
  })

  it('가속하며 닿으면 가속도가 양수 (밀어치기)', () => {
    // 전진: y = -150 + 0.5 * k * s^2  (s: 전진 시작 후 ms)
    const k = 0.02
    const y = (t: number) => (t < 200 ? -0.75 * t : -150 + 0.5 * k * (t - 200) ** 2)
    const a = analyzeStroke(sample(y, () => 0, 420))!
    // k px/ms^2 = k * 1e6 * 0.0006 m/s^2 = 12 m/s^2
    expect(a.accel).toBeGreaterThan(6)
    expect(a.accel).toBeLessThan(20)
  })

  it('감속하며 닿으면 가속도가 음수 (끊어치기)', () => {
    // 빠르게 출발해 공 근처에서 느려지는 전진
    const total = 150 + gapPx + 5
    const dur = 160
    const y = (t: number) => {
      if (t < 200) return -0.75 * t
      const u = Math.min((t - 200) / dur, 1)
      return -150 + total * (2 * u - u * u) // 속도가 선형으로 줄어든다
    }
    const a = analyzeStroke(sample(y, () => 0, 380))!
    expect(a.accel).toBeLessThan(-6)
    expect(a.speed).toBeGreaterThan(0)
  })

  it('같은 백스윙이라도 빠르게 밀면 속도가 크다', () => {
    const mk = (v: number) => analyzeStroke(sample((t) => (t < 200 ? -0.75 * t : -150 + v * (t - 200)), () => 0, 600))!
    expect(mk(4).speed).toBeGreaterThan(mk(1).speed * 3)
  })

  it('옆으로 흐르며 밀면 조준과 당점에 오차가 생긴다', () => {
    const y = (t: number) => (t < 200 ? -0.75 * t : -150 + 2 * (t - 200))
    const right = analyzeStroke(sample(y, (t) => (t < 200 ? 0 : 0.3 * (t - 200)), 400))!
    expect(right.aimError).toBeLessThan(0)
    expect(right.sideError).toBeGreaterThan(0)
    const left = analyzeStroke(sample(y, (t) => (t < 200 ? 0 : -0.3 * (t - 200)), 400))!
    expect(left.aimError).toBeCloseTo(-right.aimError, 6)
  })

  it('흔들림 반영 비율이 0 이면 오차가 없다', () => {
    const y = (t: number) => (t < 200 ? -0.75 * t : -150 + 2 * (t - 200))
    const a = analyzeStroke(sample(y, (t) => 0.3 * t, 400), { ...S, wobbleGain: 0 })!
    expect(Math.abs(a.aimError)).toBe(0)
    expect(Math.abs(a.sideError)).toBe(0)
  })

  it('속도는 상한을 넘지 않는다', () => {
    const a = analyzeStroke(sample((t) => (t < 100 ? -2 * t : -200 + 60 * (t - 100)), () => 0, 200, 4))!
    expect(a.speed).toBeLessThanOrEqual(S.maxSpeed)
  })

  it('백스윙 없이 그대로 밀어도 분석된다', () => {
    const a = analyzeStroke(sample((t) => 1.5 * t, () => 0, 100))!
    expect(a.speed).toBeGreaterThan(0.5)
    expect(a.backswing).toBeCloseTo(0, 6)
  })
})
