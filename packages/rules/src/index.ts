/**
 * 종목 규칙과 판정 (PRD 04).
 *
 * 판정은 물리 코어가 내놓는 이벤트 목록만 보고 결정한다. 화면이나 입력 방식과 무관하므로
 * 서버가 같은 입력으로 다시 계산해 검증할 수 있다.
 */
import {
  CAROM_LARGE,
  CAROM_MEDIUM_4BALL,
  type BallState,
  type ShotResult,
  type TableProfile,
  makeBall,
} from '../../physics/src'

export type Discipline = '3cushion' | '4ball'

/** 공 id 약속: 0 = 흰 수구, 1 = 노란 수구, 2·3 = 빨간 공 */
export const WHITE = 0
export const YELLOW = 1
export const RED_A = 2
export const RED_B = 3

export interface ShotJudgement {
  /** 득점 여부 */
  scored: boolean
  /** 파울 여부 */
  foul: boolean
  /** 점수 변화 (득점 +1, 4구 파울 -1 등) */
  points: number
  /** 수구가 맞힌 공 id (맞힌 순서, 중복 제외) */
  hits: number[]
  /** 수구가 닿은 쿠션 수 (전체) */
  cushions: number
  /** 두 번째 목적구를 맞히기 전까지 닿은 쿠션 수. 두 번째를 못 맞혔으면 전체 쿠션 수 */
  cushionsBeforeSecond: number
  /** 사람이 읽는 판정 이유 */
  reason: string
}

export interface RuleOptions {
  /** 4구: 파울 시 감점할지 */
  foulPenalty4Ball: boolean
  /** 4구: 목표 점수를 채운 뒤 3쿠션으로 마무리해야 하는지 (한국식 관행) */
  finishWithThreeCushion: boolean
}

export const DEFAULT_RULES: RuleOptions = {
  foulPenalty4Ball: true,
  finishWithThreeCushion: false,
}

export function tableFor(d: Discipline): TableProfile {
  return d === '3cushion' ? CAROM_LARGE : CAROM_MEDIUM_4BALL
}

/**
 * 초구 배치.
 * 3쿠션: 빨간 공은 먼 쪽 스폿, 상대 수구는 가까운 쪽 스폿, 내 수구는 그 옆 [지식].
 * 4구: 빨간 공 둘을 긴 축 위에, 수구 둘을 그 사이에 둔다 [초기값, 동호인 검토 필요].
 */
export function initialLayout(d: Discipline): BallState[] {
  const t = tableFor(d)
  const L = t.length
  const W = t.width
  if (d === '3cushion') {
    return [
      makeBall(WHITE, L / 4, W / 2 - 0.1825, t),
      makeBall(YELLOW, L / 4, W / 2, t),
      makeBall(RED_A, (3 * L) / 4, W / 2, t),
    ]
  }
  return [
    makeBall(WHITE, L / 4, W / 2 - 0.15, t),
    makeBall(YELLOW, (3 * L) / 8, W / 2, t),
    makeBall(RED_A, L / 8, W / 2, t),
    makeBall(RED_B, (3 * L) / 4, W / 2, t),
  ]
}

/** 수구가 무엇을 어떤 순서로 맞혔는지 이벤트에서 뽑아낸다. */
function trace(result: ShotResult, cueId: number) {
  const hits: number[] = []
  let cushions = 0
  let cushionsBeforeSecond = -1
  let out = false
  for (const e of result.events) {
    if (e.type === 'cushion' && e.ids[0] === cueId) cushions++
    else if (e.type === 'ball-ball' && e.ids.includes(cueId)) {
      const other = e.ids[0] === cueId ? e.ids[1] : e.ids[0]
      if (!hits.includes(other)) {
        hits.push(other)
        if (hits.length === 2) cushionsBeforeSecond = cushions
      }
    } else if (e.type === 'out') out = true
  }
  if (cushionsBeforeSecond < 0) cushionsBeforeSecond = cushions
  return { hits, cushions, cushionsBeforeSecond, out }
}

/**
 * 3쿠션 판정: 수구가 두 목적구를 모두 맞히되, 두 번째 목적구에 닿기 전에 쿠션에 3번 이상 닿아야 한다.
 */
function judge3Cushion(result: ShotResult, cueId: number): ShotJudgement {
  const t = trace(result, cueId)
  const base = { hits: t.hits, cushions: t.cushions, cushionsBeforeSecond: t.cushionsBeforeSecond }
  if (t.out) return { ...base, scored: false, foul: true, points: 0, reason: '공이 테이블 밖으로 나감' }
  if (result.events[0]?.miscue) return { ...base, scored: false, foul: true, points: 0, reason: '미스큐' }
  if (t.hits.length < 2) {
    const reason = t.hits.length === 0 ? '공을 맞히지 못함' : '두 번째 공을 맞히지 못함'
    return { ...base, scored: false, foul: false, points: 0, reason }
  }
  if (t.cushionsBeforeSecond < 3) {
    return { ...base, scored: false, foul: false, points: 0, reason: `쿠션 ${t.cushionsBeforeSecond}개 (3개 필요)` }
  }
  return { ...base, scored: true, foul: false, points: 1, reason: `득점 (${t.cushionsBeforeSecond}쿠션)` }
}

