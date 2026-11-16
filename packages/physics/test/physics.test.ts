import { describe, expect, it } from 'vitest'
import {
  CAROM_LARGE as T,
  DEFAULT_CUE,
  DEG,
  type BallState,
  type ShotInput,
  type ShotResult,
  energy,
  evolveSystem,
  makeBall,
  cushionReach,
  simulate,
  stateAt,
  strike,
  strikeImpulse,
} from '../src'

const R = T.R
const deg = (rad: number) => (rad * 180) / Math.PI

function moving(id: number, x: number, y: number, v: [number, number, number], w: [number, number, number]): BallState {
  return { id, r: [x, y, R], v, w, s: 'sliding' }
}
function rollingBall(id: number, x: number, y: number, vx: number, vy: number): BallState {
  return { id, r: [x, y, R], v: [vx, vy, 0], w: [-vy / R, vx / R, 0], s: 'rolling' }
}
function shot(p: Partial<ShotInput>): ShotInput {
  return { ballId: 0, phi: 0, theta: 0, side: 0, top: 0, speed: 2, cue: DEFAULT_CUE, ...p }
}
/** 특정 공이 처음으로 주어진 조건을 만족하는 이벤트의 상태 */
function firstState(res: ShotResult, id: number, pred: (b: BallState, i: number) => boolean, from = 0) {
  for (let i = from; i < res.events.length; i++) {
    const b = res.events[i].balls.find((x) => x.id === id)!
    if (pred(b, i)) return b
  }
  return undefined
}

describe('P1~P3 바닥 위 운동', () => {
  it('P1: 회전 없이 출발한 공은 구름에 도달하면 속도가 5/7 이 된다', () => {
    const res = evolveSystem(T, [moving(0, 0.3, 0.7, [1, 0, 0], [0, 0, 0])])
    const b = res.events[0].balls[0]
    expect(res.events[0].type).toBe('transition')
    expect(b.s).toBe('rolling')
    expect(b.v[0]).toBeCloseTo(5 / 7, 12)
  })

  it('P2: 미끄럼 지속 시간은 2u / (7 mu g)', () => {
    const res = evolveSystem(T, [moving(0, 0.3, 0.7, [1, 0, 0], [0, 0, 0])])
    expect(res.events[0].t).toBeCloseTo(2 / (7 * T.muSlide * T.g), 12)
  })

  it('P3: 구르는 공의 정지 거리는 v^2 / (2 mu_r g)', () => {
    const v = 0.5
    const res = evolveSystem(T, [rollingBall(0, 0.3, 0.7, v, 0)])
    expect(res.final[0].s).toBe('stationary')
    expect(res.final[0].r[0] - 0.3).toBeCloseTo((v * v) / (2 * T.muRoll * T.g), 10)
  })

  it('제자리 회전은 일정하게 줄어 멈춘다', () => {
    const b: BallState = { id: 0, r: [1, 0.7, R], v: [0, 0, 0], w: [0, 0, 20], s: 'spinning' }
    const res = evolveSystem(T, [b])
    expect(res.duration).toBeCloseTo(20 / T.spinDecel, 12)
    expect(res.final[0].s).toBe('stationary')
  })
})

