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
  /** 이 기록을 보는 사람의 자리 (온라인에서 2번 자리였으면 1). 없으면 0 */
  viewSeat?: number
  /** 온라인 대전 기록인가 */
  online?: boolean
}

export interface PlayerState extends ScoreState {
  /** 이닝별 득점 (기록지). inningPoints[k] 는 k+1 번째 이닝 */
  inningPoints: number[]
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
  if (shot.timeout || !shot.input) {
    judgement = TIMEOUT
  } else {
    result = simulate(table, before, { ...shot.input, ballId: cueIdOf(p) })
    judgement = judge(config.discipline, result, cueIdOf(p), config.rules, me.finishing)
    balls = respot(config.discipline, result.final.map(cloneBall))
  }

  const players = state.players.map((x) => ({ ...x, inningPoints: [...x.inningPoints] }))
  const scoreBefore = me.score
  const next: PlayerState = { ...players[p], ...applyJudgement(me, judgement, config.rules, false) }
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

/** 종목 이름 */
export function disciplineName(d: Discipline): string {
  return d === '3cushion' ? '3쿠션' : '4구'
}
