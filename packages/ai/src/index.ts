/**
 * 컴퓨터 상대 (PRD 05).
 *
 * 사람과 같은 물리 코어, 같은 ShotInput 을 쓴다. 컴퓨터만의 특수한 물리는 없다.
 *
 *   ① 샷 후보 생성   목적구별 두께, 빈쿠션 방향, 당점, 속도의 조합
 *   ② 빠른 훑기      빠른 쿠션 모델(Han)로 득점하는 후보를 고른다
 *   ③ 검증           실제 모델(Mathavan)로, 자기 수준의 실행 오차를 넣어 여러 번 쳐 보고 성공 확률을 구한다
 *   ④ 선택           성공 확률 + 다음 배치의 좋음. 낮은 수준은 판단 실수를 한다
 *   ⑤ 실행 오차      고른 샷에 조준·속도·당점 오차를 넣어 실제로 친다
 *
 * 수준은 하나의 숫자 skill (0..1) 로 정한다. 낮을수록 오차가 크고, 아는 샷이 적고,
 * 회전을 덜 쓰고, 다음 공을 생각하지 않는다. 수지별 skill 값은 자동 대국으로 측정해 맞춘다.
 */
import {
  DEG,
  type BallState,
  type CueSpec,
  type ShotInput,
  type TableProfile,
  simulate,
} from '../../physics/src'
import { type Discipline, type RuleOptions, RED_A, RED_B, judge } from '../../rules/src'
import { clearElevation } from '../../game/src/cueGeometry'

export interface AiParams {
  /** 조준 오차 표준편차 (rad) */
  aimSigma: number
  /** 속도 오차 표준편차 (비율) */
  speedSigma: number
  /** 당점 오차 표준편차 (R 기준) */
  tipSigma: number
  /** 쓰는 회전의 크기 (당점 거리, R 기준). 0 이면 중심만 */
  maxSpin: number
  speeds: number[]
  tops: number[]
  /** 목적구 하나당 두께 표본 수 */
  thickSamples: number
  /** 빈쿠션(공을 직접 겨누지 않는 방향) 표본 수 */
  bankSamples: number
  /** 실제 모델로 검증할 후보 수 */
  verify: number
  /** 후보 하나를 검증할 때의 시도 수 */
  trials: number
  /** 4구에서 구사하는 샷의 최대 쿠션 수 (두 번째 공 전) */
  maxCushions4: number
  /** 다음 배치를 얼마나 따지는가 */
  positionWeight: number
  /** 가장 좋은 샷 대신 다른 샷을 고르는 확률 (판단 실수) */
  blunder: number
  /** 생각하는 시간 연출 (ms) */
  thinkMs: [number, number]
}

const lerp = (a: number, b: number, s: number) => a + (b - a) * s
const glerp = (a: number, b: number, s: number) => a * Math.pow(b / a, s)

/** skill (0..1) 에서 실제 동작 값을 만든다. */
export function paramsForSkill(skill: number): AiParams {
  const s = Math.min(Math.max(skill, 0), 1)
  return {
    aimSigma: glerp(2.4, 0.05, s) * DEG,
    speedSigma: glerp(0.3, 0.025, s),
    tipSigma: glerp(0.17, 0.012, s),
    maxSpin: s < 0.15 ? 0 : lerp(0.12, 0.5, (s - 0.15) / 0.85),
    speeds: s < 0.25 ? [2.2] : [1.8, 3.0],
    tops: s < 0.25 ? [0.1] : [-0.25, 0.3],
    thickSamples: Math.round(lerp(9, 26, s)),
    bankSamples: s < 0.35 ? 0 : Math.round(lerp(24, 90, (s - 0.35) / 0.65)),
    verify: Math.round(lerp(3, 14, s)),
    trials: Math.round(lerp(6, 14, s)),
    maxCushions4: s < 0.2 ? 0 : s < 0.45 ? 1 : 99,
    positionWeight: s < 0.5 ? 0 : lerp(0, 0.4, (s - 0.5) / 0.5),
    blunder: lerp(0.4, 0, Math.min(s / 0.7, 1)),
    thinkMs: [lerp(2600, 900, s), lerp(5200, 1900, s)],
  }
}

