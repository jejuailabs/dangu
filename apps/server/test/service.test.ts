import { beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_CUE, DEG, type ShotInput } from '../../../packages/physics/src'
import { DEFAULT_RULES } from '../../../packages/rules/src'
import { type MatchConfig, type MatchRecord, type ShotRecord, initialState, newMatch, play } from '../../../packages/game/src'
import { Service, ServiceError } from '../src/service'

const shot = (deg: number, speed = 3): ShotRecord => ({
  player: 0,
  input: { ballId: 0, phi: deg * DEG, theta: 0, side: 0, top: 0.2, speed, cue: DEFAULT_CUE } as ShotInput,
})
const SCORING = shot(2, 4)
const MISS = shot(250, 0.5)

function finished(id: string, target = 1, versus = false): MatchRecord {
  const config: MatchConfig = {
    discipline: '3cushion',
    players: versus ? [{ name: '나', target }, { name: '상대', target }] : [{ name: '나', target }],
    rules: DEFAULT_RULES,
    shotClock: 0,
  }
  const rec = newMatch(config, id, 1000)
  const st = play(rec, initialState(rec), SCORING).state
  expect(st.finished).toBe(target === 1)
  return rec
}

const status = (fn: () => unknown): number => {
  try {
    fn()
  } catch (e) {
    if (e instanceof ServiceError) return e.status
    throw e
  }
  return 200
}

let s: Service
beforeEach(() => {
  s = new Service(':memory:')
})

describe('계정', () => {
  it('가입하고, 같은 아이디로 다시 가입할 수 없다 (대소문자 무시)', () => {
    const r = s.signup('당구왕', 'secret12')
    expect(r.account.name).toBe('당구왕')
    expect(r.token).toMatch(/^[a-f0-9]{64}$/)
    expect(status(() => s.signup('Player1', 'secret12'))).toBe(200)
    expect(status(() => s.signup('player1', 'secret12'))).toBe(409)
  })

  it('아이디와 비밀번호 형식을 검사한다', () => {
    expect(status(() => s.signup('a', 'secret12'))).toBe(400)
    expect(status(() => s.signup('bad name!', 'secret12'))).toBe(400)
    expect(status(() => s.signup('okname', '123'))).toBe(400)
    expect(status(() => s.signup(undefined, 5))).toBe(400)
  })

  it('맞는 비밀번호로만 로그인된다', () => {
    s.signup('user1', 'secret12')
    expect(s.login('user1', 'secret12').account.name).toBe('user1')
    expect(status(() => s.login('user1', 'wrongpass'))).toBe(401)
    expect(status(() => s.login('nobody', 'secret12'))).toBe(401)
  })

  it('세션 토큰으로 본인을 확인하고, 로그아웃과 만료 뒤에는 안 된다', () => {
    const { token, account } = s.signup('user1', 'secret12', 1000)
    expect(s.auth(token, 2000)?.id).toBe(account.id)
    expect(s.auth('0'.repeat(64), 2000)).toBeNull()
    expect(s.auth('short', 2000)).toBeNull()
    expect(s.auth(token, 1000 + 31 * 86_400_000)).toBeNull()
    s.logout(token)
    expect(s.auth(token, 2000)).toBeNull()
  })

  it('비밀번호를 그대로 저장하지 않는다', () => {
    s.signup('user1', 'secret12')
    const rows = (s as unknown as { db: { prepare(q: string): { all(): unknown[] } } }).db.prepare('SELECT * FROM users').all()
    expect(JSON.stringify(rows)).not.toContain('secret12')
  })
})

