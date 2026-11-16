import { cross, dot, type Vec3 } from '../math/vec'
import { normalize, tiltAccel } from '../motion'
import type { BallState, TableProfile } from '../types'

/** 쿠션에서 떨어지는 최소 속도 (m/s). 쿠션에 붙어 무한히 충돌하는 것을 막는다 */
const MIN_REBOUND = 1e-4
/** 기울어진 테이블에서, 되튐의 법선 속도가 이보다 작으면 쿠션을 타는 것으로 본다 (m/s) */
const RIDE_SPEED = 0.005
/** Mathavan 적분의 기준 단계 수. 논문은 5000 을 썼다 */
const MATHAVAN_STEPS = 2000
const SLIP_EPS = 1e-10

/**
 * 쿠션 코(가장 튀어나온 모서리)와 공 중심의 기하.
 * 접촉 법선 N 은 공 중심에서 쿠션 코를 향한다:
 *   N = cos(a) n + sin(a) z,  sin(a) = (h - z_c) / R
 * 바닥 위의 공은 z_c = R 이라 sin(a) = h/R - 1 이다. 공이 떠 있으면 높이에 따라 달라지고,
 * 공 중심이 코보다 높으면 sin(a) < 0 이 되어 공이 위로 튕긴다.
 */
function contactNormal(b: BallState, t: TableProfile, nOut: Vec3): { N: Vec3; sinA: number; cosA: number } {
  let sinA = (t.cushionHeight - b.r[2]) / t.R
  if (sinA > 1) sinA = 1
  if (sinA < -1) sinA = -1
  const cosA = Math.sqrt(1 - sinA * sinA)
  return { N: [nOut[0] * cosA, nOut[1] * cosA, sinA], sinA, cosA }
}

/** 바닥 위의 공 중심이 쿠션 코의 수직면에 가장 가까이 갈 수 있는 거리 */
export function cushionReach(t: TableProfile): number {
  const q = t.cushionHeight - t.R
  return Math.sqrt(t.R * t.R - q * q)
}

/**
 * Han(2005) 방식의 임펄스 모델.
 *
 * 법선 방향은 반발계수, 접선 방향은 쿨롱 마찰(미끄럼을 멈추는 양 (2/7)|s| 이 상한).
 * 충돌 중 바닥의 반력과 마찰은 무시한다. 한 번의 계산으로 끝나 빠르다.
 * 임펄스 값은 단위 질량당이다.
 */
function resolveHan(b: BallState, t: TableProfile, N: Vec3): void {
  const R = t.R
  const c = dot(b.v, N)
  if (c <= 0) return
  const wxN = cross(b.w, N)
  const vc: Vec3 = [b.v[0] + R * wxN[0], b.v[1] + R * wxN[1], b.v[2] + R * wxN[2]]
  const vcn = dot(vc, N)
  const s: Vec3 = [vc[0] - vcn * N[0], vc[1] - vcn * N[1], vc[2] - vcn * N[2]]
  const sl = Math.sqrt(dot(s, s))

  const e = Math.max(t.eCushionMin, t.eCushion - t.eCushionSlope * c)
  const pn = (1 + e) * c
  let pt = 0
  let td: Vec3 = [0, 0, 0]
  if (sl > 1e-12) {
    pt = Math.min(t.muCushion * pn, (2 / 7) * sl)
    td = [s[0] / sl, s[1] / sl, s[2] / sl]
  }
  const P: Vec3 = [-pn * N[0] - pt * td[0], -pn * N[1] - pt * td[1], -pn * N[2] - pt * td[2]]
  b.v[0] += P[0]
  b.v[1] += P[1]
  b.v[2] += P[2]
  // 회전 변화: (R N) x P / I = (5 / 2R) (N x P)
  const NxP = cross(N, P)
  const k = 5 / (2 * R)
  b.w[0] += k * NxP[0]
  b.w[1] += k * NxP[1]
  b.w[2] += k * NxP[2]
}

/**
 * Mathavan, Jackson, Parkin (2010) "A theoretical analysis of billiard ball dynamics
 * under cushion impacts" 의 모델.
 *
 * 충돌 중 공은 두 점에서 미끄러진다: 쿠션 접점 I 와 바닥 접점 C.
 * 쿠션이 공을 아래로 누르므로 바닥이 반력 P_C 로 받치고, 그 반력에 비례해 바닥 마찰도 생긴다.
 * 미끄럼 방향이 충돌 도중 계속 바뀌므로 쿠션 법선 임펄스 P_I 를 독립 변수로 잘게 나눠 적분한다.
 *
 *   쿠션이 주는 임펄스  dP ( -N + f_I ),      f_I = -mu_w s_I / |s_I|
 *   바닥 반력           dP p_c z,              p_c = -(쿠션 임펄스의 z 성분)   [논문 식 (8)]
 *   바닥 마찰           dP ( -mu_s p_c u_C / |u_C| )
 *
 * 종료 조건은 에너지 기준 반발계수다 [논문 식 (16)]:
 * 압축 단계(법선 속도가 0 이 될 때까지)에 한 일 W_c 를 구하고, 복원 단계의 일이 e^2 W_c 가 되면 끝낸다.
 *
 * 논문과 다른 점:
 * - 미끄럼이 멈추는 순간 마찰이 방향을 바꿔 가며 떨리지 않도록, 한 단계의 마찰 임펄스가
 *   미끄럼을 멈추는 데 필요한 양을 넘지 않게 했다.
 * - 논문은 법선 속도 2.5 m/s 이하에서만 강체 쿠션 가정이 맞는다고 했다. 그보다 빠르면
 *   반발계수를 낮춘다 [초기값].
 *
 * 임펄스 값은 단위 질량당이다. 바닥 위의 공에만 쓴다.
 */
