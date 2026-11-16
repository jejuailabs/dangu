import { dcos, dpow, dsin, PI } from '../math/dmath'
import { cross, dot, type Vec3 } from '../math/vec'
import { normalize, tableImpact } from '../motion'
import type { BallState, ShotInput, TableProfile } from '../types'

/** 미스큐 시 전달되는 임펄스 비율 [초기값] */
const MISCUE_FACTOR = 0.3
/** 당점이 공 밖으로 나가지 않도록 하는 상한 (R 기준) */
const MAX_OFFSET = 0.9
/** CueSpec.contactTime 을 잰 기준 큐 속도 (m/s) */
const REF_SPEED = 2
/** 접촉 구간 적분 단계 수 */
const CONTACT_STEPS = 200

export interface StrikeInfo {
  miscue: boolean
  /** 실제 팁 접촉 시간 (s). 임펄스 모델에서는 0 */
  contactTime: number
  /** 접촉이 끝났을 때의 당점 거리 (R 기준). 접촉 중 공이 돌면서 처음보다 약간 커진다 */
  finalOffset: number
}

interface Frame {
  rgt: Vec3
  q: Vec3
  p: Vec3
  side: number
  off: number
  miscue: boolean
}

/**
 * 조준 방향과 당점에서 큐 방향 q 와 접점 p 를 만든다.
 * 당점(side, top)은 큐 축을 따라 바라본 평면에서 잰다. 고각이 커도 "중심"은 큐 축이
 * 공 중심을 지나는 점이다. 수직(마세)이면 중심은 공의 꼭대기가 된다.
 */
function frame(t: TableProfile, shot: ShotInput): Frame {
  const R = t.R
  const cp = dcos(shot.phi)
  const sp = dsin(shot.phi)
  const ct = dcos(shot.theta)
  const st = dsin(shot.theta)
  const rgt: Vec3 = [sp, -cp, 0]
  const q: Vec3 = [ct * cp, ct * sp, -st]
  const up: Vec3 = [st * cp, st * sp, ct]

  let side = shot.side
  let top = shot.top
  let off = Math.sqrt(side * side + top * top)
  const miscue = off > shot.cue.miscueLimit
  if (off > MAX_OFFSET) {
    side *= MAX_OFFSET / off
    top *= MAX_OFFSET / off
    off = MAX_OFFSET
  }
  const c = R * Math.sqrt(1 - off * off)
  const p: Vec3 = [
    side * R * rgt[0] + top * R * up[0] - c * q[0],
    side * R * rgt[1] + top * R * up[1] - c * q[1],
    side * R * rgt[2] + top * R * up[2] - c * q[2],
  ]
  return { rgt, q, p, side, off, miscue }
}

/**
 * 스쿼트: 좌우 당점의 반대쪽으로 수평 속도를 돌린다.
 * Alciatore TP A-31 형태의 유효 끝 질량 모델 [지식, 재검증].
 */
function applySquirt(v: Vec3, side: number, m: number, endMass: number): void {
  if (side === 0) return
  let s = side
  if (s > MAX_OFFSET) s = MAX_OFFSET
  if (s < -MAX_OFFSET) s = -MAX_OFFSET
  const s2 = s * s
  const tanA = (2.5 * s * Math.sqrt(1 - s2)) / (1 + m / endMass + 2.5 * (1 - s2))
  const cosA = 1 / Math.sqrt(1 + tanA * tanA)
  const sinA = tanA * cosA
  // 오른쪽 당점(side > 0)이면 왼쪽(반시계)으로 회전
  const vx = v[0] * cosA - v[1] * sinA
  const vy = v[0] * sinA + v[1] * cosA
  v[0] = vx
  v[1] = vy
}

/**
 * 스프링-댐퍼 팁의 무차원 1차원 충돌 (질량 1, 강성 1, 초기 접근 속도 1).
 * 힘이 0 이 되는 순간 접촉이 끝난다고 보고, 그때의 반발계수와 접촉 시간(tau = w0 * t)을 돌려준다.
 */
