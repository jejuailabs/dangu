import { DEG } from './math/dmath'
import { CAROM_LARGE, DEFAULT_CUE } from './profiles'
import { makeBall, simulate } from './simulate'
import type { TableProfile } from './types'

/**
 * 결정성 자가 점검. 정해진 무작위 샷 묶음을 돌려 모든 결과 해시를 하나로 합친다.
 * 같은 코어 버전이면 Node, Chrome, Firefox, Safari 어디서든 같은 문자열이 나와야 한다.
 * 수평 샷, 고각(마세·점프), 기울어진 테이블, 두 쿠션 모델을 모두 포함한다.
 */
export function selfTestHash(count = 200): string {
  let s = 20240601
  const rnd = () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 4294967296
  }
  let h1 = 0x811c9dc5
  let h2 = 0x9747b28c
  for (let n = 0; n < count; n++) {
    const T = CAROM_LARGE
    const table: TableProfile = {
      ...T,
      cushionModel: n % 5 === 4 ? 'han' : 'mathavan',
      tiltX: n % 7 === 6 ? (rnd() - 0.5) * 0.02 : 0,
      tiltY: n % 7 === 6 ? (rnd() - 0.5) * 0.02 : 0,
    }
    const balls = [makeBall(0, 0.7, 0.4, T), makeBall(1, 2.1, 0.71, T), makeBall(2, 1.4, 1.0, T)]
    const res = simulate(table, balls, {
      ballId: 0,
      cue: DEFAULT_CUE,
      phi: rnd() * 6.283185307179586,
      theta: rnd() < 0.8 ? rnd() * 10 * DEG : rnd() * 80 * DEG,
      side: (rnd() - 0.5) * 0.9,
      top: (rnd() - 0.5) * 0.9,
      speed: 0.3 + rnd() * 7,
      accel: (rnd() - 0.5) * 60,
    })
    for (let i = 0; i < res.hash.length; i++) {
      const c = res.hash.charCodeAt(i)
      h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0
      h2 = Math.imul(h2 ^ c, 0x01000197) >>> 0
    }
  }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0')
}
