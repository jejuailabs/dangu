import type { Vec3 } from './math/vec'
import type { BallState, TableProfile } from './types'

/** 이 값보다 작은 속도·미끄럼은 0 으로 본다 */
export const EPS_V = 1e-7
export const EPS_W = 1e-6
const EPS_Z = 1e-9

/**
 * 기울어진 테이블에서, 접촉 직후 이 속도(m/s)보다 느리고 중력이 접촉 쪽으로 밀고 있으면
 * 그 자리에 기대어 멈춘 것으로 본다. 무한히 작아지는 되튐을 끝내기 위한 기준이다.
 */
export const FREEZE_SPEED = 0.01

/** 기울기 때문에 진행 방향이 바뀌는 구간에서, 한 구간의 최대 방향 변화 (rad) */
const SEG_ANGLE = 0.02
const SEG_MIN = 1e-3
/** 멈춘 공이 기울기로 굴러가기 시작할 때의 첫 구간 길이 (s) */
const START_SEG = 0.02

export function cloneBall(b: BallState): BallState {
  const n: BallState = {
    id: b.id,
    r: [b.r[0], b.r[1], b.r[2]],
    v: [b.v[0], b.v[1], b.v[2]],
    w: [b.w[0], b.w[1], b.w[2]],
    s: b.s,
  }
  if (b.held) n.held = true
  if (b.ride) n.ride = b.ride
  return n
}

/** 쿠션 번호(0: x-, 1: x+, 2: y-, 3: y+)별 바깥쪽 법선 */
export const WALL_NORMALS: [number, number][] = [
  [-1, 0],
  [1, 0],
  [0, -1],
  [0, 1],
]

/** 타고 있는 쿠션 쪽을 향하는 가속 성분을 없앤다 (쿠션이 받쳐 주므로). */
function rideFilter(a: [number, number], ride: number | undefined): void {
  if (!ride) return
  for (let k = 0; k < 4; k++) {
    if (!(ride & (1 << k))) continue
    const n = WALL_NORMALS[k]
    const d = a[0] * n[0] + a[1] * n[1]
    if (d > 0) {
      a[0] -= d * n[0]
      a[1] -= d * n[1]
    }
  }
}

/** 구르는 공을 미는 중력 경사 성분 (회전 관성 때문에 5/7). 타고 있는 쿠션 쪽 성분은 뺀다. */
function rollDrive(b: BallState, t: TableProfile): [number, number] {
  const d: [number, number] = [(5 / 7) * t.g * t.tiltX, (5 / 7) * t.g * t.tiltY]
  rideFilter(d, b.ride)
  return d
}

/** 바닥 접점의 미끄럼 속도 u = v + R (k x w) 의 수평 성분 */
export function slipVelocity(b: BallState, R: number): [number, number] {
  return [b.v[0] - R * b.w[1], b.v[1] + R * b.w[0]]
}

/** 기울기에 의한 중력의 수평 가속도 */
export function tiltAccel(t: TableProfile): [number, number] {
  return [t.g * t.tiltX, t.g * t.tiltY]
}

/** 멈춘 공이 기울기만으로 굴러가기 시작하는가 */
function tiltStarts(b: BallState, t: TableProfile): boolean {
  if (t.tiltX === 0 && t.tiltY === 0) return false
  const [dx, dy] = rollDrive(b, t)
  return Math.sqrt(dx * dx + dy * dy) > t.muRoll * t.g
}

/**
 * 속도와 회전을 보고 운동 상태를 정하고, 아주 작은 잔여값을 정리한다.
 * 충돌이나 전이 직후에 호출한다. 공을 직접 수정한다.
 */
