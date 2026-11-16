import { dexp } from '../math/dmath'
import { cross, dot, type Vec3 } from '../math/vec'
import { FREEZE_SPEED, normalize, tableImpact, tiltAccel } from '../motion'
import type { BallState, TableProfile } from '../types'

/** 닿은 채 가속도로만 가까워지는 두 공을 떼어 놓는 속도 (m/s) */
const MIN_SEPARATION = 1e-3
/** 다른 공 위에 얹힌 공을 옆으로 미는 속도 (m/s) */
const ROLL_OFF_SPEED = 0.05

function settle(b: BallState, t: TableProfile): void {
  if (b.s !== 'airborne') {
    // 바닥 위의 공: 아래로 눌린 성분은 바닥에서 반발하고, 기준 미만의 작은 튐은 무시한다.
    if (b.v[2] < 0) tableImpact(b, t, false)
    else if (b.v[2] < t.hopThreshold) b.v[2] = 0
  }
  normalize(b, t)
}

/**
 * 공-공 충돌 (PRD 02 §4.2). 마찰이 있는 비탄성 임펄스 모델.
 *
 * - 법선 방향: 반발계수 e.
 * - 접선 방향: 쿨롱 마찰. 접점 미끄럼을 멈추는 데 필요한 양을 넘지 않는다.
 *   같은 질량의 두 구에서 접선 유효 역질량은 7/m 이므로 멈춤 임펄스는 m |vt| / 7.
 * - 마찰 계수는 접점 미끄럼 속도에 따라 변한다: mu = a + b exp(-c vt).
 *
 * 이 모델에서 스로우(두께 틀어짐)와 회전 전달이 나온다.
 * 아래 임펄스 값은 모두 단위 질량당(= 속도 변화량) 이다.
 */
export function collideBalls(a: BallState, b: BallState, t: TableProfile): number {
  const R = t.R
  const dx = b.r[0] - a.r[0]
  const dy = b.r[1] - a.r[1]
  const dz = b.r[2] - a.r[2]
  const dl = Math.sqrt(dx * dx + dy * dy + dz * dz)
  const n: Vec3 = [dx / dl, dy / dl, dz / dl]

  // 접점에서 a 의 표면 속도 - b 의 표면 속도
  const wsum: Vec3 = [a.w[0] + b.w[0], a.w[1] + b.w[1], a.w[2] + b.w[2]]
  const wxn = cross(wsum, n)
  const vrel: Vec3 = [
    a.v[0] - b.v[0] + R * wxn[0],
    a.v[1] - b.v[1] + R * wxn[1],
    a.v[2] - b.v[2] + R * wxn[2],
  ]
  const vn = dot(vrel, n)
  const resting = (x: BallState) => x.held === true || x.s === 'stationary' || x.s === 'spinning'
  const aWasResting = resting(a)
  const bWasResting = resting(b)
  a.held = false
  b.held = false
  a.ride = 0
  b.ride = 0

  if (vn <= 0) {
    // 닿아 있는 두 공이 속도가 아니라 가속도 때문에 서로를 향하는 경우다
    // (기울기에 눌리거나, 휘는 공이 붙어 있는 공 쪽으로 꺾이는 경우). 아주 작게 떼어 놓는다.
    for (let i = 0; i < 3; i++) {
      a.v[i] -= 0.5 * MIN_SEPARATION * n[i]
      b.v[i] += 0.5 * MIN_SEPARATION * n[i]
    }
    // 한 공이 다른 공 위에 얹힌 경우: 위의 공을 옆으로 밀어 굴러떨어지게 한다.
    if (Math.abs(n[2]) > 0.1) {
      const hl = Math.sqrt(n[0] * n[0] + n[1] * n[1])
      const hx = hl > 1e-9 ? n[0] / hl : 1
      const hy = hl > 1e-9 ? n[1] / hl : 0
      if (n[2] > 0) {
        b.v[0] += ROLL_OFF_SPEED * hx
        b.v[1] += ROLL_OFF_SPEED * hy
      } else {
        a.v[0] -= ROLL_OFF_SPEED * hx
        a.v[1] -= ROLL_OFF_SPEED * hy
      }
    }
  }

  const jn = vn > 0 ? 0.5 * (1 + t.eBall) * vn : 0

  const vt: Vec3 = [vrel[0] - vn * n[0], vrel[1] - vn * n[1], vrel[2] - vn * n[2]]
  const st = Math.sqrt(dot(vt, vt))
  let jt = 0
  let td: Vec3 = [0, 0, 0]
  if (st > 1e-12) {
    const mu = t.muBallA + t.muBallB * dexp(-t.muBallC * st)
    jt = Math.min(mu * jn, st / 7)
    td = [vt[0] / st, vt[1] / st, vt[2] / st]
  }

  for (let i = 0; i < 3; i++) {
    a.v[i] += -jn * n[i] - jt * td[i]
    b.v[i] += jn * n[i] + jt * td[i]
  }
  // 두 공 모두 같은 방향의 회전 변화를 받는다: -(5 jt / 2R) (n x td)
  const nxt = cross(n, td)
  const k = (-5 * jt) / (2 * R)
  for (let i = 0; i < 3; i++) {
    a.w[i] += k * nxt[i]
    b.w[i] += k * nxt[i]
  }

  // 기울어진 테이블: 둘 다 거의 멈췄고 중력이 한 공을 다른 공 쪽으로 밀고 있으면 기대어 멈춘다.
  const [gx, gy] = tiltAccel(t)
  if (gx !== 0 || gy !== 0) {
    const slow = (x: BallState) => Math.sqrt(x.v[0] * x.v[0] + x.v[1] * x.v[1]) < FREEZE_SPEED
    if (slow(a) && slow(b) && a.s !== 'airborne' && b.s !== 'airborne') {
      const push = gx * n[0] + gy * n[1]
      const leaner = push > 0 ? a : push < 0 ? b : null
      if (leaner) {
        leaner.v = [0, 0, 0]
        leaner.w = [0, 0, 0]
        leaner.held = true
        // 받쳐 주는 공이 이미 멈춰 있었다면 그대로 둔다.
        const support = leaner === a ? b : a
        if (leaner === a ? bWasResting : aWasResting) {
          support.v = [0, 0, 0]
          support.w = [0, 0, 0]
          support.held = true
        }
      }
    }
  }

  settle(a, t)
  settle(b, t)
  return vn
}
