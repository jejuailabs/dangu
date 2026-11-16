import type { BallState, SimEvent } from './types'

/** FNV-1a 32비트를 서로 다른 시작값으로 두 번 돌려 16진수 16자리를 만든다. */
function fnv(bytes: Uint8Array, seed: number): number {
  let h = seed >>> 0
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i]
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h >>> 0
}

const STATE_CODE: Record<string, number> = {
  stationary: 0,
  spinning: 1,
  sliding: 2,
  rolling: 3,
  airborne: 4,
  out: 5,
}

/** 이벤트 시각과 최종 상태의 비트 단위 해시 */
export function hashResult(events: SimEvent[], final: BallState[]): string {
  const nums: number[] = []
  for (const e of events) nums.push(e.t)
  for (const b of final) nums.push(b.id, ...b.r, ...b.v, ...b.w, STATE_CODE[b.s])
  const bytes = new Uint8Array(new Float64Array(nums).buffer)
  const h1 = fnv(bytes, 0x811c9dc5)
  const h2 = fnv(bytes, 0x9747b28c)
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0')
}
