import { collideBalls } from './collide/ballBall'
import { strike } from './collide/cue'
import { collideCushion, cushionReach } from './collide/cushion'
import { hashResult } from './hash'
import { firstDownCrossing } from './math/poly'
import type { Vec3 } from './math/vec'
import {
  acceleration,
  cloneBall,
  evolve,
  finishTransition,
  normalize,
  refreshRide,
  tiltAccel,
  transitionTime,
} from './motion'
import type { BallState, CushionId, EventType, ShotInput, ShotResult, SimEvent, TableProfile } from './types'

const MAX_EVENTS = 5000
/** 기대어 멈춘 공의 받침이 아직 있는지 볼 때의 거리 허용치 (m) */
const SUPPORT_TOL = 1e-6
/** 끼임 감지: 이 시간(s) 안에 이 횟수만큼 접촉이 되풀이되면 끼인 것으로 본다 */
const JAM_WINDOW = 0.005
const JAM_COUNT = 10

const CUSHIONS: { id: CushionId; n: Vec3 }[] = [
  { id: 'x-', n: [-1, 0, 0] },
  { id: 'x+', n: [1, 0, 0] },
  { id: 'y-', n: [0, -1, 0] },
  { id: 'y+', n: [0, 1, 0] },
]

const isMoving = (b: BallState) => b.s === 'sliding' || b.s === 'rolling' || b.s === 'airborne'

/** 테이블 위에 놓인 정지한 공을 만든다. */
export function makeBall(id: number, x: number, y: number, t: TableProfile): BallState {
  return { id, r: [x, y, t.R], v: [0, 0, 0], w: [0, 0, 0], s: 'stationary' }
}

/**
 * 공 중심에서 각 쿠션 코의 수직면까지의 수평 거리를 시간의 2차식 계수로 돌려준다.
 * 순서는 CUSHIONS 와 같다.
 */
function wallGaps(b: BallState, a: Vec3, t: TableProfile): number[][] {
  return [
    [b.r[0], b.v[0], 0.5 * a[0]],
    [t.length - b.r[0], -b.v[0], -0.5 * a[0]],
    [b.r[1], b.v[1], 0.5 * a[1]],
    [t.width - b.r[1], -b.v[1], -0.5 * a[1]],
  ]
}

/**
 * 기울어진 테이블에서 기대어 멈춘 공(held)의 받침이 사라졌으면 풀어 준다.
 * 받침은 중력이 미는 쪽의 쿠션, 또는 그쪽에서 닿아 있는 멈춘 공이다.
 */
function releaseUnsupported(balls: BallState[], t: TableProfile): void {
  const [gx, gy] = tiltAccel(t)
  const reach = cushionReach(t)
  for (const b of balls) {
    if (!b.held) continue
    let supported = false
    if (gx < 0 && b.r[0] <= reach + SUPPORT_TOL) supported = true
    if (gx > 0 && b.r[0] >= t.length - reach - SUPPORT_TOL) supported = true
    if (gy < 0 && b.r[1] <= reach + SUPPORT_TOL) supported = true
    if (gy > 0 && b.r[1] >= t.width - reach - SUPPORT_TOL) supported = true
    if (!supported) {
      for (const o of balls) {
        if (o === b || o.s === 'out' || isMoving(o)) continue
        const dx = o.r[0] - b.r[0]
        const dy = o.r[1] - b.r[1]
        if (Math.sqrt(dx * dx + dy * dy) <= 2 * t.R + SUPPORT_TOL && gx * dx + gy * dy > 0) {
          supported = true
          break
        }
      }
    }
    if (!supported) {
      b.held = false
      normalize(b, t)
    }
  }
}

/**
 * 이벤트 기반 진행 (PRD 02 §6).
 *
 * 각 공은 구간 안에서 일정한 가속도로 움직이므로 위치가 시간의 2차식이다.
 * 다음 이벤트(상태 전이, 공-공 충돌, 공-쿠션 충돌) 시각을 다항식의 근으로 구해
 * 그 시각으로 한 번에 건너뛴다. 고정 타임스텝이 없으므로 터널링과 누적 오차가 없다.
 */