/** 시드가 고정된 난수. 같은 시드면 같은 결정을 한다 */
export function makeRng(seed: number) {
  let s = seed >>> 0 || 1
  const uni = () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return (s + 0.5) / 4294967296
  }
  /** 표준정규분포 (박스-뮬러) */
  const gauss = () => Math.sqrt(-2 * Math.log(uni())) * Math.cos(2 * Math.PI * uni())
  return { uni, gauss }
}
type Rng = ReturnType<typeof makeRng>

export interface AiContext {
  table: TableProfile
  discipline: Discipline
  rules: RuleOptions
  balls: BallState[]
  /** 컴퓨터가 치는 수구 */
  cueId: number
  /** 4구 마무리 단계인가 */
  finishing: boolean
  cue: CueSpec
  /** 이 큐로 낼 수 있는 최대 속도 */
  maxSpeed: number
  params: AiParams
  seed: number
}

export interface AiDecision {
  /** 치려고 한 샷 */
  intended: ShotInput
  /** 실행 오차가 들어간, 실제로 친 샷 */
  executed: ShotInput
  /** 컴퓨터가 추정한 성공 확률. 득점 샷을 찾지 못했으면 0 */
  pSuccess: number
  /** 훑어본 후보 수, 그중 득점한 수 */
  scanned: number
  found: number
  thinkMs: number
}

interface Cand {
  phi: number
  side: number
  top: number
  speed: number
}

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi)

function toInput(ctx: AiContext, c: Cand, theta?: number): ShotInput {
  const cueBall = ctx.balls.find((b) => b.id === ctx.cueId)!
  return {
    ballId: ctx.cueId,
    phi: c.phi,
    // 사람과 같은 제약: 큐가 쿠션이나 다른 공에 걸리면 들어야 한다
    theta: theta ?? clearElevation(ctx.table, ctx.balls, cueBall, c.phi, 0, c.side, c.top),
    side: c.side,
    top: c.top,
    speed: c.speed,
    cue: ctx.cue,
  }
}

/** 실행 오차. 세게 칠수록, 당점이 중심에서 멀수록, 큐를 들수록 오차가 커진다. */
function perturb(ctx: AiContext, c: Cand, rng: Rng): Cand {
  const p = ctx.params
  const off = Math.hypot(c.side, c.top)
  const hard = 1 + 0.5 * (c.speed / 4)
  const k = hard * (1 + off)
  const side = clamp(c.side + rng.gauss() * p.tipSigma * hard, -0.9, 0.9)
  const top = clamp(c.top + rng.gauss() * p.tipSigma * hard, -0.9, 0.9)
  return {
    phi: c.phi + rng.gauss() * p.aimSigma * k,
    side,
    top,
    speed: clamp(c.speed * (1 + rng.gauss() * p.speedSigma), 0.3, ctx.maxSpeed),
  }
}

