/**
 * 경기 진행과 기록 (PRD 08, 09 §5).
 *
 * 경기의 유일한 원본은 MatchRecord = 초기 배치 + 샷 입력 목록이다.
 * 점수, 이닝, 기록지, 다시 보기는 모두 이 기록을 물리 코어로 다시 계산해서 얻는다.
 * 영상을 저장하지 않으므로 한 경기가 수 KB 이고, 어떤 시점·배속으로도 다시 볼 수 있다.
 */
import {
  CORE_VERSION,
  type BallState,
  type ShotInput,
  type ShotResult,
  type TableProfile,
  cloneBall,
  simulate,
} from '../../physics/src'
import {
  type Discipline,
  type RuleOptions,
  type ScoreState,
  type ShotJudgement,
  WHITE,
  YELLOW,
  applyJudgement,
  average,
  initialLayout,
  judge,
  newScore,
  respot,
  tableFor,
} from '../../rules/src'

export interface PlayerConfig {
  name: string
  /** 목표 점수 (4구는 수지 / 10) */
  target: number
}

export interface MatchConfig {
  discipline: Discipline
  /** 1명이면 혼자 치기, 2명이면 대전 */
  players: PlayerConfig[]
  rules: RuleOptions
  /** 샷 제한 시간 (초). 0 이면 없음 */
  shotClock: number
  /** 컴퓨터가 치는 자리와 그 수준. 없으면 사람끼리의 경기 */
  ai?: { player: number; levelId: string }
}

/** 스트로크로 쳤을 때의 타법 정보 (표시용) */
export interface StrokeMeta {
  accel: number
  backswing: number
  aimError: number
  label: string
}

export interface ShotRecord {
  player: number
  /** 샷 입력. 시간 초과면 없다 */
  input?: ShotInput
  timeout?: boolean
  /** 기권. player 가 기권한 사람이다 (차례와 무관). 온라인에서 나가거나 끊긴 경우 */
  forfeit?: boolean
  stroke?: StrokeMeta
  /** 이 샷을 치기 전에 초크를 칠했는가 */
  chalked?: boolean
}

export interface MatchRecord {
  id: string
  createdAt: number
  /** 이 기록을 만든 물리 코어 버전. 버전이 다르면 다시 계산한 결과가 달라질 수 있다 */
  coreVersion: string
  config: MatchConfig
  /** 계수 전체를 담는다 (이름 참조가 아님) */
  table: TableProfile
  initialBalls: BallState[]
  shots: ShotRecord[]
  /** 초크와 확률적 미스큐를 쓰는 기록인가. 없으면 예전 방식(한계를 넘으면 무조건 미스큐)으로 다시 계산한다 */
  chalk?: boolean
  /** 이 기록을 보는 사람의 자리 (온라인에서 2번 자리였으면 1). 없으면 0 */
  viewSeat?: number
  /** 온라인 대전 기록인가 */
  online?: boolean
}

export interface PlayerState extends ScoreState {
  /** 이닝별 득점 (기록지). inningPoints[k] 는 k+1 번째 이닝 */
  inningPoints: number[]
  /** 팁에 남은 초크 (0..1). 칠 때마다 닳고, 초크를 칠하면 1 이 된다 */
  chalk?: number
}

/**
 * 미스큐 확률. 당점이 큐의 한계 근처에 들어서면 확률적으로 미스큐가 난다.
 * 초크가 가득하면 한계까지는 안전하고 한계의 1.28배에서 확실히 미스큐가 난다.
 * 초크가 없으면 한계의 82% 부터 위험해지고 94% 에서 확실히 미스큐가 난다. [초기값]
 */
export function miscueChance(off: number, limit: number, chalk: number): number {
  const c = Math.min(Math.max(chalk, 0), 1)
  const safe = limit * (0.82 + 0.18 * c)
  const width = limit * (0.12 + 0.16 * c)
  return Math.min(Math.max((off - safe) / width, 0), 1)
}

/** 샷 한 번에 초크가 닳는 양. 당점이 중심에서 멀수록 많이 닳는다 */
export function chalkWear(off: number, limit: number): number {
  return 0.08 + 0.2 * Math.min(off / limit, 1)
}