export function normalize(b: BallState, t: TableProfile): void {
  if (b.s === 'out') return
  const R = t.R
  if (b.r[2] > R + EPS_Z || b.v[2] > 0) {
    b.s = 'airborne'
    return
  }
  b.r[2] = R
  b.v[2] = 0
  const [ux, uy] = slipVelocity(b, R)
  const u = Math.sqrt(ux * ux + uy * uy)
  if (u > EPS_V) {
    b.s = 'sliding'
    return
  }
  const sp = Math.sqrt(b.v[0] * b.v[0] + b.v[1] * b.v[1])
  if (sp > EPS_V) {
    b.s = 'rolling'
    b.w[0] = -b.v[1] / R
    b.w[1] = b.v[0] / R
    return
  }
  b.v[0] = 0
  b.v[1] = 0
  b.w[0] = 0
  b.w[1] = 0
  if (!b.held && tiltStarts(b, t)) {
    // 기울기가 구름 저항을 이기면 멈춘 공도 굴러가기 시작한다.
    b.s = 'rolling'
    return
  }
  if (Math.abs(b.w[2]) > EPS_W) {
    b.s = 'spinning'
    return
  }
  b.w[2] = 0
  b.s = 'stationary'
}

/**
 * 현재 상태에서의 가속도. 구간 안에서는 일정하다고 본다.
 *
 * 수평 테이블에서는 미끄럼·구름 모두 마찰 방향이 변하지 않아 정확히 일정하다.
 * 기울어진 테이블에서는 방향이 조금씩 변하므로 transitionTime 이 구간을 짧게 끊는다.
 * 구르는 공에 작용하는 중력 경사 성분은 회전 관성 때문에 5/7 만 가속에 쓰인다.
 */
export function acceleration(b: BallState, t: TableProfile): Vec3 {
  const a = rawAcceleration(b, t)
  if (b.ride && b.s !== 'airborne') {
    const h: [number, number] = [a[0], a[1]]
    rideFilter(h, b.ride)
    a[0] = h[0]
    a[1] = h[1]
  }
  return a
}

/** 쿠션의 받침을 고려하지 않은 가속도 */
function rawAcceleration(b: BallState, t: TableProfile): Vec3 {
  const [gx, gy] = tiltAccel(t)
  switch (b.s) {
    case 'sliding': {
      const [ux, uy] = slipVelocity(b, t.R)
      const u = Math.sqrt(ux * ux + uy * uy)
      const k = (-t.muSlide * t.g) / u
      return [ux * k + gx, uy * k + gy, 0]
    }
    case 'rolling': {
      const sp = Math.sqrt(b.v[0] * b.v[0] + b.v[1] * b.v[1])
      if (sp > EPS_V) {
        const k = (-t.muRoll * t.g) / sp
        return [b.v[0] * k + (5 / 7) * gx, b.v[1] * k + (5 / 7) * gy, 0]
      }
      // 멈춘 상태에서 기울기로 출발
      const [dx, dy] = rollDrive(b, t)
      const dl = Math.sqrt(dx * dx + dy * dy)
      const mag = dl - t.muRoll * t.g
      if (dl === 0 || mag <= 0) return [0, 0, 0]
      return [(dx / dl) * mag, (dy / dl) * mag, 0]
    }
    case 'airborne':
      return [gx, gy, -t.g]
    default:
      return [0, 0, 0]
  }
}

/**
 * 쿠션을 타고 있는 공이 아직 그 쿠션에 눌려 있는지 확인하고, 아니면 풀어 준다.
 * 매 이벤트 전에 호출한다.
 */
export function refreshRide(b: BallState, t: TableProfile, reach: number): void {
  if (!b.ride) return
  if (b.s === 'airborne' || b.s === 'out') {
    b.ride = 0
    return
  }
  // 멈춘 공은 중력 경사 성분이, 움직이는 공은 실제 가속도가 쿠션 쪽을 향해야 한다.
  const moving = b.s === 'sliding' || b.s === 'rolling'
  const a = moving ? rawAcceleration({ ...b, ride: 0 }, t) : [t.g * t.tiltX, t.g * t.tiltY, 0]
  const gaps = [b.r[0] - reach, t.length - reach - b.r[0], b.r[1] - reach, t.width - reach - b.r[1]]
  let ride = b.ride
  for (let k = 0; k < 4; k++) {
    if (!(ride & (1 << k))) continue
    const n = WALL_NORMALS[k]
    const vn = b.v[0] * n[0] + b.v[1] * n[1]
    if (a[0] * n[0] + a[1] * n[1] <= 0 || gaps[k] > 1e-6 || vn < -1e-9) ride &= ~(1 << k)
  }
  if (ride !== b.ride) {
    b.ride = ride
    normalize(b, t)
  }
}