export function evolveSystem(table: TableProfile, initial: BallState[], firstEvent?: SimEvent): ShotResult {
  let balls = initial.map(cloneBall)
  for (const b of balls) if (b.s !== 'out' && b.s !== 'airborne') normalize(b, table)
  const tilted = table.tiltX !== 0 || table.tiltY !== 0
  if (tilted) releaseUnsupported(balls, table)

  const events: SimEvent[] = []
  if (firstEvent) events.push({ ...firstEvent, balls: balls.map(cloneBall) })
  let time = 0
  let truncated = false
  const R = table.R
  const reach = cushionReach(table)
  const h = table.cushionHeight
  const contactTimes: number[][] = balls.map(() => [])

  for (let iter = 0; ; iter++) {
    if (iter >= MAX_EVENTS) {
      truncated = true
      break
    }

    if (tilted) for (const b of balls) refreshRide(b, table, reach)

    // 1. 상태 전이
    const tt = balls.map((b) => transitionTime(b, table))
    let bestT = Infinity
    let kind: EventType = 'transition'
    let bi = -1
    let bj = -1
    let bc = -1
    for (let i = 0; i < balls.length; i++) {
      if (tt[i] < bestT) {
        bestT = tt[i]
        bi = i
      }
    }
    if (bestT === Infinity) break

    const acc = balls.map((b) => acceleration(b, table))

    // 2. 공-공 충돌: |d(t)|^2 - (2R)^2 가 0 이하로 내려가는 시각 (4차식)
    for (let i = 0; i < balls.length; i++) {
      const a = balls[i]
      if (a.s === 'out') continue
      for (let j = i + 1; j < balls.length; j++) {
        const b = balls[j]
        if (b.s === 'out') continue
        if (!isMoving(a) && !isMoving(b)) continue
        const d0: Vec3 = [a.r[0] - b.r[0], a.r[1] - b.r[1], a.r[2] - b.r[2]]
        const d1: Vec3 = [a.v[0] - b.v[0], a.v[1] - b.v[1], a.v[2] - b.v[2]]
        const d2: Vec3 = [
          0.5 * (acc[i][0] - acc[j][0]),
          0.5 * (acc[i][1] - acc[j][1]),
          0.5 * (acc[i][2] - acc[j][2]),
        ]
        const c = [
          d0[0] * d0[0] + d0[1] * d0[1] + d0[2] * d0[2] - 4 * R * R,
          2 * (d0[0] * d1[0] + d0[1] * d1[1] + d0[2] * d1[2]),
          d1[0] * d1[0] + d1[1] * d1[1] + d1[2] * d1[2] + 2 * (d0[0] * d2[0] + d0[1] * d2[1] + d0[2] * d2[2]),
          2 * (d1[0] * d2[0] + d1[1] * d2[1] + d1[2] * d2[2]),
          d2[0] * d2[0] + d2[1] * d2[1] + d2[2] * d2[2],
        ]
        const tc = firstDownCrossing(c, bestT)
        if (tc < bestT) {
          bestT = tc
          kind = 'ball-ball'
          bi = i
          bj = j
        }
      }
    }

    // 3. 공-쿠션 충돌
    for (let i = 0; i < balls.length; i++) {
      const b = balls[i]
      if (!isMoving(b)) continue
      const gaps = wallGaps(b, acc[i], table)
      for (let k = 0; k < 4; k++) {
        const s = gaps[k]
        // 타고 있는 쿠션과는 충돌 검사를 하지 않는다 (이미 닿아서 받쳐지고 있다)
        if (b.ride && b.ride & (1 << k)) continue
        if (b.s !== 'airborne') {
          // 바닥 위: 쿠션 코까지의 수평 거리가 reach 가 되는 시각 (2차식)
          const tc = firstDownCrossing([s[0] - reach, s[1], s[2]], bestT)
          if (tc < bestT) {
            bestT = tc
            kind = 'cushion'
            bi = i
            bc = k
          }
        } else {
          // 공중: 쿠션 코(높이 h 의 모서리)까지의 거리가 R 이 되는 시각 (4차식)
          //   s(t)^2 + (z(t) - h)^2 - R^2
          const q = [b.r[2] - h, b.v[2], 0.5 * acc[i][2]]
          const f = [
            s[0] * s[0] + q[0] * q[0] - R * R,
            2 * (s[0] * s[1] + q[0] * q[1]),
            s[1] * s[1] + 2 * s[0] * s[2] + q[1] * q[1] + 2 * q[0] * q[2],
            2 * (s[1] * s[2] + q[1] * q[2]),
            s[2] * s[2] + q[2] * q[2],
          ]
          const tc = firstDownCrossing(f, bestT)
          if (tc < bestT) {
            bestT = tc
            kind = 'cushion'
            bi = i
            bc = k
          }
          // 쿠션 코에 닿지 않고 그 위를 넘어가면 장외
          const to = firstDownCrossing(s, bestT)
          if (to < bestT) {
            bestT = to
            kind = 'out'
            bi = i
            bc = k
          }
        }
      }
    }

    // 4. 그 시각으로 모든 공을 진행
    const dt = bestT
    balls = balls.map((b) => evolve(b, table, dt))
    time += dt

    // 같은 시각에 전이 시각이 된 공은 모두 넘긴다.
    const ids: number[] = []
    for (let i = 0; i < balls.length; i++) {
      if (tt[i] <= dt) {
        finishTransition(balls[i], table)
        if (kind === 'transition') ids.push(balls[i].id)
      }
    }

    let cushion: CushionId | undefined
    if (kind === 'ball-ball') {
      collideBalls(balls[bi], balls[bj], table)
      ids.push(balls[bi].id, balls[bj].id)
    } else if (kind === 'cushion') {
      cushion = CUSHIONS[bc].id
      ids.push(balls[bi].id)
      collideCushion(balls[bi], table, CUSHIONS[bc].n, bc)
    } else if (kind === 'out') {
      const b = balls[bi]
      cushion = CUSHIONS[bc].id
      ids.push(b.id)
      b.s = 'out'
      b.v = [0, 0, 0]
      b.w = [0, 0, 0]
    }

    if (tilted) {
      // 끼임 감지: 기울기에 눌린 공이 쿠션과 다른 공 사이에서 아주 짧은 시간에 접촉을 되풀이하면
      // 그 자리에 끼어 멈춘 것으로 본다. 여러 접촉이 동시에 걸린 정지 상태를 정확히 풀려면
      // 구속 조건 풀이가 필요하다. 여기서는 근사로 처리한다.
      if (kind === 'ball-ball' || kind === 'cushion') {
        for (const i of kind === 'ball-ball' ? [bi, bj] : [bi]) {
          const q = contactTimes[i]
          q.push(time)
          if (q.length > JAM_COUNT) q.shift()
          if (q.length === JAM_COUNT && time - q[0] < JAM_WINDOW && balls[i].s !== 'airborne') {
            const b = balls[i]
            b.v = [0, 0, 0]
            b.w = [0, 0, 0]
            b.held = true
            normalize(b, table)
            q.length = 0
          }
        }
      }
      releaseUnsupported(balls, table)
    }
    events.push({ t: time, type: kind, ids, cushion, balls: balls.map(cloneBall) })
  }

  return {
    events,
    final: balls,
    duration: time,
    hash: hashResult(events, balls),
    truncated,
  }
}

