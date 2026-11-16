/**
 * 스트로크 분석 (PRD 03 §4.1).
 *
 * 사용자가 포인터를 뒤로 당겼다가 앞으로 미는 동작의 궤적에서, 가상의 팁이 공에 닿는 순간의
 * 속도·가속도·좌우 흔들림을 뽑아낸다. 화면이나 입력 장치와 무관한 순수 함수라서
 * 마우스, 터치, 추후의 다른 장치가 모두 같은 분석을 쓴다.
 */

export interface StrokeSample {
  /** 시각 (ms) */
  t: number
  /** 스트로크 축 방향 위치 (px). 앞으로(공 쪽으로) 갈수록 커진다 */
  y: number
  /** 좌우 위치 (px) */
  x: number
}

export interface StrokeSettings {
  /** 화면 1px 이 큐의 몇 m 이동인가 */
  metersPerPx: number
  /** 시작할 때 팁과 공 사이의 간격 (m) */
  startGap: number
  /** 좌우 흔들림이 조준 오차로 반영되는 비율 (0 이면 반영 안 함) */
  wobbleGain: number
  /** 낼 수 있는 최대 큐 속도 (m/s) */
  maxSpeed: number
}

export const DEFAULT_STROKE: StrokeSettings = {
  metersPerPx: 0.0006, // [초기값] 300px 당기면 백스윙 18cm
  startGap: 0.02,
  wobbleGain: 0.15, // [초기값]
  maxSpeed: 10,
}

export interface StrokeAnalysis {
  /** 임팩트 순간 큐 속도 (m/s) */
  speed: number
  /** 임팩트 순간 큐 가속도 (m/s^2). 밀어치면 양수, 끊어치면 음수 */
  accel: number
  /** 좌우 흔들림에서 나온 조준 방향 오차 (rad). 양수는 왼쪽(반시계) */
  aimError: number
  /** 좌우 흔들림에서 나온 당점 오차 (R 기준). 양수는 오른쪽 */
  sideError: number
  /** 백스윙 길이 (m) */
  backswing: number
  /** 전진 구간 좌우 흔들림 (px, 직선에서 벗어난 정도의 제곱평균) */
  wobblePx: number
  /** 전진 시작부터 임팩트까지 걸린 시간 (ms) */
  forwardMs: number
}

/** 현재 팁과 공 사이의 간격 (m). 음수면 이미 닿았다 */
export function tipGap(samples: StrokeSample[], s: StrokeSettings): number {
  if (samples.length === 0) return s.startGap
  return s.startGap - (samples[samples.length - 1].y - samples[0].y) * s.metersPerPx
}

/** 구간 [t0, t1] 의 표본으로 최소제곱 기울기(px/ms)를 구한다. 표본이 부족하면 null */
function slope(samples: StrokeSample[], t0: number, t1: number, key: 'x' | 'y'): number | null {
  let n = 0
  let st = 0
  let sv = 0
  let stt = 0
  let stv = 0
  for (const p of samples) {
    if (p.t < t0 || p.t > t1) continue
    n++
    st += p.t
    sv += p[key]
    stt += p.t * p.t
    stv += p.t * p[key]
  }
  const den = n * stt - st * st
  if (n < 2 || den === 0) return null
  return (n * stv - st * sv) / den
}

/**
 * 팁이 공에 닿았는지 보고, 닿았으면 임팩트를 분석한다. 아직이면 null.
 * 표본은 시간순이어야 하고, 첫 표본이 스트로크 시작(팁이 startGap 만큼 떨어진 상태)이다.
 */
export function analyzeStroke(samples: StrokeSample[], s: StrokeSettings = DEFAULT_STROKE): StrokeAnalysis | null {
  if (samples.length < 2) return null
  const y0 = samples[0].y
  const gapPx = s.startGap / s.metersPerPx

  // 임팩트: 전진 거리가 처음 간격에 이르는 첫 표본
  let hit = -1
  for (let i = 1; i < samples.length; i++) {
    if (samples[i].y - y0 >= gapPx && samples[i].y > samples[i - 1].y) {
      hit = i
      break
    }
  }
  if (hit < 0) return null

  // 임팩트 시각을 두 표본 사이에서 보간
  const a = samples[hit - 1]
  const b = samples[hit]
  const f = b.y === a.y ? 1 : (y0 + gapPx - a.y) / (b.y - a.y)
  const tHit = a.t + (b.t - a.t) * Math.min(Math.max(f, 0), 1)
  const used = samples.slice(0, hit + 1)

  // 백스윙의 끝(가장 뒤로 간 지점)부터가 전진 구간이다
  let back = 0
  for (let i = 1; i <= hit; i++) if (used[i].y < used[back].y) back = i
  const tBack = used[back].t
  const forwardMs = Math.max(tHit - tBack, 1)

  // 속도: 임팩트 직전 구간의 기울기. 전진 구간이 짧으면 구간 전체를 쓴다.
  const win = Math.min(30, forwardMs)
  let vPx = slope(used, tHit - win, tHit + 1e-6, 'y')
  if (vPx === null) vPx = (b.y - a.y) / Math.max(b.t - a.t, 1e-3)
  let speed = vPx * 1000 * s.metersPerPx
  if (speed < 0) speed = 0
  if (speed > s.maxSpeed) speed = s.maxSpeed

  // 가속도: 직전 구간을 앞뒤 절반으로 나눠 속도 변화를 본다
  let accel = 0
  const w2 = Math.min(70, forwardMs)
  const early = slope(used, tHit - w2, tHit - w2 / 2, 'y')
  const late = slope(used, tHit - w2 / 2, tHit + 1e-6, 'y')
  if (early !== null && late !== null) {
    accel = ((late - early) * 1000 * s.metersPerPx) / (w2 / 2 / 1000)
  }
  if (accel > 200) accel = 200
  if (accel < -200) accel = -200

  // 좌우 흔들림: 전진 구간에서 옆으로 흐른 양
  const fwd = used.slice(back)
  const dx = fwd[fwd.length - 1].x - fwd[0].x
  const dy = Math.max(fwd[fwd.length - 1].y - fwd[0].y, 1)
  let dev = 0
  for (const p of fwd) {
    const expected = fwd[0].x + (dx * (p.y - fwd[0].y)) / dy
    dev += (p.x - expected) * (p.x - expected)
  }
  const wobblePx = Math.sqrt(dev / fwd.length)
  // 화면에서 오른쪽으로 흐르면(dx > 0) 큐 끝이 오른쪽으로 간 것: 조준은 오른쪽(시계)으로, 당점도 오른쪽으로
  const drift = Math.atan2(dx, dy)
  const aimError = -drift * s.wobbleGain
  const sideError = (dx * s.metersPerPx * s.wobbleGain) / 0.03

  return {
    speed,
    accel,
    aimError,
    sideError,
    backswing: (y0 - used[back].y) * s.metersPerPx,
    wobblePx,
    forwardMs,
  }
}

/** 스트로크 성향을 사람이 읽는 말로 */
export function describeStroke(a: StrokeAnalysis): string {
  if (a.accel > 8) return '밀어치기 (가속 중 임팩트)'
  if (a.accel < -8) return '끊어치기 (감속 중 임팩트)'
  return '일정한 속도'
}