function candidates(ctx: AiContext): Cand[] {
  const p = ctx.params
  const R = ctx.table.R
  const cue = ctx.balls.find((b) => b.id === ctx.cueId)!
  // 겨눌 공: 4구는 빨간 공만 (상대 수구를 맞히면 파울)
  const targets = ctx.balls.filter(
    (b) => b.id !== ctx.cueId && b.s !== 'out' && (ctx.discipline === '3cushion' || b.id === RED_A || b.id === RED_B),
  )
  const phis: number[] = []
  for (const t of targets) {
    const dx = t.r[0] - cue.r[0]
    const dy = t.r[1] - cue.r[1]
    const d = Math.hypot(dx, dy)
    const base = Math.atan2(dy, dx)
    const half = Math.asin(Math.min(1, (2 * R) / d))
    // 3쿠션은 두께에 훨씬 민감하므로 더 촘촘히 본다
    const n = ctx.discipline === '3cushion' ? Math.round(p.thickSamples * 1.6) : p.thickSamples
    for (let i = 0; i < n; i++) phis.push(base + half * (-0.97 + (1.94 * i) / Math.max(n - 1, 1)))
  }
  // 빈쿠션은 3쿠션(과 4구의 3쿠션 마무리)에서만 찾는다
  const banks = ctx.discipline === '3cushion' || ctx.finishing ? p.bankSamples : 0
  for (let i = 0; i < banks; i++) phis.push((2 * Math.PI * (i + 0.5)) / banks)

  const lim = Math.min(p.maxSpin, ctx.cue.miscueLimit * 0.9)
  const sides = lim > 0.05 ? [-lim, 0, lim] : [0]
  const tops = p.tops.map((t) => clamp(t, -lim || -0.1, Math.max(lim, 0.1)))
  // 3쿠션은 공이 쿠션을 세 번 넘게 돌아야 하므로 더 세게 친다
  const boost = ctx.discipline === '3cushion' ? 1.25 : 1
  const speeds = p.speeds.map((v) => Math.min(v * boost, ctx.maxSpeed))
  const out: Cand[] = []
  for (const phi of phis) for (const side of sides) for (const top of tops) for (const speed of speeds) out.push({ phi, side, top, speed })
  return out
}

/** 4구에서 다음에 치기 좋은 배치인가: 수구와 두 빨간 공이 모여 있을수록 좋다 (0..1) */
function compactness(ctx: AiContext, final: BallState[]): number {
  if (ctx.discipline !== '4ball') return 0
  const cue = final.find((b) => b.id === ctx.cueId)
  const reds = final.filter((b) => b.id === RED_A || b.id === RED_B)
  if (!cue || reds.length < 2) return 0
  const d = (Math.hypot(cue.r[0] - reds[0].r[0], cue.r[1] - reds[0].r[1]) + Math.hypot(cue.r[0] - reds[1].r[0], cue.r[1] - reds[1].r[1])) / 2
  return clamp(1 - d / (ctx.table.length * 0.6), 0, 1)
}

/**
 * 한 샷을 고른다. 같은 입력과 시드면 같은 결과를 낸다.
 */