function resolveMathavan(b: BallState, t: TableProfile, N: Vec3): void {
  const R = t.R
  const c0 = dot(b.v, N)
  if (c0 <= 0) return

  let e = t.eCushionEnergetic
  if (c0 > t.cushionRigidLimit) {
    e = Math.max(t.eCushionEnergeticMin, e - t.eCushionEnergeticSlope * (c0 - t.cushionRigidLimit))
  }
  const dp = ((1 + e) * c0) / MATHAVAN_STEPS
  const k = 5 / (2 * R)
  const muW = t.muCushion
  const muS = t.muSlide

  let vx = b.v[0]
  let vy = b.v[1]
  let wx = b.w[0]
  let wy = b.w[1]
  let wz = b.w[2]
  const Nx = N[0]
  const Ny = N[1]
  const Nz = N[2]

  let compressing = true
  let wc = 0
  let wr = 0
  let target = 0
  let c = c0

  for (let i = 0; i < MATHAVAN_STEPS * 20; i++) {
    // 쿠션 접점 I 의 미끄럼: s = v + R (w x N) 에서 법선 성분을 뺀 것 (v_z = 0)
    const ax = wy * Nz - wz * Ny
    const ay = wz * Nx - wx * Nz
    const az = wx * Ny - wy * Nx
    let sx = vx + R * ax
    let sy = vy + R * ay
    let sz = R * az
    const sn = sx * Nx + sy * Ny + sz * Nz
    sx -= sn * Nx
    sy -= sn * Ny
    sz -= sn * Nz
    const sl = Math.sqrt(sx * sx + sy * sy + sz * sz)

    // 쿠션 마찰 (단위 dp 당)
    let fx = 0
    let fy = 0
    let fz = 0
    if (sl > SLIP_EPS) {
      const m = Math.min(muW * dp, (2 / 7) * sl) / (sl * dp)
      fx = -m * sx
      fy = -m * sy
      fz = -m * sz
    }

    // 바닥 반력: 쿠션이 아래로 누르는 만큼 받친다
    let pc = Nz - fz
    if (pc < 0) pc = 0

    // 바닥 접점 C 의 미끄럼과 마찰
    const ux = vx - R * wy
    const uy = vy + R * wx
    const ul = Math.sqrt(ux * ux + uy * uy)
    let gx = 0
    let gy = 0
    if (ul > SLIP_EPS && pc > 0) {
      const m = Math.min(muS * pc * dp, (2 / 7) * ul) / (ul * dp)
      gx = -m * ux
      gy = -m * uy
    }

    // 속도 변화 (수직 성분은 바닥 반력과 상쇄)
    vx += (-Nx + fx + gx) * dp
    vy += (-Ny + fy + gy) * dp
    // 회전 변화: (5/2R) [ N x f_I  +  (-z) x g_C ]
    wx += k * (Ny * fz - Nz * fy + gy) * dp
    wy += k * (Nz * fx - Nx * fz - gx) * dp
    wz += k * (Nx * fy - Ny * fx) * dp

    const cNew = vx * Nx + vy * Ny
    const dW = dp * 0.5 * (c + cNew)
    c = cNew
    if (compressing) {
      wc += dW
      if (c <= 0) {
        compressing = false
        target = e * e * wc
      }
    } else {
      wr -= dW
      if (wr >= target) break
    }
  }

  b.v[0] = vx
  b.v[1] = vy
  b.w[0] = wx
  b.w[1] = wy
  b.w[2] = wz
}

/**
 * 공-쿠션 충돌 (PRD 02 §4.3).
 * 바닥 위의 공은 테이블 프로파일이 정한 모델을, 떠 있는 공은 Han 방식 임펄스 모델을 쓴다.
 *
 * @param nOut 테이블 안에서 쿠션 쪽을 향하는 수평 단위 벡터
 * @param wall 쿠션 번호 (0: x-, 1: x+, 2: y-, 3: y+). 기울어진 테이블의 쿠션 타기 처리에 쓴다
 */
export function collideCushion(b: BallState, t: TableProfile, nOut: Vec3, wall?: number): void {
  const { N } = contactNormal(b, t, nOut)
  b.held = false

  if (b.s === 'airborne') {
    resolveHan(b, t, N)
    normalize(b, t)
    return
  }

  if (t.cushionModel === 'mathavan') resolveMathavan(b, t, N)
  else resolveHan(b, t, N)

  // 바닥 위의 공은 수직 속도를 바닥이 흡수한다.
  b.v[2] = 0

  // 쿠션에서 확실히 떨어지게 한다.
  const vnh = b.v[0] * nOut[0] + b.v[1] * nOut[1]
  if (vnh > -MIN_REBOUND) {
    const fix = -MIN_REBOUND - vnh
    b.v[0] += fix * nOut[0]
    b.v[1] += fix * nOut[1]
  }

  // 기울어진 테이블: 중력이 쿠션 쪽으로 밀고 있고 되튐이 아주 작으면, 튀지 않고 쿠션을 타고 간다.
  // (점점 작아지는 되튐이 끝없이 이어지는 것을 끝낸다)
  const [gx, gy] = tiltAccel(t)
  if (wall !== undefined && gx * nOut[0] + gy * nOut[1] > 0) {
    const vn = b.v[0] * nOut[0] + b.v[1] * nOut[1]
    if (-vn < RIDE_SPEED) {
      b.v[0] -= vn * nOut[0]
      b.v[1] -= vn * nOut[1]
      b.ride = (b.ride ?? 0) | (1 << wall)
    }
  }
  normalize(b, t)
}