describe('큐 타격', () => {
  it('중심 타격 속도는 (1+e)V / (1 + m/M)', () => {
    const b = makeBall(0, 1, 0.7, T)
    strike(b, T, shot({ speed: 2 }))
    const expected = ((1 + DEFAULT_CUE.tipRestitution) * 2) / (1 + T.m / DEFAULT_CUE.mass)
    // 접촉 모델은 수치 적분이라 닫힌 식과 4자리까지 일치한다
    expect(b.v[0]).toBeCloseTo(expected, 4)
    expect(b.v[1]).toBeCloseTo(0, 12)
    // 임펄스 모델은 닫힌 식 그대로다
    const c = makeBall(0, 1, 0.7, T)
    strikeImpulse(c, T, shot({ speed: 2 }))
    expect(c.v[0]).toBeCloseTo(expected, 12)
    expect(Math.hypot(b.w[0], b.w[1], b.w[2])).toBeLessThan(1e-9)
  })

  it('윗당점은 전진 회전, 아랫당점은 후진 회전을 준다', () => {
    const a = makeBall(0, 1, 0.7, T)
    strike(a, T, shot({ top: 0.4 }))
    expect(a.w[1]).toBeGreaterThan(0)
    const b = makeBall(0, 1, 0.7, T)
    strike(b, T, shot({ top: -0.4 }))
    expect(b.w[1]).toBeLessThan(0)
  })

  it('P8: 오른쪽 당점은 반시계 회전을 주고 공은 왼쪽으로 밀린다 (스쿼트)', () => {
    const b = makeBall(0, 1, 0.7, T)
    strike(b, T, shot({ side: 0.4 }))
    expect(b.w[2]).toBeGreaterThan(0)
    const squirt = deg(Math.atan2(b.v[1], b.v[0]))
    expect(squirt).toBeGreaterThan(0.3)
    expect(squirt).toBeLessThan(4)
  })

  it('P8: 끝 질량이 작은 큐는 스쿼트가 작다', () => {
    const a = makeBall(0, 1, 0.7, T)
    strike(a, T, shot({ side: 0.4 }))
    const b = makeBall(0, 1, 0.7, T)
    strike(b, T, shot({ side: 0.4, cue: { ...DEFAULT_CUE, endMass: 0.005 } }))
    expect(Math.atan2(b.v[1], b.v[0])).toBeLessThan(Math.atan2(a.v[1], a.v[0]))
  })

  it('당점이 멀수록 같은 큐 속도에서 공 속도는 줄어든다', () => {
    const a = makeBall(0, 1, 0.7, T)
    strike(a, T, shot({}))
    const b = makeBall(0, 1, 0.7, T)
    strike(b, T, shot({ top: 0.45 }))
    expect(Math.hypot(b.v[0], b.v[1])).toBeLessThan(Math.hypot(a.v[0], a.v[1]))
  })

  it('미스큐 한계를 넘으면 미스큐로 처리된다', () => {
    const b = makeBall(0, 1, 0.7, T)
    expect(strike(b, T, shot({ side: 0.6 })).miscue).toBe(true)
    const c = makeBall(0, 1, 0.7, T)
    expect(strike(c, T, shot({ side: 0.3 })).miscue).toBe(false)
  })

  it('P18: 가속하며 맞으면 감속하며 맞을 때보다 약간 빠르고, 그 차이는 작다', () => {
    const a = makeBall(0, 1, 0.7, T)
    strike(a, T, shot({ accel: 30 }))
    const b = makeBall(0, 1, 0.7, T)
    strike(b, T, shot({ accel: -30 }))
    expect(a.v[0]).toBeGreaterThan(b.v[0])
    expect((a.v[0] - b.v[0]) / b.v[0]).toBeLessThan(0.05)
  })
})

describe('P4~P7 공-공 충돌', () => {
  it('P4: 스턴(무회전) 반두께 충돌에서 두 공은 약 90도로 갈라진다', () => {
    const cue = moving(0, 1, 0.7, [2, 0, 0], [0, 0, 0])
    const obj = makeBall(1, 1 + 2 * R + 0.002, 0.7 + R, T)
    const res = evolveSystem(T, [cue, obj])
    const e = res.events.find((x) => x.type === 'ball-ball')!
    const c = e.balls[0]
    const o = e.balls[1]
    const ang = deg(Math.atan2(o.v[1], o.v[0]) - Math.atan2(c.v[1], c.v[0]))
    expect(ang).toBeGreaterThan(82)
    expect(ang).toBeLessThan(91)
  })

  it('P5: 구르는 수구의 반두께 충돌은 약 30도 꺾인다', () => {
    const cue = rollingBall(0, 0.6, 0.7, 1.2, 0)
    const obj = makeBall(1, 1.2, 0.7 + R, T)
    const res = evolveSystem(T, [cue, obj])
    const hit = res.events.findIndex((x) => x.type === 'ball-ball')
    expect(hit).toBeGreaterThanOrEqual(0)
    const after = firstState(res, 0, (b) => b.s === 'rolling', hit)!
    const ang = Math.abs(deg(Math.atan2(after.v[1], after.v[0])))
    expect(ang).toBeGreaterThan(26)
    expect(ang).toBeLessThan(40)
  })

  it('P6: 끌어치기는 정면 충돌 후 수구가 뒤로 돌아온다', () => {
    const cue = moving(0, 1, 0.7, [2.5, 0, 0], [0, -70, 0])
    const obj = makeBall(1, 1.25, 0.7, T)
    const res = evolveSystem(T, [cue, obj])
    const hit = res.events.find((x) => x.type === 'ball-ball')!
    const hitX = hit.balls[0].r[0]
    expect(res.final[0].r[0]).toBeLessThan(hitX - 0.05)
  })

  it('P6: 밀어치기는 정면 충돌 후 수구가 따라간다', () => {
    const cue = rollingBall(0, 1, 0.7, 2, 0)
    const obj = makeBall(1, 1.3, 0.7, T)
    const res = evolveSystem(T, [cue, obj])
    const hit = res.events.find((x) => x.type === 'ball-ball')!
    expect(res.final[0].r[0]).toBeGreaterThan(hit.balls[0].r[0] + 0.05)
  })

  it('P7: 오른쪽 회전은 목적구를 왼쪽으로 튼다 (스로우), 느릴수록 크다', () => {
    const throwAngle = (speed: number) => {
      const cue = moving(0, 1, 0.7, [speed, 0, 0], [0, 0, speed / R])
      const obj = makeBall(1, 1 + 2 * R + 0.001, 0.7, T)
      const res = evolveSystem(T, [cue, obj])
      const e = res.events.find((x) => x.type === 'ball-ball')!
      return deg(Math.atan2(e.balls[1].v[1], e.balls[1].v[0]))
    }
    const slow = throwAngle(0.5)
    const fast = throwAngle(4)
    expect(slow).toBeGreaterThan(0.5)
    expect(slow).toBeLessThan(8)
    expect(fast).toBeGreaterThan(0)
    expect(slow).toBeGreaterThan(fast)
  })

  it('충돌로 목적구에 회전이 전달된다', () => {
    const cue = moving(0, 1, 0.7, [1, 0, 0], [0, 0, 40])
    const obj = makeBall(1, 1 + 2 * R + 0.001, 0.7, T)
    const res = evolveSystem(T, [cue, obj])
    const e = res.events.find((x) => x.type === 'ball-ball')!
    // 수구가 반시계면 목적구는 시계 방향 (톱니바퀴)
    expect(e.balls[1].w[2]).toBeLessThan(0)
  })
})