/** 미스큐 판정에 쓰는 0..1 의 수. 기록의 id 와 샷 번호로 정해지므로 다시 계산해도 같다 */
export function miscueRoll(recordId: string, index: number): number {
  const text = `${recordId}:${index}`
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193) >>> 0
  // 마지막에 한 번 더 섞는다 (샷 번호만 달라도 고르게 퍼지도록)
  h ^= h >>> 15
  h = Math.imul(h, 0x2c1b3c6d) >>> 0
  h ^= h >>> 12
  h = Math.imul(h, 0x297a2d39) >>> 0
  h ^= h >>> 15
  return (h >>> 0) / 4294967296
}

export interface MatchState {
  balls: BallState[]
  players: PlayerState[]
  /** 지금 칠 사람 */
  turn: number
  finished: boolean
  /** 이긴 사람. 아직이면 -1 */
  winner: number
}

/** 샷 하나의 결과 (다시 보기와 샷 목록에 쓴다) */
export interface ShotOutcome {
  index: number
  player: number
  /** 그 사람의 몇 번째 이닝이었나 */
  inning: number
  before: BallState[]
  shot: ShotRecord
  result?: ShotResult
  judgement: ShotJudgement
  /** 이 샷 뒤의 그 사람 점수 */
  scoreAfter: number
}

/** 0번 사람은 흰 공, 1번 사람은 노란 공을 친다 */
export function cueIdOf(player: number): number {
  return player === 0 ? WHITE : YELLOW
}

export function newMatch(config: MatchConfig, id: string, createdAt: number): MatchRecord {
  return {
    id,
    createdAt,
    coreVersion: CORE_VERSION,
    chalk: true,
    config,
    table: { ...tableFor(config.discipline) },
    initialBalls: initialLayout(config.discipline),
    shots: [],
  }
}

export function initialState(record: MatchRecord): MatchState {
  return {
    balls: record.initialBalls.map(cloneBall),
    players: record.config.players.map((p, i) => ({
      ...newScore(p.target),
      // 이닝은 "시작한 차례의 수" 다. 먼저 치는 사람만 1 에서 시작한다
      innings: i === 0 ? 1 : 0,
      inningPoints: i === 0 ? [0] : [],
    })),
    turn: 0,
    finished: false,
    winner: -1,
  }
}

/** 지금 치면 적용될 초크 양 (방금 칠했으면 1) */
export function chalkOf(state: MatchState, chalked = false): number {
  return chalked ? 1 : (state.players[state.turn].chalk ?? 1)
}

const FORFEIT: ShotJudgement = {
  scored: false,
  foul: false,
  points: 0,
  hits: [],
  cushions: 0,
  cushionsBeforeSecond: 0,
  reason: '기권',
}

const TIMEOUT: ShotJudgement = {
  scored: false,
  foul: true,
  points: 0,
  hits: [],
  cushions: 0,
  cushionsBeforeSecond: 0,
  reason: '시간 초과',
}

/**
 * 샷 하나를 적용한 다음 상태를 돌려준다. 기록(record)과 이전 상태는 바꾸지 않는다.
 */
