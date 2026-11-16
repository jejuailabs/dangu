/**
 * 개인 기록 (PRD 08 §6.1). 저장된 경기들을 다시 계산해 통산 기록을 낸다.
 * 기록의 주인은 1번 선수(이 기기의 주인)다.
 */
import type { Discipline } from '../../rules/src'
import { type MatchRecord, rebuild } from './index'

export interface MatchPoint {
  id: string
  createdAt: number
  discipline: Discipline
  /** 그 경기의 에버리지 */
  average: number
  score: number
  innings: number
  highRun: number
  /** 상대가 있는 경기에서 이겼는가. 혼자 친 경기는 null */
  won: boolean | null
  opponent: string | null
}

export interface CareerStats {
  games: number
  points: number
  innings: number
  /** 통산 에버리지 = 총 득점 / 총 이닝 */
  average: number
  highRun: number
  shots: number
  madeShots: number
  /** 득점한 샷 / 전체 샷 */
  successRate: number
  /** 상대가 있었던 경기 수와 이긴 수 */
  versusGames: number
  wins: number
  winRate: number
  /** 최근 경기들의 에버리지 (오래된 것부터) */
  trend: MatchPoint[]
}

/** 종목별 통산 기록. discipline 을 주지 않으면 전체 */
export function careerStats(records: MatchRecord[], discipline?: Discipline): CareerStats {
  const list = records.filter((r) => !discipline || r.config.discipline === discipline)
  const trend: MatchPoint[] = []
  let points = 0
  let innings = 0
  let highRun = 0
  let shots = 0
  let made = 0
  let versusGames = 0
  let wins = 0
  for (const r of list) {
    const { state } = rebuild(r)
    const seat = r.viewSeat ?? 0
    const me = state.players[seat]
    if (!me) continue
    points += me.score
    innings += me.innings
    shots += me.shots
    made += me.madeShots
    if (me.highRun > highRun) highRun = me.highRun
    const two = state.players.length > 1
    if (two) {
      versusGames++
      if (state.winner === seat) wins++
    }
    trend.push({
      id: r.id,
      createdAt: r.createdAt,
      discipline: r.config.discipline,
      average: me.innings > 0 ? me.score / me.innings : 0,
      score: me.score,
      innings: me.innings,
      highRun: me.highRun,
      won: two ? state.winner === seat : null,
      opponent: two ? r.config.players[seat === 0 ? 1 : 0].name : null,
    })
  }
  trend.sort((a, b) => a.createdAt - b.createdAt)
  return {
    games: trend.length,
    points,
    innings,
    average: innings > 0 ? points / innings : 0,
    highRun,
    shots,
    madeShots: made,
    successRate: shots > 0 ? made / shots : 0,
    versusGames,
    wins,
    winRate: versusGames > 0 ? wins / versusGames : 0,
    trend,
  }
}

/**
 * 에버리지 추이를 그릴 꺾은선의 점들을 0..1 좌표로 돌려준다 (x: 순서, y: 값, 위가 1).
 * 화면 쪽에서 크기만 곱해 SVG 로 그린다.
 */
export function trendLine(trend: MatchPoint[]): { x: number; y: number; value: number }[] {
  if (trend.length === 0) return []
  const max = Math.max(...trend.map((t) => t.average), 1e-9)
  return trend.map((t, i) => ({
    x: trend.length === 1 ? 0.5 : i / (trend.length - 1),
    y: t.average / max,
    value: t.average,
  }))
}