describe('경기 기록과 보상', () => {
  it('끝난 경기를 다시 계산해 보상을 준다', () => {
    const { account } = s.signup('user1', 'secret12')
    const r = s.addMatch(account.id, finished('match01'))
    expect(r.duplicate).toBe(false)
    expect(r.summary.score).toBe(1)
    // 득점 1: 경험치 1, 코인 2 + 완주 10
    expect(r.profile.xp).toBe(1)
    expect(r.profile.coins).toBe(12)
    expect(r.profile.games).toBe(1)
    expect(s.listMatches(account.id).map((m) => m.id)).toEqual(['match01'])
  })

  it('같은 경기를 다시 보내도 보상은 한 번만 준다', () => {
    const { account } = s.signup('user1', 'secret12')
    const rec = finished('match01')
    s.addMatch(account.id, rec)
    const again = s.addMatch(account.id, rec)
    expect(again.duplicate).toBe(true)
    expect(again.profile.coins).toBe(12)
  })

  it('대전에서 이기면 승리 보너스가 붙는다', () => {
    const { account } = s.signup('user1', 'secret12')
    const r = s.addMatch(account.id, finished('match02', 1, true))
    expect(r.profile.coins).toBe(32)
    expect(r.profile.wins).toBe(1)
  })

  it('기록에 적힌 점수가 아니라 다시 계산한 점수를 쓴다', () => {
    const { account } = s.signup('user1', 'secret12')
    const rec = finished('match03') as MatchRecord & { fakeScore?: number }
    rec.fakeScore = 9999
    // 목표를 부풀려도, 실제로 채우지 못했으면 끝난 경기가 아니다
    const cheat = JSON.parse(JSON.stringify(rec)) as MatchRecord
    cheat.id = 'match04'
    cheat.config.players[0].target = 50
    expect(status(() => s.addMatch(account.id, cheat))).toBe(400)
    expect(s.addMatch(account.id, rec).summary.score).toBe(1)
  })

  it('끝나지 않은 경기, 다른 코어 버전, 깨진 기록은 받지 않는다', () => {
    const { account } = s.signup('user1', 'secret12')
    const cfg: MatchConfig = { discipline: '3cushion', players: [{ name: '나', target: 5 }], rules: DEFAULT_RULES, shotClock: 0 }
    const open = newMatch(cfg, 'open01', 1)
    play(open, initialState(open), MISS)
    expect(status(() => s.addMatch(account.id, open))).toBe(400)
    expect(status(() => s.addMatch(account.id, { ...finished('ver01'), coreVersion: '0.0.1' }))).toBe(409)
    expect(status(() => s.addMatch(account.id, null))).toBe(400)
    expect(status(() => s.addMatch(account.id, { id: 'x' }))).toBe(400)
    expect(status(() => s.addMatch(account.id, { ...finished('bad01'), shots: [{ player: 0, input: { phi: 'NaN' } }] }))).toBe(400)
    expect(s.profile(account.id).games).toBe(0)
  })

  it('기록은 계정별로 따로 저장된다', () => {
    const a = s.signup('user1', 'secret12').account
    const b = s.signup('user2', 'secret12').account
    s.addMatch(a.id, finished('match01'))
    expect(s.listMatches(b.id)).toEqual([])
    expect(s.profile(b.id).coins).toBe(0)
  })
})

describe('큐 구매', () => {
  /** 경험치와 코인을 쌓기 위해 경기를 여러 번 넣는다 */
  function grind(userId: number, n: number): void {
    for (let i = 0; i < n; i++) s.addMatch(userId, finished(`grind${String(i).padStart(3, '0')}`))
  }

  it('다마수와 코인이 되어야 살 수 있고, 산 큐는 바로 든다', () => {
    const { account } = s.signup('user1', 'secret12')
    expect(status(() => s.buyCue(account.id, 'oak'))).toBe(403) // 다마 부족
    grind(account.id, 15) // 경험치 15 = 다마 80, 코인 180
    const p = s.buyCue(account.id, 'oak')
    expect(p.owned).toContain('oak')
    expect(p.equipped).toBe('oak')
    expect(p.coins).toBe(180 - 40)
    expect(status(() => s.buyCue(account.id, 'oak'))).toBe(409)
    expect(status(() => s.buyCue(account.id, 'gold'))).toBe(403)
    expect(status(() => s.buyCue(account.id, 'nope'))).toBe(400)
  })

  it('가진 큐만 들 수 있다', () => {
    const { account } = s.signup('user1', 'secret12')
    expect(s.equipCue(account.id, 'house').equipped).toBe('house')
    expect(status(() => s.equipCue(account.id, 'gold'))).toBe(403)
  })
})