function unitImpact(zeta: number): { e: number; tau: number } {
  const n = 400
  const h = PI / n
  let x = 0
  let u = 1
  let t = 0
  const acc = (xx: number, uu: number) => {
    const F = xx + 2 * zeta * uu
    return F > 0 ? -F : 0
  }
  for (let i = 0; i < n * 4; i++) {
    const k1x = u
    const k1u = acc(x, u)
    const k2x = u + (h / 2) * k1u
    const k2u = acc(x + (h / 2) * k1x, u + (h / 2) * k1u)
    const k3x = u + (h / 2) * k2u
    const k3u = acc(x + (h / 2) * k2x, u + (h / 2) * k2u)
    const k4x = u + h * k3u
    const k4u = acc(x + h * k3x, u + h * k3u)
    const fPrev = x + 2 * zeta * u
    const xN = x + (h / 6) * (k1x + 2 * k2x + 2 * k3x + k4x)
    const uN = u + (h / 6) * (k1u + 2 * k2u + 2 * k3u + k4u)
    const fNew = xN + 2 * zeta * uN
    if (i > 0 && fNew <= 0) {
      // 힘이 0 이 되는 지점을 선형 보간
      const s = fPrev / (fPrev - fNew)
      return { e: -(u + s * (uN - u)), tau: t + s * h }
    }
    x = xN
    u = uN
    t += h
  }
  return { e: -u, tau: t }
}

const calibrationCache = new Map<number, { zeta: number; tau: number }>()

/** 목표 반발계수가 나오는 감쇠비와, 그때의 무차원 접촉 시간을 이분법으로 찾는다. */
function tipCalibration(e: number): { zeta: number; tau: number } {
  const hit = calibrationCache.get(e)
  if (hit) return hit
  let lo = 0
  let hi = 0.95
  for (let i = 0; i < 60; i++) {
    const mid = 0.5 * (lo + hi)
    if (unitImpact(mid).e > e) lo = mid
    else hi = mid
  }
  const zeta = 0.5 * (lo + hi)
  const res = { zeta, tau: unitImpact(zeta).tau }
  calibrationCache.set(e, res)
  return res
}

function finish(b: BallState, t: TableProfile, v: Vec3, w: Vec3): void {
  b.v = v
  b.w = w
  b.held = false
  // 고각으로 아래로 눌린 수직 성분은 바닥에서 반발한다. 충분히 크면 점프가 된다.
  if (b.v[2] < 0) tableImpact(b, t, false)
  normalize(b, t)
}

/**
 * 임펄스 모델: 접촉을 순간으로 본다. 빠르고 닫힌 식이다.
 *   F = (1 + e) V / (1/m + 1/M + |p x q|^2 / I)
 * 임팩트 순간의 가속은 접촉 시간 동안 추가로 밀어주는 양(V + a tc / 2)으로만 반영한다.
 */
export function strikeImpulse(b: BallState, t: TableProfile, shot: ShotInput): StrikeInfo {
  const m = t.m
  const I = 0.4 * m * t.R * t.R
  const f = frame(t, shot)
  const pxq = cross(f.p, f.q)

  let V = shot.speed + 0.5 * (shot.accel ?? 0) * shot.cue.contactTime
  if (V < 0) V = 0
  let F = ((1 + shot.cue.tipRestitution) * V) / (1 / m + 1 / shot.cue.mass + dot(pxq, pxq) / I)
  if (f.miscue) F *= MISCUE_FACTOR

  const v: Vec3 = [(f.q[0] * F) / m, (f.q[1] * F) / m, (f.q[2] * F) / m]
  const w: Vec3 = [(pxq[0] * F) / I, (pxq[1] * F) / I, (pxq[2] * F) / I]
  applySquirt(v, f.side, m, shot.cue.endMass)
  finish(b, t, v, w)
  return { miscue: f.miscue, contactTime: 0, finalOffset: f.off }
}

/**
 * 접촉 모델 (기본): 팁을 스프링-댐퍼로 보고 접촉 시간 동안의 운동을 적분한다 (PRD 02 §4.1).
 *
 * 큐(질량 M, 축 방향으로만 움직임) — 팁 스프링 — 공(병진 + 회전) 의 계를 푼다.
 *   팁 힘       F = k x + c x'      (x: 팁 압축량, 음수 힘은 0 으로)
 *   큐          M V' = -F + M a     (a: 손이 계속 밀어주는 가속도 = 스트로크의 임팩트 가속도)
 *   공          m v' = F q,   I w' = (p x q) F
 *   접점        p' = w x p          (팁이 공 표면에 붙어 공과 함께 돈다)
 *
 * 이 모델에서 나오는 것:
 * - 접촉 시간. 강성은 속도에 따라 k ~ V^0.4 로 키워 헤르츠 접촉처럼 "세게 칠수록 짧은 접촉"
 *   이 되게 했다. 실측 범위(약 0.8~3 ms)와 맞는다.
 * - 접촉 중 공이 돌면서 당점이 바깥으로 밀려나는 효과. 접촉이 길수록(부드러운 팁, 약한 타격)
 *   회전이 조금 더 걸린다.
 * - 임팩트 순간 가속 중이면 조금 더, 감속 중이면 조금 덜 전달되는 효과.
 * 측정 연구대로 뒤의 두 효과는 작다. 타법의 큰 차이는 임팩트 속도와 당점 정확도에서 온다.
 *
 * 강성과 감쇠는 큐 사양에서 정한다: 기준 조건(중심 타격, 2 m/s)에서 접촉 시간이
 * cue.contactTime, 반발계수가 cue.tipRestitution 이 되도록.
 */