export function chooseShot(ctx: AiContext): AiDecision {
  const p = ctx.params
  const rng = makeRng(ctx.seed)
  // 4구는 빠른 쿠션 모델로 훑는다. 3쿠션은 쿠션을 여러 번 거치면서 두 모델의 결과가 크게 벌어지므로
  // 처음부터 실제 모델로 훑는다 (느리지만 찾은 샷이 실제로 들어간다).
  const fast: TableProfile = ctx.discipline === '3cushion' ? ctx.table : { ...ctx.table, cushionModel: 'han' }
  // 훑을 때는 방향마다 고각을 한 번만 구해 둔다 (당점에 따른 차이는 작다)
  const cueBall0 = ctx.balls.find((b) => b.id === ctx.cueId)!
  const thetaCache = new Map<number, number>()
  const thetaFor = (phi: number) => {
    let t = thetaCache.get(phi)
    if (t === undefined) {
      t = clearElevation(ctx.table, ctx.balls, cueBall0, phi, 0, 0, 0)
      thetaCache.set(phi, t)
    }
    return t
  }
  const scores = (table: TableProfile, c: Cand, quick = false) => {
    const res = simulate(table, ctx.balls, toInput(ctx, c, quick ? thetaFor(c.phi) : undefined))
    return { res, j: judge(ctx.discipline, res, ctx.cueId, ctx.rules, ctx.finishing) }
  }
  const allowed = (cushions: number) => ctx.discipline !== '4ball' || ctx.finishing || cushions <= p.maxCushions4

  // ② 빠른 훑기
  const all = candidates(ctx)
  const hits: { c: Cand; robust: number }[] = []
  for (const c of all) {
    const { j } = scores(fast, c, true)
    if (!j.scored || !allowed(j.cushionsBeforeSecond)) continue
    // 조금 흔들어도 들어가는지 미리 본다 (빠른 모델로 세 번)
    let ok = 0
    for (let i = 0; i < 3; i++) if (scores(fast, perturb(ctx, c, rng)).j.scored) ok++
    hits.push({ c, robust: ok + rng.uni() * 0.5 })
  }
  hits.sort((a, b) => b.robust - a.robust)

  // ③ 검증: 실제 모델로, 자기 수준의 오차를 넣어 여러 번
  let best: { c: Cand; value: number; p: number }[] = []
  for (const h of hits.slice(0, p.verify)) {
    let c = h.c
    let nominal = scores(ctx.table, c)
    if (!nominal.j.scored) {
      // 두 쿠션 모델의 결과가 다를 수 있다. 방향을 조금 틀어 다시 찾는다
      let fixed = false
      for (const d of [0.15, -0.15, 0.35, -0.35, 0.7, -0.7]) {
        const alt = { ...c, phi: c.phi + d * DEG }
        const r = scores(ctx.table, alt)
        if (r.j.scored && allowed(r.j.cushionsBeforeSecond)) {
          c = alt
          nominal = r
          fixed = true
          break
        }
      }
      if (!fixed) continue
    }
    // 득점하는 방향의 폭을 재서 그 가운데를 겨눈다. 폭이 넓을수록 실수에 강한 샷이다
    const stepW = 0.08 * DEG
    const okAt = (k: number) => {
      const r = scores(ctx.table, { ...c, phi: c.phi + k * stepW })
      return r.j.scored && allowed(r.j.cushionsBeforeSecond)
    }
    let lo = 0
    let hi = 0
    while (lo > -12 && okAt(lo - 1)) lo--
    while (hi < 12 && okAt(hi + 1)) hi++
    if (lo + hi !== 0) {
      c = { ...c, phi: c.phi + ((lo + hi) / 2) * stepW }
      nominal = scores(ctx.table, c)
      if (!nominal.j.scored) continue
    }
    let made = 0
    let fouls = 0
    for (let i = 0; i < p.trials; i++) {
      const r = scores(ctx.table, perturb(ctx, c, rng))
      if (r.j.scored) made++
      if (r.j.foul) fouls++
    }
    const prob = made / p.trials
    const value = prob * (1 + p.positionWeight * compactness(ctx, nominal.res.final)) - 0.5 * (fouls / p.trials)
    best.push({ c, value, p: prob })
  }
  best.sort((a, b) => b.value - a.value)

  // ④ 선택
  let chosen: Cand
  let pSuccess = 0
  if (best.length > 0) {
    let pick = 0
    if (best.length > 1 && rng.uni() < p.blunder) pick = 1 + Math.floor(rng.uni() * Math.min(best.length - 1, 3))
    chosen = best[pick].c
    pSuccess = best[pick].p
  } else {
    chosen = fallback(ctx)
  }

  // ⑤ 실행
  const executed = perturb(ctx, chosen, rng)
  return {
    intended: toInput(ctx, chosen),
    executed: toInput(ctx, executed),
    pSuccess,
    scanned: all.length,
    found: hits.length,
    thinkMs: p.thinkMs[0] + rng.uni() * (p.thinkMs[1] - p.thinkMs[0]),
  }
}

/** 득점할 샷을 찾지 못했을 때: 가장 가까운 목적구를 두껍게 맞힌다 (적어도 헛치지는 않게). */
function fallback(ctx: AiContext): Cand {
  const cue = ctx.balls.find((b) => b.id === ctx.cueId)!
  const targets = ctx.balls.filter(
    (b) => b.id !== ctx.cueId && b.s !== 'out' && (ctx.discipline === '3cushion' || b.id === RED_A || b.id === RED_B),
  )
  let near = targets[0]
  for (const t of targets) {
    if (Math.hypot(t.r[0] - cue.r[0], t.r[1] - cue.r[1]) < Math.hypot(near.r[0] - cue.r[0], near.r[1] - cue.r[1])) near = t
  }
  const phi = near ? Math.atan2(near.r[1] - cue.r[1], near.r[0] - cue.r[0]) : 0
  return { phi, side: 0, top: 0.1, speed: Math.min(ctx.discipline === '3cushion' ? 3 : 2, ctx.maxSpeed) }
}
