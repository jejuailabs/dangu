import { describe, expect, it } from 'vitest'
import {
  CAROM_LARGE as T,
  DEFAULT_CUE,
  DEG,
  SNOOKER_MATHAVAN as S,
  type BallState,
  type ShotInput,
  type TableProfile,
  collideCushion,
  cushionReach,
  energy,
  evolveSystem,
  makeBall,
  simulate,
  strike,
} from '../src'

function shot(p: Partial<ShotInput>): ShotInput {
  return { ballId: 0, phi: 0, theta: 0, side: 0, top: 0, speed: 2, cue: DEFAULT_CUE, ...p }
}

/**
 * Mathavan, Jackson, Parkin (2010) 과의 대조.
 * 논문 조건: 스누커, M = 0.1406 kg, R = 26.25 mm, sin(theta) = 2/5, mu_s = 0.212, mu_w = 0.14, e_e = 0.98.
 * 논문 좌표를 따른다: x 는 쿠션을 따라, y 는 쿠션 쪽, alpha 는 쿠션에서 잰 입사각 (90 = 수직),
 * 전진 회전 w_T = kTop V/R, 좌우 회전 w_S = kSide V/R.
 */
describe('Mathavan 2010 쿠션 모델', () => {
  function hit(V: number, alphaDeg: number, kTop: number, kSide: number) {
    const R = S.R
    const a = alphaDeg * DEG
    const wT = (kTop * V) / R
    const b: BallState = {
      id: 0,
      r: [1, S.width - cushionReach(S), R],
      v: [V * Math.cos(a), V * Math.sin(a), 0],
      w: [-wT * Math.sin(a), wT * Math.cos(a), (kSide * V) / R],
      s: 'sliding',
    }
    collideCushion(b, S, [0, 1, 0])
    return { speed: Math.hypot(b.v[0], b.v[1]), beta: Math.atan2(-b.v[1], b.v[0]) / DEG, ball: b }
  }

  it('구르는 공의 수직 입사: 논문 식 (14) 를 손으로 푼 값 0.911 과 일치한다', () => {
    // 식 (14) 를 미끄럼 방향이 일정한 구간별로 적분하면 닫힌 값이 나온다:
    //   압축과 복원 초반은 dv/dP = -0.9149, 쿠션 접점의 미끄럼이 뒤집힌 뒤는 -0.7485,
    //   복원 단계의 일이 e^2 W_c 가 되는 지점에서 v = -0.911 V.
    for (const V of [0.5, 1, 1.5]) expect(hit(V, 90, 1, 0).speed / V).toBeCloseTo(0.911, 2)
  })

  it('논문 Fig. 8: 구르는 공의 반사각은 속도와 무관하다', () => {
    for (const al of [20, 40, 60, 80]) {
      expect(hit(0.5, al, 1, 0).beta).toBeCloseTo(hit(2, al, 1, 0).beta, 6)
    }
  })

  it('논문 Fig. 9: 속도 손실은 입사각 40도 부근에서 가장 크다', () => {
    const ratio = (al: number) => hit(1, al, 1, 0).speed
    const angles = [10, 20, 30, 40, 50, 60, 70, 80, 90]
    const worst = angles.reduce((m, a) => (ratio(a) < ratio(m) ? a : m), 10)
    expect(worst).toBeGreaterThanOrEqual(30)
    expect(worst).toBeLessThanOrEqual(50)
  })

  it('논문 Fig. 9: 전진 회전이 2V/R 이면 수직 입사에서 반사 속도가 입사 속도에 이른다', () => {
    const r = hit(1, 90, 2, 0).speed
    expect(r).toBeGreaterThan(0.95)
    expect(r).toBeLessThan(1.02)
  })

  it('논문 Fig. 10: 좌우 회전이 크면 반사 속도가 입사 속도를 넘는다', () => {
    expect(hit(1, 40, 1, 2).speed).toBeGreaterThan(1)
    // 반대 회전도 수직에 가까운 입사에서는 입사 속도를 넘는다
    expect(hit(1, 90, 1, -2).speed).toBeGreaterThan(1)
  })

  it('논문 Fig. 11: 수직에 가까운 입사에서 역회전이 크면 공이 온 쪽으로 되돌아간다', () => {
    expect(hit(1, 80, 1, -2).beta).toBeGreaterThan(90)
    expect(hit(1, 80, 1, 2).beta).toBeLessThan(90)
  })

  it('충돌에서 에너지가 늘지 않는다 (회전이 속도로 바뀌는 경우 포함)', () => {
    for (const al of [10, 45, 90])
      for (const ks of [-3, 0, 3])
        for (const kt of [-1, 0, 1, 2]) {
          const R = S.R
          const a = al * DEG
          const wT = kt / R
          const b: BallState = {
            id: 0,
            r: [1, S.width - cushionReach(S), R],
            v: [Math.cos(a), Math.sin(a), 0],
            w: [-wT * Math.sin(a), wT * Math.cos(a), ks / R],
            s: 'sliding',
          }
          const before = energy(b, S)
          collideCushion(b, S, [0, 1, 0])
          expect(energy(b, S)).toBeLessThan(before + 1e-9)
        }
  })

  it('Han 모델로 바꿔 쓸 수 있고 결과가 다르다', () => {
    const han: TableProfile = { ...T, cushionModel: 'han' }
    const balls = () => [makeBall(0, 0.71, 0.5, T), makeBall(1, 2.13, 0.71, T)]
    const a = simulate(T, balls(), shot({ phi: 30 * DEG, speed: 3, side: 0.3 }))
    const b = simulate(han, balls(), shot({ phi: 30 * DEG, speed: 3, side: 0.3 }))
    expect(a.truncated).toBe(false)
    expect(b.truncated).toBe(false)
    expect(a.hash).not.toBe(b.hash)
  })
})

