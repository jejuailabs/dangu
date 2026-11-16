/**
 * 큐의 기하: 화면에 큐를 그릴 때와, 큐가 쿠션·다른 공에 걸리는지 볼 때 쓴다.
 * 좌표는 물리 코어와 같다 (x 긴 변, y 짧은 변, z 위).
 */
import type { BallState, TableProfile } from '../../physics/src'

export type V3 = [number, number, number]

export const CUE_LENGTH = 1.42
export const CUE_TIP_RADIUS = 0.006
export const CUE_BUTT_RADIUS = 0.014
/** 레일 윗면 높이 (경기면 기준, m) */
export const RAIL_TOP = 0.041

export interface CueFrame {
  /** 큐 진행 방향 */
  q: V3
  /** 공 중심에서 접점까지 */
  p: V3
}

/** 물리 코어의 큐 타격과 같은 방식으로 큐 방향과 접점을 구한다 (당점은 큐 축을 따라 본 평면 기준). */
export function cueFrame(R: number, phi: number, theta: number, side: number, top: number): CueFrame {
  const cp = Math.cos(phi)
  const sp = Math.sin(phi)
  const ct = Math.cos(theta)
  const st = Math.sin(theta)
  const rgt: V3 = [sp, -cp, 0]
  const q: V3 = [ct * cp, ct * sp, -st]
  const up: V3 = [st * cp, st * sp, ct]
  let off = Math.hypot(side, top)
  let s = side
  let t = top
  if (off > 0.9) {
    s *= 0.9 / off
    t *= 0.9 / off
    off = 0.9
  }
  const c = R * Math.sqrt(1 - off * off)
  return {
    q,
    p: [
      s * R * rgt[0] + t * R * up[0] - c * q[0],
      s * R * rgt[1] + t * R * up[1] - c * q[1],
      s * R * rgt[2] + t * R * up[2] - c * q[2],
    ],
  }
}

/** 주어진 고각에서 큐가 레일, 바닥, 다른 공에 걸리는가 */
function blocked(
  table: TableProfile,
  balls: BallState[],
  cue: BallState,
  phi: number,
  theta: number,
  side: number,
  top: number,
): boolean {
  const R = table.R
  const { q, p } = cueFrame(R, phi, theta, side, top)
  const tip: V3 = [cue.r[0] + p[0], cue.r[1] + p[1], cue.r[2] + p[2]]
  const steps = 48
  for (let i = 1; i <= steps; i++) {
    const d = (CUE_LENGTH * i) / steps
    const rad = CUE_TIP_RADIUS + ((CUE_BUTT_RADIUS - CUE_TIP_RADIUS) * i) / steps
    const x = tip[0] - q[0] * d
    const y = tip[1] - q[1] * d
    const z = tip[2] - q[2] * d
    const inside = x > 0 && x < table.length && y > 0 && y < table.width
    // 테이블 안에서는 바닥, 밖에서는 레일 윗면 위로 지나가야 한다
    if (z - rad < (inside ? 0.001 : RAIL_TOP + 0.002)) return true
    // 레일 폭(약 17cm)을 지나면 더 볼 필요 없다
    const beyond = Math.max(-x, x - table.length, -y, y - table.width)
    if (beyond > 0.17) break
    for (const b of balls) {
      if (b.id === cue.id || b.s === 'out') continue
      if (Math.hypot(b.r[0] - x, b.r[1] - y, b.r[2] - z) < R + rad + 0.001) return true
    }
  }
  return false
}

/**
 * 큐가 걸리지 않는 최소 고각 (rad). 실제처럼 쿠션 근처나 다른 공 뒤에서는 큐를 들어야 한다.
 * wanted 가 이미 걸리지 않으면 wanted 를 그대로 돌려준다.
 */
export function clearElevation(
  table: TableProfile,
  balls: BallState[],
  cue: BallState,
  phi: number,
  wanted: number,
  side: number,
  top: number,
): number {
  const step = Math.PI / 180
  for (let th = wanted; th <= Math.PI / 2 - step; th += step) {
    if (!blocked(table, balls, cue, phi, th, side, top)) return th
  }
  return Math.PI / 2 - step
}