/**
 * 4구 판정: 수구로 빨간 공 두 개를 모두 맞히면 득점. 상대 수구를 맞히거나 아무 공도 못 맞히면 파울.
 * requireThreeCushion 이면(마무리 단계) 3쿠션 조건도 만족해야 한다.
 */
function judge4Ball(
  result: ShotResult,
  cueId: number,
  opts: RuleOptions,
  requireThreeCushion: boolean,
): ShotJudgement {
  const t = trace(result, cueId)
  const base = { hits: t.hits, cushions: t.cushions, cushionsBeforeSecond: t.cushionsBeforeSecond }
  const penalty = opts.foulPenalty4Ball ? -1 : 0
  const otherCue = cueId === WHITE ? YELLOW : WHITE
  if (t.out) return { ...base, scored: false, foul: true, points: penalty, reason: '공이 테이블 밖으로 나감' }
  if (t.hits.includes(otherCue)) {
    return { ...base, scored: false, foul: true, points: penalty, reason: '상대 수구를 맞힘' }
  }
  if (t.hits.length === 0) {
    return { ...base, scored: false, foul: true, points: penalty, reason: '공을 맞히지 못함' }
  }
  const reds = t.hits.filter((id) => id === RED_A || id === RED_B)
  if (reds.length < 2) return { ...base, scored: false, foul: false, points: 0, reason: '빨간 공 하나만 맞힘' }
  if (requireThreeCushion && t.cushionsBeforeSecond < 3) {
    return {
      ...base,
      scored: false,
      foul: false,
      points: 0,
      reason: `마무리는 3쿠션 (쿠션 ${t.cushionsBeforeSecond}개)`,
    }
  }
  return { ...base, scored: true, foul: false, points: 1, reason: requireThreeCushion ? '3쿠션 마무리' : '득점' }
}

export function judge(
  d: Discipline,
  result: ShotResult,
  cueId: number,
  opts: RuleOptions = DEFAULT_RULES,
  requireThreeCushion = false,
): ShotJudgement {
  return d === '3cushion' ? judge3Cushion(result, cueId) : judge4Ball(result, cueId, opts, requireThreeCushion)
}

/** 장외로 나간 공을 초구 위치(비어 있지 않으면 근처)로 되돌린다. */
export function respot(d: Discipline, balls: BallState[]): BallState[] {
  const t = tableFor(d)
  const init = initialLayout(d)
  const out = balls.map((b) => ({ ...b, r: [...b.r] as [number, number, number] }))
  for (const b of out) {
    if (b.s !== 'out') continue
    const home = init.find((x) => x.id === b.id)!
    let x = home.r[0]
    const y = home.r[1]
    // 자리가 막혀 있으면 긴 축을 따라 조금씩 옮긴다
    for (let k = 0; k < 40; k++) {
      const blocked = out.some((o) => o !== b && o.s !== 'out' && Math.hypot(o.r[0] - x, o.r[1] - y) < 2 * t.R + 1e-4)
      if (!blocked) break
      x += 2.2 * t.R * (k % 2 === 0 ? 1 : -1) * (k + 1)
      x = Math.min(Math.max(x, 2 * t.R), t.length - 2 * t.R)
    }
    b.r = [x, y, t.R]
    b.v = [0, 0, 0]
    b.w = [0, 0, 0]
    b.s = 'stationary'
  }
  return out
}

/** 한 사람의 경기 기록 (PRD 08 의 스코어보드 항목) */
export interface ScoreState {
  score: number
  target: number
  /** 끝난 이닝 수 + 진행 중인 이닝 */
  innings: number
  /** 현재 이닝의 연속 득점 */
  run: number
  highRun: number
  shots: number
  madeShots: number
  fouls: number
  /** 4구 마무리 단계 여부 */
  finishing: boolean
  finished: boolean
}

export function newScore(target: number): ScoreState {
  return {
    score: 0,
    target,
    innings: 1,
    run: 0,
    highRun: 0,
    shots: 0,
    madeShots: 0,
    fouls: 0,
    finishing: false,
    finished: false,
  }
}

/** 에버리지 = 득점 / 이닝 */
export function average(s: ScoreState): number {
  return s.innings > 0 ? s.score / s.innings : 0
}

/**
 * 판정 결과를 점수에 반영한다. 혼자 치기에서는 실패하면 이닝이 넘어가고 같은 사람이 계속 친다.
 */
export function applyJudgement(
  s: ScoreState,
  j: ShotJudgement,
  opts: RuleOptions = DEFAULT_RULES,
  advanceInning = true,
): ScoreState {
  if (s.finished) return s
  const n = { ...s }
  n.shots++
  if (j.foul) n.fouls++
  if (j.scored) {
    n.madeShots++
    if (n.finishing) {
      n.finished = true
    } else {
      n.score += j.points
      n.run++
      if (n.run > n.highRun) n.highRun = n.run
      if (n.score >= n.target) {
        if (opts.finishWithThreeCushion) n.finishing = true
        else n.finished = true
      }
    }
  } else {
    n.score = Math.max(0, n.score + j.points)
    n.run = 0
    // 혼자 칠 때는 실패하면 바로 다음 이닝이다. 대전에서는 차례가 돌아올 때 경기 진행 쪽에서 올린다.
    if (advanceInning) n.innings++
  }
  return n
}
