import { describe, expect, it } from 'vitest'
import { CAROM_LARGE as T, makeBall, strike } from '../../physics/src'
import {
  CUES,
  LEVELS,
  applyReward,
  buyCue,
  cueById,
  cueRatings,
  cueStatus,
  equipCue,
  levelOf,
  newProfile,
  sanitizeProfile,
} from '../src/progress'

describe('다마수', () => {
  it('경험치에 따라 단계가 오른다', () => {
    expect(levelOf(0).damasu).toBe(50)
    expect(levelOf(14).damasu).toBe(50)
    expect(levelOf(15).damasu).toBe(80)
    expect(levelOf(99999).damasu).toBe(1000)
    expect(levelOf(99999).next).toBeNull()
  })
  it('진행도와 남은 경험치', () => {
    const l = levelOf(27)
    expect(l.damasu).toBe(80)
    expect(l.next).toBe(100)
    expect(l.remaining).toBe(13)
    expect(l.progress).toBeCloseTo(12 / 25)
  })
  it('단계표는 오름차순이다', () => {
    for (let i = 1; i < LEVELS.length; i++) {
      expect(LEVELS[i].xp).toBeGreaterThan(LEVELS[i - 1].xp)
      expect(LEVELS[i].damasu).toBeGreaterThan(LEVELS[i - 1].damasu)
    }
  })
})

describe('큐', () => {
  it('좋은 큐일수록 힘, 회전 범위, 고각이 줄지 않는다', () => {
    for (let i = 1; i < CUES.length; i++) {
      const a = CUES[i - 1]
      const b = CUES[i]
      expect(b.minDamasu).toBeGreaterThan(a.minDamasu)
      expect(b.price).toBeGreaterThan(a.price)
      expect(b.maxSpeed).toBeGreaterThan(a.maxSpeed)
      expect(b.spec.miscueLimit).toBeGreaterThan(a.spec.miscueLimit)
      expect(b.spec.tipRestitution).toBeGreaterThan(a.spec.tipRestitution)
      expect(b.maxElevation).toBeGreaterThanOrEqual(a.maxElevation)
    }
  })

  it('마세(고각 80도 이상)는 다마수 300 큐부터 가능하다', () => {
    const masseCues = CUES.filter((c) => c.maxElevation >= 80)
    expect(masseCues.length).toBeGreaterThan(0)
    expect(Math.min(...masseCues.map((c) => c.minDamasu))).toBe(300)
    expect(cueById('house').maxElevation).toBeLessThan(30)
  })

  it('같은 스트로크라도 좋은 큐가 공을 더 빠르게 보낸다', () => {
    const speed = (id: string) => {
      const b = makeBall(0, 1, 0.7, T)
      strike(b, T, { ballId: 0, phi: 0, theta: 0, side: 0, top: 0, speed: 3, cue: cueById(id).spec })
      return b.v[0]
    }
    expect(speed('gold')).toBeGreaterThan(speed('house') * 1.04)
  })

  it('같은 당점에서 하우스 큐는 미스큐가 나고 좋은 큐는 나지 않는다', () => {
    const miscue = (id: string, side: number) => {
      const b = makeBall(0, 1, 0.7, T)
      return strike(b, T, { ballId: 0, phi: 0, theta: 0, side, top: 0, speed: 3, cue: cueById(id).spec }).miscue
    }
    expect(miscue('house', 0.45)).toBe(true)
    expect(miscue('carbon', 0.45)).toBe(false)
    expect(miscue('gold', 0.55)).toBe(false)
  })

  it('미스큐 없이 줄 수 있는 최대 회전은 좋은 큐가 더 크다', () => {
    const maxSpin = (id: string) => {
      const c = cueById(id)
      const b = makeBall(0, 1, 0.7, T)
      strike(b, T, { ballId: 0, phi: 0, theta: 0, side: c.spec.miscueLimit - 0.005, top: 0, speed: 3, cue: c.spec })
      return b.w[2] / Math.hypot(b.v[0], b.v[1])
    }
    expect(maxSpin('gold')).toBeGreaterThan(maxSpin('house') * 1.3)
  })

  it('능력 막대는 0..1 범위다', () => {
    for (const c of CUES) for (const v of Object.values(cueRatings(c))) {
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThanOrEqual(1)
    }
  })
})

describe('구매와 보상', () => {
  it('처음에는 하우스 큐만 있고, 다마수가 모자라면 잠겨 있다', () => {
    const p = newProfile()
    expect(cueStatus(p, cueById('house'))).toBe('equipped')
    expect(cueStatus(p, cueById('oak'))).toBe('locked')
    expect(buyCue(p, 'oak')).toBe(p)
  })

  it('다마수가 되어도 코인이 모자라면 살 수 없다', () => {
    const p = { ...newProfile(), xp: 15, coins: 10 }
    expect(cueStatus(p, cueById('oak'))).toBe('poor')
    expect(buyCue(p, 'oak')).toBe(p)
  })

  it('조건이 되면 사서 바로 들고, 코인이 줄어든다', () => {
    const p = buyCue({ ...newProfile(), xp: 15, coins: 50 }, 'oak')
    expect(p.owned).toContain('oak')
    expect(p.equipped).toBe('oak')
    expect(p.coins).toBe(10)
    // 이미 가진 큐는 다시 사지지 않는다
    expect(buyCue(p, 'oak')).toBe(p)
    expect(equipCue(p, 'house').equipped).toBe('house')
    expect(equipCue(p, 'gold').equipped).toBe('oak')
  })

  it('경기 보상으로 경험치와 코인을 얻고, 승급하면 새 큐가 열린다', () => {
    const { profile, reward } = applyReward(newProfile(), 15, true, false)
    expect(reward.xp).toBe(15)
    expect(reward.coins).toBe(40)
    expect(reward.levelUp).toEqual([50, 80])
    expect(reward.unlocked.map((c) => c.id)).toEqual(['oak'])
    expect(profile.games).toBe(1)
    // 승급하지 않으면 levelUp 은 null
    expect(applyReward(profile, 1, false, false).reward.levelUp).toBeNull()
  })

  it('대전에서 이기면 보너스가 붙는다', () => {
    const a = applyReward(newProfile(), 5, true, true).reward.coins
    const b = applyReward(newProfile(), 5, true, false).reward.coins
    expect(a - b).toBe(20)
  })

  it('깨진 저장값도 쓸 수 있는 프로필로 고친다', () => {
    expect(sanitizeProfile(null)).toEqual(newProfile())
    const p = sanitizeProfile({ xp: -5, coins: 'x', owned: ['gold', 'nope'], equipped: 'nope' })
    expect(p.xp).toBe(0)
    expect(p.coins).toBe(0)
    expect(p.owned).toEqual(['house', 'gold'])
    expect(p.equipped).toBe('house')
  })
})