describe('P11~P13 쿠션', () => {
  /** +y 쿠션을 향해 입사각(쿠션 법선 기준)으로 굴려 보내고 반사 직후 상태를 얻는다 */
  function bounce(speed: number, incDeg: number, wz: number) {
    const a = incDeg * DEG
    const vx = speed * Math.sin(a)
    const vy = speed * Math.cos(a)
    const b: BallState = {
      id: 0,
      r: [1.0, T.width - R - 0.01, R],
      v: [vx, vy, 0],
      w: [-vy / R, vx / R, wz],
      s: 'rolling',
    }
    const res = evolveSystem(T, [b])
    const e = res.events.find((x) => x.type === 'cushion')!
    const o = e.balls[0]
    return { out: o, outDeg: deg(Math.atan2(o.v[0], -o.v[1])), speedRatio: Math.hypot(o.v[0], o.v[1]) / speed }
  }

  it('P11: 수직 입사는 수직으로 돌아오고 속도는 줄어든다', () => {
    const r = bounce(1.5, 0, 0)
    expect(Math.abs(r.outDeg)).toBeLessThan(1e-6)
    expect(r.speedRatio).toBeGreaterThan(0.5)
    expect(r.speedRatio).toBeLessThan(0.995)
  })

  it('P12: 순회전은 반사각을 길게, 역회전은 짧게 만든다', () => {
    // +x 로 진행하며 +y 쿠션에 맞을 때, 쿠션을 타고 구르는 방향의 회전(wz > 0)이 순회전이다.
    // (접점 p = R y 에서 w x p = -wz R x 이므로 wz > 0 이면 접점 미끄럼이 줄어든다)
    const none = bounce(1.5, 40, 0)
    const running = bounce(1.5, 40, 40)
    const reverse = bounce(1.5, 40, -40)
    expect(running.outDeg).toBeGreaterThan(none.outDeg + 1)
    expect(reverse.outDeg).toBeLessThan(none.outDeg - 1)
  })

  it('P13: 강하게 칠수록 쿠션에서 속도를 더 많이 잃는다', () => {
    expect(bounce(5, 0, 0).speedRatio).toBeLessThan(bounce(1, 0, 0).speedRatio)
  })

  it('쿠션에서 좌우 회전이 변한다', () => {
    const r = bounce(1.5, 40, 0)
    expect(r.out.w[2]).not.toBe(0)
  })
})