/** 샷 하나를 처음부터 끝까지 계산한다. 물리 코어의 주 진입점. */
export function simulate(table: TableProfile, initial: BallState[], shot: ShotInput): ShotResult {
  const balls = initial.map(cloneBall)
  const cueBall = balls.find((b) => b.id === shot.ballId)
  if (!cueBall) throw new Error(`ball ${shot.ballId} not found`)
  const info = strike(cueBall, table, shot)
  return evolveSystem(table, balls, {
    t: 0,
    type: 'strike',
    ids: [shot.ballId],
    miscue: info.miscue,
    contactTime: info.contactTime,
    balls: [],
  })
}

/**
 * 결과에서 임의 시각 t 의 공 상태를 계산한다. 렌더링, 리플레이, 슬로모션에 사용.
 * 물리를 다시 돌리지 않고 직전 이벤트의 상태에서 해석식으로 진행한다.
 */
export function stateAt(table: TableProfile, result: ShotResult, t: number): BallState[] {
  const ev = result.events
  if (ev.length === 0) return result.final.map(cloneBall)
  if (t >= result.duration) return result.final.map(cloneBall)
  if (t <= ev[0].t) return ev[0].balls.map(cloneBall)
  let lo = 0
  let hi = ev.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (ev[mid].t <= t) lo = mid
    else hi = mid - 1
  }
  const e = ev[lo]
  return e.balls.map((b) => evolve(b, table, t - e.t))
}