export function step(record: MatchRecord, state: MatchState, shot: ShotRecord, index = record.shots.length): { state: MatchState; outcome: ShotOutcome } {
  const { config, table } = record
  const p = state.turn
  const me = state.players[p]
  const before = state.balls.map(cloneBall)
  const inning = me.innings

  if (shot.forfeit) {
    // 기권: 점수는 그대로 두고 상대가 이긴다
    const loser = shot.player
    return {
      state: { ...state, balls: before, finished: true, winner: state.players.length > 1 ? (loser + 1) % state.players.length : -1 },
      outcome: { index, player: loser, inning: state.players[loser]?.innings ?? 0, before, shot, judgement: FORFEIT, scoreAfter: state.players[loser]?.score ?? 0 },
    }
  }

  let result: ShotResult | undefined
  let judgement: ShotJudgement
  let balls = before
  let chalkAfter = chalkOf(state, shot.chalked)
  if (shot.timeout || !shot.input) {
    judgement = TIMEOUT
  } else {
    // 미스큐 여부는 여기서 정한다 (기록에 들어 있는 값은 믿지 않는다)
    let miscue: boolean | undefined
    if (record.chalk) {
      const off = Math.hypot(shot.input.side, shot.input.top)
      const limit = shot.input.cue.miscueLimit
      miscue = miscueRoll(record.id, index) < miscueChance(off, limit, chalkOf(state, shot.chalked))
      chalkAfter = miscue ? 0 : Math.max(0, chalkOf(state, shot.chalked) - chalkWear(off, limit))
    }
    result = simulate(table, before, { ...shot.input, ballId: cueIdOf(p), miscue })
    judgement = judge(config.discipline, result, cueIdOf(p), config.rules, me.finishing)
    balls = respot(config.discipline, result.final.map(cloneBall))
  }

  const players = state.players.map((x) => ({ ...x, inningPoints: [...x.inningPoints] }))
  const scoreBefore = me.score
  const next: PlayerState = { ...players[p], ...applyJudgement(me, judgement, config.rules, false) }
  if (record.chalk) next.chalk = chalkAfter
  // 기록지: 이번 이닝 칸에 점수 변화를 더한다
  next.inningPoints[inning - 1] = (next.inningPoints[inning - 1] ?? 0) + (next.score - scoreBefore)
  players[p] = next

  let turn = p
  let finished = false
  let winner = -1
  if (next.finished) {
    finished = true
    winner = p
  } else if (!judgement.scored) {
    turn = (p + 1) % players.length
    players[turn].innings++
    players[turn].inningPoints.push(0)
  }

  return {
    state: { balls, players, turn, finished, winner },
    outcome: { index, player: p, inning, before, shot, result, judgement, scoreAfter: next.score },
  }
}

/** 샷을 기록에 추가하고 다음 상태를 돌려준다. */
export function play(record: MatchRecord, state: MatchState, shot: ShotRecord): { state: MatchState; outcome: ShotOutcome } {
  if (state.finished) throw new Error('이미 끝난 경기입니다')
  // 기권은 차례가 아닌 사람도 할 수 있다. 그 밖의 샷은 지금 차례인 사람의 것이다
  const s = shot.forfeit ? shot : { ...shot, player: state.turn }
  const r = step(record, state, s)
  record.shots.push(s)
  return r
}

/** 기록을 처음부터 다시 계산한다. 저장된 경기를 열거나 다시 볼 때 쓴다. */
export function rebuild(record: MatchRecord): { state: MatchState; outcomes: ShotOutcome[] } {
  let state = initialState(record)
  const outcomes: ShotOutcome[] = []
  record.shots.forEach((shot, i) => {
    const r = step(record, state, shot, i)
    state = r.state
    outcomes.push(r.outcome)
  })
  return { state, outcomes }
}

export interface PlayerSummary {
  name: string
  score: number
  target: number
  innings: number
  average: number
  highRun: number
  shots: number
  madeShots: number
  /** 득점한 샷 / 전체 샷 */
  successRate: number
  fouls: number
}

export function summarize(record: MatchRecord, state: MatchState): PlayerSummary[] {
  return state.players.map((p, i) => ({
    name: record.config.players[i].name,
    score: p.score,
    target: p.target,
    innings: p.innings,
    average: average(p),
    highRun: p.highRun,
    shots: p.shots,
    madeShots: p.madeShots,
    successRate: p.shots > 0 ? p.madeShots / p.shots : 0,
    fouls: p.fouls,
  }))
}

/**
 * 경기 상태의 지문. 온라인 대전에서 내 계산과 서버의 계산이 같은지 비교하는 데 쓴다.
 * 공의 위치와 점수·차례를 비트 단위로 담으므로, 물리 결과가 조금이라도 다르면 달라진다.
 */
export function stateSig(state: MatchState): string {
  const text = JSON.stringify([state.balls.map((b) => [b.id, b.r, b.s]), state.players.map((p) => [p.score, p.innings]), state.turn, state.finished, state.winner])
  let h1 = 0x811c9dc5
  let h2 = 0x9747b28c
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0
    h2 = Math.imul(h2 ^ c, 0x01000197) >>> 0
  }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0')
}

/** 종목 이름 */
export function disciplineName(d: Discipline): string {
  return d === '3cushion' ? '3쿠션' : '4구'
}