describe('팁 접촉 타법 모델', () => {
  const hitInfo = (p: Partial<ShotInput>) => {
    const b = makeBall(0, 1, 0.7, T)
    const info = strike(b, T, shot(p))
    return { b, info }
  }

  it('접촉 시간은 실측 범위(0.8~3 ms) 안이고, 세게 칠수록 짧다', () => {
    const times = [0.5, 1, 2, 4, 8].map((speed) => hitInfo({ speed }).info.contactTime)
    for (const t of times) {
      expect(t).toBeGreaterThan(0.0008)
      expect(t).toBeLessThan(0.003)
    }
    for (let i = 1; i < times.length; i++) expect(times[i]).toBeLessThan(times[i - 1])
  })

  it('기준 조건에서 접촉 시간이 큐 사양과 일치한다', () => {
    expect(hitInfo({ speed: 2 }).info.contactTime).toBeCloseTo(DEFAULT_CUE.contactTime, 4)
  })

  it('접촉 중 공이 돌면서 당점이 바깥으로 밀려난다', () => {
    const { info } = hitInfo({ side: 0.4, speed: 2 })
    expect(info.finalOffset).toBeGreaterThan(0.4)
    expect(info.finalOffset).toBeLessThan(0.5)
  })

  it('부드러운 팁(긴 접촉)은 같은 당점에서 회전이 조금 더 걸린다', () => {
    const ratio = (contactTime: number) => {
      const { b } = hitInfo({ side: 0.4, speed: 2, cue: { ...DEFAULT_CUE, contactTime } })
      return b.w[2] / Math.hypot(b.v[0], b.v[1])
    }
    const hard = ratio(0.001)
    const soft = ratio(0.0025)
    expect(soft).toBeGreaterThan(hard)
    expect((soft - hard) / hard).toBeLessThan(0.25)
  })

  it('P18: 같은 임팩트 속도에서 가속 스트로크는 감속 스트로크보다 조금 더 전달한다', () => {
    const push = hitInfo({ speed: 2, accel: 30 }).b.v[0]
    const stop = hitInfo({ speed: 2, accel: -30 }).b.v[0]
    expect(push).toBeGreaterThan(stop)
    expect((push - stop) / stop).toBeLessThan(0.05)
  })

  it('세기에 따른 회전 대 속도 비의 차이는 작다', () => {
    // 접촉 중 공이 도는 각도는 (회전 속도 x 접촉 시간) 에 비례한다. 세게 치면 접촉은 짧아지지만
    // 회전 속도가 더 크게 늘어, 이 모델에서는 센 타격의 비가 조금 더 크다.
    const ratio = (speed: number) => {
      const { b } = hitInfo({ top: -0.4, speed })
      return Math.abs(b.w[1]) / Math.hypot(b.v[0], b.v[1])
    }
    const soft = ratio(0.6)
    const hard = ratio(6)
    expect(hard).toBeGreaterThan(soft)
    expect((hard - soft) / soft).toBeLessThan(0.1)
  })
})