/** 현재 구간이 끝나는 시각까지 남은 시간 (상태 전이, 또는 기울기에 의한 구간 분할) */
export function transitionTime(b: BallState, t: TableProfile): number {
  const tilted = t.tiltX !== 0 || t.tiltY !== 0
  switch (b.s) {
    case 'sliding': {
      const [ux, uy] = slipVelocity(b, t.R)
      const u = Math.sqrt(ux * ux + uy * uy)
      const tSlip = (2 * u) / (7 * t.muSlide * t.g)
      if (!tilted) return tSlip
      // 중력 경사 성분 중 미끄럼 방향에 수직인 부분이 미끄럼 방향을 돌린다.
      const [gx, gy] = tiltAccel(t)
      const perp = Math.abs((gx * uy - gy * ux) / u)
      if (perp === 0) return tSlip
      return Math.min(tSlip, Math.max(SEG_MIN, (SEG_ANGLE * u) / perp))
    }
    case 'rolling': {
      const sp = Math.sqrt(b.v[0] * b.v[0] + b.v[1] * b.v[1])
      if (!tilted) return sp / (t.muRoll * t.g)
      const a = acceleration(b, t)
      if (sp <= EPS_V) return a[0] === 0 && a[1] === 0 ? Infinity : START_SEG
      const along = (a[0] * b.v[0] + a[1] * b.v[1]) / sp
      const tStop = along < 0 ? sp / -along : Infinity
      const perp = Math.abs((a[0] * b.v[1] - a[1] * b.v[0]) / sp)
      const seg = perp > 0 ? Math.max(SEG_MIN, (SEG_ANGLE * sp) / perp) : 1
      return Math.min(tStop, seg, 1)
    }
    case 'spinning':
      return Math.abs(b.w[2]) / t.spinDecel
    case 'airborne': {
      const h = b.r[2] - t.R
      const vz = b.v[2]
      return (vz + Math.sqrt(vz * vz + 2 * t.g * (h > 0 ? h : 0))) / t.g
    }
    default:
      return Infinity
  }
}

function decaySpin(wz: number, decel: number, dt: number): number {
  const d = decel * dt
  if (wz > d) return wz - d
  if (wz < -d) return wz + d
  return 0
}

/**
 * 공을 dt 만큼 해석식으로 진행시킨 새 상태를 돌려준다.
 * dt 는 이 공의 transitionTime 이하여야 한다. 상태(s)는 바꾸지 않는다.
 */