export function strike(b: BallState, t: TableProfile, shot: ShotInput): StrikeInfo {
  const R = t.R
  const m = t.m
  const M = shot.cue.mass
  const I = 0.4 * m * R * R
  const f = frame(t, shot)
  const q = f.q

  const V0 = shot.speed > 0 ? shot.speed : 0
  if (V0 === 0) {
    finish(b, t, [0, 0, 0], [0, 0, 0])
    return { miscue: f.miscue, contactTime: 0, finalOffset: f.off }
  }

  // 기준 조건의 환산 질량으로 강성과 감쇠를 정한다.
  const muRef = 1 / (1 / m + 1 / M)
  const { zeta, tau } = tipCalibration(shot.cue.tipRestitution)
  const w0Ref = tau / shot.cue.contactTime
  const k = muRef * w0Ref * w0Ref * dpow(V0 / REF_SPEED, 0.4)
  const cd = 2 * zeta * Math.sqrt(k * muRef)

  const tcEst = PI / Math.sqrt(k / muRef)
  const dt = tcEst / CONTACT_STEPS
  const a = shot.accel ?? 0

  // 상태 벡터 y = [x, Vc, v(3), w(3), p(3)] 를 4차 룽게-쿠타로 적분한다.
  let y = [0, V0, 0, 0, 0, 0, 0, 0, f.p[0], f.p[1], f.p[2]]
  const deriv = (s: number[]): number[] => {
    const wx = s[5]
    const wy = s[6]
    const wz = s[7]
    const px = s[8]
    const py = s[9]
    const pz = s[10]
    // 접점은 공과 함께 돈다: p' = w x p
    const dpx = wy * pz - wz * py
    const dpy = wz * px - wx * pz
    const dpz = wx * py - wy * px
    const vcont = (s[2] + dpx) * q[0] + (s[3] + dpy) * q[1] + (s[4] + dpz) * q[2]
    const closing = s[1] - vcont
    let F = k * s[0] + cd * closing
    if (F < 0) F = 0
    const fm = F / m
    const fi = F / I
    return [
      closing,
      -F / M + a,
      q[0] * fm,
      q[1] * fm,
      q[2] * fm,
      (py * q[2] - pz * q[1]) * fi,
      (pz * q[0] - px * q[2]) * fi,
      (px * q[1] - py * q[0]) * fi,
      dpx,
      dpy,
      dpz,
    ]
  }
  const axpy = (s: number[], d: number[], h: number) => s.map((v0, i) => v0 + d[i] * h)

  let time = 0
  for (let i = 0; i < CONTACT_STEPS * 6; i++) {
    const k1 = deriv(y)
    const k2 = deriv(axpy(y, k1, dt / 2))
    const k3 = deriv(axpy(y, k2, dt / 2))
    const k4 = deriv(axpy(y, k3, dt))
    y = y.map((v0, j) => v0 + (dt / 6) * (k1[j] + 2 * k2[j] + 2 * k3[j] + k4[j]))
    const pl = Math.sqrt(y[8] * y[8] + y[9] * y[9] + y[10] * y[10])
    y[8] = (y[8] * R) / pl
    y[9] = (y[9] * R) / pl
    y[10] = (y[10] * R) / pl
    time += dt
    // 팁은 당기는 힘을 낼 수 없다. 힘이 0 이 되면 접촉이 끝난다.
    const e = deriv(y)
    if (k * y[0] + cd * e[0] <= 0) break
  }
  const v: Vec3 = [y[2], y[3], y[4]]
  const w: Vec3 = [y[5], y[6], y[7]]
  const p: Vec3 = [y[8], y[9], y[10]]

  if (f.miscue) {
    for (let j = 0; j < 3; j++) {
      v[j] *= MISCUE_FACTOR
      w[j] *= MISCUE_FACTOR
    }
  }

  // 접촉 중 당점이 움직였으므로 스쿼트는 처음과 끝의 평균 좌우 당점으로 계산한다.
  const sideEnd = dot(p, f.rgt) / R
  applySquirt(v, 0.5 * (f.side + sideEnd), m, shot.cue.endMass)

  // 큐 축에서 접점까지의 거리
  const pq = dot(p, q)
  const perp: Vec3 = [p[0] - pq * q[0], p[1] - pq * q[1], p[2] - pq * q[2]]
  const finalOffset = Math.sqrt(dot(perp, perp)) / R

  finish(b, t, v, w)
  return { miscue: f.miscue, contactTime: time, finalOffset }
}