describe('P17 테이블 기울기', () => {
  const rolling = (x: number, y: number, vx: number): BallState => ({
    id: 0,
    r: [x, y, T.R],
    v: [vx, 0, 0],
    w: [0, vx / T.R, 0],
    s: 'rolling',
  })

  it('수평 테이블에서는 직선으로 구른다', () => {
    const res = evolveSystem(T, [rolling(0.3, 0.7, 1)])
    expect(res.final[0].r[1]).toBe(0.7)
  })

  it('살짝 기운 테이블에서는 낮은 쪽으로 흐르고, 결국 멈춘다', () => {
    const tilted: TableProfile = { ...T, tiltY: 0.002 } // 약 0.11도, +y 쪽이 낮다
    const res = evolveSystem(tilted, [rolling(0.3, 0.5, 1)])
    expect(res.truncated).toBe(false)
    expect(res.final[0].s).toBe('stationary')
    expect(res.final[0].r[1]).toBeGreaterThan(0.5 + 0.02)
    // 반대로 기울이면 반대로 흐른다
    const other = evolveSystem({ ...T, tiltY: -0.002 }, [rolling(0.3, 0.5, 1)])
    expect(other.final[0].r[1]).toBeLessThan(0.5 - 0.02)
  })

  it('기울기가 클수록 더 많이 흐른다', () => {
    const drift = (tiltY: number) => evolveSystem({ ...T, tiltY }, [rolling(0.3, 0.3, 0.8)]).final[0].r[1] - 0.3
    expect(drift(0.003)).toBeGreaterThan(drift(0.001))
  })

  it('크게 기울이면 멈춰 있던 공들이 낮은 쪽 쿠션으로 굴러가 기대어 멈춘다', () => {
    const tilted: TableProfile = { ...T, tiltX: Math.sin(2 * DEG) } // 2도, +x 쪽이 낮다
    const balls = [makeBall(0, 0.7, 0.4, T), makeBall(1, 2.1, 0.71, T), makeBall(2, 1.4, 1.0, T)]
    const res = evolveSystem(tilted, balls)
    expect(res.truncated).toBe(false)
    for (const b of res.final) {
      expect(b.s).toBe('stationary')
      expect(b.r[0]).toBeGreaterThan(T.length - cushionReach(T) - 1e-3)
    }
    let prev = Infinity
    for (const e of res.events) {
      const en = e.balls.reduce((s, b) => s + energy(b, tilted), 0)
      expect(en).toBeLessThanOrEqual(prev + 1e-6)
      prev = en
    }
  })

  it('크게 기운 테이블에서 같은 줄의 공들도 차례로 기대어 멈춘다', () => {
    const tilted: TableProfile = { ...T, tiltX: Math.sin(3 * DEG) }
    const balls = [makeBall(0, 1.0, 0.7, T), makeBall(1, 1.5, 0.7, T), makeBall(2, 2.0, 0.7, T)]
    const res = evolveSystem(tilted, balls)
    expect(res.truncated).toBe(false)
    const xs = res.final.map((b) => b.r[0]).sort((a, b) => a - b)
    expect(xs[2]).toBeGreaterThan(T.length - cushionReach(T) - 1e-3)
    // 공끼리 겹치지 않고 붙어 있다
    expect(xs[2] - xs[1]).toBeGreaterThan(2 * T.R - 1e-6)
    expect(xs[2] - xs[1]).toBeLessThan(2 * T.R + 1e-3)
    expect(xs[1] - xs[0]).toBeGreaterThan(2 * T.R - 1e-6)
    expect(xs[1] - xs[0]).toBeLessThan(2 * T.R + 1e-3)
  })

  it('기운 테이블에서 무작위 샷이 모두 끝난다', () => {
    let s = 4242
    const rnd = () => {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0
      return s / 4294967296
    }
    for (const tilt of [0.003, Math.sin(1.5 * DEG)]) {
      const tilted: TableProfile = { ...T, tiltX: tilt * 0.6, tiltY: -tilt * 0.8 }
      for (let n = 0; n < 60; n++) {
        const balls = [makeBall(0, 0.7, 0.4, T), makeBall(1, 2.1, 0.71, T), makeBall(2, 1.4, 1.0, T)]
        const res = simulate(
          tilted,
          balls,
          shot({ phi: rnd() * 2 * Math.PI, speed: 0.5 + rnd() * 6, side: (rnd() - 0.5) * 0.8, top: (rnd() - 0.5) * 0.8 }),
        )
        expect(res.truncated).toBe(false)
        for (const b of res.final) expect(b.s === 'stationary' || b.s === 'out').toBe(true)
      }
    }
  })
})

describe('공중에 뜬 공과 쿠션', () => {
  it('쿠션 바로 앞에서 강하게 점프시키면 쿠션을 넘어 장외가 된다', () => {
    const res = simulate(T, [makeBall(0, T.length - 0.25, 0.7, T)], shot({ theta: 45 * DEG, speed: 7 }))
    expect(res.truncated).toBe(false)
    expect(res.events.some((e) => e.type === 'out')).toBe(true)
    expect(res.final[0].s).toBe('out')
  })

  it('낮게 뜬 공은 쿠션 코에 맞고 테이블 안으로 돌아온다', () => {
    const res = simulate(T, [makeBall(0, T.length - 0.12, 0.7, T)], shot({ theta: 20 * DEG, speed: 3 }))
    expect(res.truncated).toBe(false)
    const hit = res.events.find((e) => e.type === 'cushion')!
    expect(hit).toBeDefined()
    expect(res.final[0].s).toBe('stationary')
    expect(res.final[0].r[0]).toBeLessThan(T.length - cushionReach(T) + 1e-6)
  })

  it('쿠션 코 위쪽에 맞은 공은 위로 튄다', () => {
    // 공 중심이 쿠션 코보다 높은 상태에서 쿠션으로 수평 이동
    const z = T.cushionHeight + 0.6 * T.R
    const gap = Math.sqrt(T.R * T.R - (z - T.cushionHeight) ** 2)
    const b: BallState = { id: 0, r: [T.length - gap, 0.7, z], v: [1.5, 0, 0], w: [0, 0, 0], s: 'airborne' }
    collideCushion(b, T, [1, 0, 0])
    expect(b.v[2]).toBeGreaterThan(0)
  })
})