describe('P9~P10 고각', () => {
  it('P9: 고각 + 오른쪽 당점은 공이 오른쪽으로 휜다 (마세)', () => {
    const res = simulate(T, [makeBall(0, 0.5, 0.7, T)], shot({ theta: 55 * DEG, side: 0.35, speed: 2.5 }))
    const start = res.events[0].balls[0]
    const startAng = Math.atan2(start.v[1], start.v[0])
    const roll = firstState(res, 0, (b) => b.s === 'rolling')!
    const endAng = Math.atan2(roll.v[1], roll.v[0])
    // 처음에는 스쿼트로 왼쪽, 최종 진행 방향은 그보다 오른쪽(시계 방향)
    expect(deg(startAng - endAng)).toBeGreaterThan(3)
    expect(endAng).toBeLessThan(0)
  })

  it('P9: 미끄럼 구간의 궤적은 포물선(일정 가속도)이다', () => {
    const res = simulate(T, [makeBall(0, 0.5, 0.7, T)], shot({ theta: 30 * DEG, side: 0.3, speed: 1.5 }))
    const i = res.events.findIndex((e) => e.balls[0].s === 'sliding')
    const t0 = res.events[i].t
    const t1 = res.events[i + 1].t
    const h = (t1 - t0) / 4
    const p = [0, 1, 2, 3, 4].map((k) => stateAt(T, res, t0 + k * h * 0.999)[0].r)
    // 일정 가속도면 2차 차분이 일정하다
    for (const ax of [0, 1]) {
      const d1 = p[2][ax] - 2 * p[1][ax] + p[0][ax]
      const d2 = p[3][ax] - 2 * p[2][ax] + p[1][ax]
      const d3 = p[4][ax] - 2 * p[3][ax] + p[2][ax]
      expect(d1).toBeCloseTo(d2, 10)
      expect(d2).toBeCloseTo(d3, 10)
    }
  })

  it('P10: 고각으로 강하게 치면 점프하고, 수평으로 치면 뜨지 않는다', () => {
    const jump = simulate(T, [makeBall(0, 0.5, 0.7, T)], shot({ theta: 35 * DEG, speed: 4 }))
    expect(jump.events.some((e) => e.balls[0].s === 'airborne')).toBe(true)
    const flat = simulate(T, [makeBall(0, 0.5, 0.7, T)], shot({ theta: 0, speed: 4 }))
    expect(flat.events.some((e) => e.balls[0].s === 'airborne')).toBe(false)
  })

  it('P10: 점프한 공은 앞의 공을 넘어갈 수 있다', () => {
    const balls = [makeBall(0, 0.5, 0.7, T), makeBall(1, 0.5 + 0.12, 0.7, T)]
    const res = simulate(T, balls, shot({ theta: 45 * DEG, speed: 5 }))
    const first = res.events.find((e) => e.type === 'ball-ball')
    // 바로 앞의 공과 부딪히지 않거나, 부딪히더라도 공중에서 부딪힌다
    if (first) expect(first.balls[0].r[2]).toBeGreaterThan(R)
    expect(res.truncated).toBe(false)
  })
})