export function evolve(b: BallState, t: TableProfile, dt: number): BallState {
  const n = cloneBall(b)
  if (dt === 0) return n
  const R = t.R
  switch (b.s) {
    case 'sliding': {
      const a = acceleration(b, t)
      n.r[0] = b.r[0] + b.v[0] * dt + 0.5 * a[0] * dt * dt
      n.r[1] = b.r[1] + b.v[1] * dt + 0.5 * a[1] * dt * dt
      n.v[0] = b.v[0] + a[0] * dt
      n.v[1] = b.v[1] + a[1] * dt
      // 마찰 토크: dw/dt = (5 mu g / 2R) (k x u^)
      const [ux, uy] = slipVelocity(b, R)
      const u = Math.sqrt(ux * ux + uy * uy)
      const k = (5 * t.muSlide * t.g) / (2 * R * u)
      n.w[0] = b.w[0] - k * uy * dt
      n.w[1] = b.w[1] + k * ux * dt
      n.w[2] = decaySpin(b.w[2], t.spinDecel, dt)
      break
    }
    case 'rolling': {
      const a = acceleration(b, t)
      n.r[0] = b.r[0] + b.v[0] * dt + 0.5 * a[0] * dt * dt
      n.r[1] = b.r[1] + b.v[1] * dt + 0.5 * a[1] * dt * dt
      n.v[0] = b.v[0] + a[0] * dt
      n.v[1] = b.v[1] + a[1] * dt
      n.w[0] = -n.v[1] / R
      n.w[1] = n.v[0] / R
      n.w[2] = decaySpin(b.w[2], t.spinDecel, dt)
      break
    }
    case 'spinning':
      n.w[2] = decaySpin(b.w[2], t.spinDecel, dt)
      break
    case 'airborne': {
      const a = acceleration(b, t)
      n.r[0] = b.r[0] + b.v[0] * dt + 0.5 * a[0] * dt * dt
      n.r[1] = b.r[1] + b.v[1] * dt + 0.5 * a[1] * dt * dt
      n.r[2] = b.r[2] + b.v[2] * dt + 0.5 * a[2] * dt * dt
      n.v[0] = b.v[0] + a[0] * dt
      n.v[1] = b.v[1] + a[1] * dt
      n.v[2] = b.v[2] + a[2] * dt
      break
    }
    default:
      break
  }
  return n
}

/**
 * 공이 바닥에 부딪힐 때(착지, 또는 아래로 눌렸을 때)의 처리.
 * 수직 속도는 반발계수로 튀고, withFriction 이면 접점 마찰 임펄스도 적용한다.
 */
export function tableImpact(b: BallState, t: TableProfile, withFriction: boolean): void {
  const R = t.R
  b.r[2] = R
  const vn = -b.v[2]
  if (vn <= 0) return
  if (withFriction) {
    const [ux, uy] = slipVelocity(b, R)
    const u = Math.sqrt(ux * ux + uy * uy)
    if (u > EPS_V) {
      // 단위 질량당 마찰 임펄스. 미끄럼을 멈추는 데 필요한 양(2/7 u)을 넘지 않는다.
      const d = Math.min(t.muSlide * (1 + t.eTable) * vn, (2 / 7) * u)
      const ex = ux / u
      const ey = uy / u
      b.v[0] -= d * ex
      b.v[1] -= d * ey
      const k = (5 * d) / (2 * R)
      b.w[0] -= k * ey
      b.w[1] += k * ex
    }
  }
  const up = t.eTable * vn
  b.v[2] = up >= t.hopThreshold ? up : 0
}

/** 전이 시각에 도달한 공의 상태를 다음 상태로 넘긴다. */
export function finishTransition(b: BallState, t: TableProfile): void {
  if (b.s === 'spinning') b.w[2] = 0
  else if (b.s === 'airborne') tableImpact(b, t, true)
  // 미끄럼·구름은 해석식이 이미 끝 상태에 도달해 있다. normalize 가 잔여값을 정리한다.
  normalize(b, t)
}

/** 운동 에너지 + 위치 에너지 (J). 검증용 */
export function energy(b: BallState, t: TableProfile): number {
  if (b.s === 'out') return 0
  const I = 0.4 * t.m * t.R * t.R
  const ke = 0.5 * t.m * (b.v[0] * b.v[0] + b.v[1] * b.v[1] + b.v[2] * b.v[2])
  const re = 0.5 * I * (b.w[0] * b.w[0] + b.w[1] * b.w[1] + b.w[2] * b.w[2])
  // 기울어진 테이블에서는 낮은 쪽으로 갈수록 위치 에너지가 줄어든다.
  const pe = t.m * t.g * (b.r[2] - t.R - t.tiltX * b.r[0] - t.tiltY * b.r[1])
  return ke + re + pe
}
