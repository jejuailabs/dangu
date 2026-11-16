/**
 * 효과음 (PRD 07 §8). 음원 파일 없이 합성한다. 충돌 세기에 따라 크기가 달라진다.
 */
let ctx: AudioContext | null = null
let enabled = true

export function setSoundEnabled(on: boolean): void {
  enabled = on
}

function context(): AudioContext | null {
  if (!enabled) return null
  try {
    if (!ctx) ctx = new AudioContext()
    if (ctx.state === 'suspended') void ctx.resume()
    return ctx
  } catch {
    return null
  }
}

/** 짧은 잡음을 대역 필터에 통과시켜 "딱" 소리를 만든다. */
function burst(freq: number, q: number, duration: number, volume: number): void {
  const ac = context()
  if (!ac || volume <= 0.002) return
  const n = Math.floor(ac.sampleRate * duration)
  const buf = ac.createBuffer(1, n, ac.sampleRate)
  const data = buf.getChannelData(0)
  for (let i = 0; i < n; i++) data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / n, 3)
  const src = ac.createBufferSource()
  src.buffer = buf
  const filter = ac.createBiquadFilter()
  filter.type = 'bandpass'
  filter.frequency.value = freq
  filter.Q.value = q
  const gain = ac.createGain()
  gain.gain.value = Math.min(volume, 1)
  src.connect(filter).connect(gain).connect(ac.destination)
  src.start()
}

/** speed: 충돌 직전의 속도 (m/s) */
export function playBallHit(speed: number): void {
  burst(2600, 3, 0.03, Math.min(speed / 4, 1) * 0.9)
}
export function playCushion(speed: number): void {
  burst(260, 1.2, 0.09, Math.min(speed / 4, 1) * 0.7)
}
export function playStrike(speed: number, miscue: boolean): void {
  if (miscue) burst(4200, 6, 0.05, 0.5)
  else burst(1300, 2, 0.025, Math.min(speed / 5, 1) * 0.8)
}