describe('P14~P16 전체 시뮬레이션', () => {
  function lcg(seed: number) {
    let s = seed >>> 0
    return () => {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0
      return s / 4294967296
    }
  }
  function layout() {
    return [makeBall(0, 0.7, 0.4, T), makeBall(1, 2.1, 0.71, T), makeBall(2, 1.4, 1.0, T)]
  }
  function randomShot(rnd: () => number): ShotInput {
    return shot({
      phi: rnd() * 2 * Math.PI,
      theta: rnd() < 0.8 ? rnd() * 10 * DEG : rnd() * 80 * DEG,
      side: (rnd() - 0.5) * 0.9,
      top: (rnd() - 0.5) * 0.9,
      speed: 0.3 + rnd() * 7,
      accel: (rnd() - 0.5) * 60,
    })
  }

  it('P14, P16: 무작위 샷 500개에서 에너지가 늘지 않고, 공이 테이블을 벗어나거나 겹치지 않는다', () => {
    const rnd = lcg(12345)
    let collisions = 0
    for (let n = 0; n < 500; n++) {
      const res = simulate(T, layout(), randomShot(rnd))
      expect(res.truncated).toBe(false)
      let prev = Infinity
      for (const e of res.events) {
        const en = e.balls.reduce((s, b) => s + energy(b, T), 0)
        expect(Number.isFinite(en)).toBe(true)
        expect(en).toBeLessThanOrEqual(prev + 1e-7)
        prev = en
        if (e.type === 'ball-ball') collisions++
      }
      for (const b of res.final) {
        if (b.s === 'out') continue
        expect(b.s).toBe('stationary')
        // 공 중심은 쿠션 코에 닿는 거리(reach)까지만 갈 수 있다
        const reach = cushionReach(T)
        expect(b.r[0]).toBeGreaterThan(reach - 1e-6)
        expect(b.r[0]).toBeLessThan(T.length - reach + 1e-6)
        expect(b.r[1]).toBeGreaterThan(reach - 1e-6)
        expect(b.r[1]).toBeLessThan(T.width - reach + 1e-6)
        expect(b.r[2]).toBe(R)
      }
      const f = res.final.filter((b) => b.s !== 'out')
      for (let i = 0; i < f.length; i++)
        for (let j = i + 1; j < f.length; j++) {
          const d = Math.hypot(f[i].r[0] - f[j].r[0], f[i].r[1] - f[j].r[1])
          expect(d).toBeGreaterThan(2 * R - 1e-6)
        }
    }
    expect(collisions).toBeGreaterThan(100)
  })

  it('P15: 같은 입력은 같은 해시를 낸다', () => {
    const rnd = lcg(777)
    for (let n = 0; n < 50; n++) {
      const s = randomShot(rnd)
      const a = simulate(T, layout(), s)
      const b = simulate(T, layout(), s)
      expect(a.hash).toBe(b.hash)
      expect(a.events.length).toBe(b.events.length)
    }
  })

  it('P15: 입력이 조금만 달라도 해시가 달라진다', () => {
    const a = simulate(T, layout(), shot({ phi: 0.3, speed: 3 }))
    const b = simulate(T, layout(), shot({ phi: 0.3 + 1e-12, speed: 3 }))
    expect(a.hash).not.toBe(b.hash)
  })

  it('P16: 붙어 있는 공을 쳐도 정상 처리된다', () => {
    const balls = [makeBall(0, 1, 0.7, T), makeBall(1, 1 + 2 * R, 0.7, T), makeBall(2, 1 + 4 * R, 0.7, T)]
    const res = simulate(T, balls, shot({ speed: 3 }))
    expect(res.truncated).toBe(false)
    expect(res.events.filter((e) => e.type === 'ball-ball').length).toBeGreaterThanOrEqual(2)
    // 맨 앞 공이 대부분의 속도를 받아 나가고, 수구는 거의 멈춘다
    const last = res.events.filter((e) => e.type === "ball-ball")[1]
    expect(last.t).toBeLessThan(1e-12)
    expect(last.balls[2].v[0]).toBeGreaterThan(3)
    expect(Math.abs(last.balls[0].v[0])).toBeLessThan(0.3)
  })

  it('P16: 쿠션에 붙은 공을 쿠션 쪽으로, 쿠션을 따라 쳐도 정상 처리된다', () => {
    for (const phi of [90, 60, 10, 0, -30].map((d) => d * DEG)) {
      const res = simulate(T, [makeBall(0, 1, T.width - R, T)], shot({ phi, speed: 3, side: 0.3 }))
      expect(res.truncated).toBe(false)
      expect(res.final[0].s).toBe('stationary')
      expect(res.final[0].r[1]).toBeLessThanOrEqual(T.width - R + 1e-9)
    }
  })

  it('P16: 구석으로 친 공도 정상 처리된다', () => {
    const res = simulate(T, [makeBall(0, 0.2, 0.2, T)], shot({ phi: 225 * DEG, speed: 5, side: 0.4, top: 0.3 }))
    expect(res.truncated).toBe(false)
    expect(res.final[0].s).toBe('stationary')
  })

  it('stateAt 은 이벤트 사이에서 연속이다', () => {
    const res = simulate(T, layout(), shot({ phi: 0.21, speed: 4, side: 0.3, top: 0.2 }))
    for (let i = 1; i < res.events.length; i++) {
      const e = res.events[i]
      const before = stateAt(T, res, e.t - 1e-9)
      for (const b of e.balls) {
        const p = before.find((x) => x.id === b.id)!
        expect(Math.hypot(p.r[0] - b.r[0], p.r[1] - b.r[1], p.r[2] - b.r[2])).toBeLessThan(1e-6)
      }
    }
  })

  it('성능: 3구 샷 하나의 계산이 충분히 빠르다', () => {
    const rnd = lcg(99)
    const shots = Array.from({ length: 300 }, () => randomShot(rnd))
    const t0 = performance.now()
    for (const s of shots) simulate(T, layout(), s)
    const per = (performance.now() - t0) / shots.length
    console.log(`샷당 평균 ${per.toFixed(3)} ms`)
    expect(per).toBeLessThan(5)
  })
})
