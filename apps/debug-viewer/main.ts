/**
 * 물리 개발용 2D 디버그 뷰어. 게임 화면이 아니라 물리 코어를 눈으로 확인하는 도구다.
 */
import {
  CAROM_LARGE as T,
  CORE_VERSION,
  DEFAULT_CUE,
  DEG,
  type BallState,
  type ShotInput,
  type ShotResult,
  type TableProfile,
  cloneBall,
  makeBall,
  selfTestHash,
  simulate,
  stateAt,
} from '../../packages/physics/src'

/** 현재 설정(기울기, 쿠션 모델)이 반영된 테이블 */
let table: TableProfile = { ...T }

const cv = document.getElementById('cv') as HTMLCanvasElement
const ctx = cv.getContext('2d')!
const $ = (id: string) => document.getElementById(id) as HTMLInputElement
const info = document.getElementById('info')!

const COLORS = ['#f4f4ee', '#f2c230', '#d63a3a', '#d63a3a']
const MARGIN = 60
const SCALE = (cv.width - 2 * MARGIN) / T.length
const X = (x: number) => MARGIN + x * SCALE
const Y = (y: number) => cv.height - MARGIN - y * SCALE

function initialLayout(): BallState[] {
  return [makeBall(0, 0.71, 0.5, T), makeBall(1, 2.13, 0.71, T), makeBall(2, 1.42, 1.0, T)]
}

let balls = initialLayout()
let before: BallState[] | null = null
let side = 0
let top = 0
let result: ShotResult | null = null
let playT = 0
let lastFrame = 0
let playing = false
let trails: [number, number][][] = []
let drag = -1

function shotInput(): ShotInput {
  return {
    ballId: 0,
    phi: Number($('phi').value) * DEG,
    theta: Number($('theta').value) * DEG,
    side,
    top,
    speed: Number($('speed').value),
    accel: Number($('accel').value),
    cue: DEFAULT_CUE,
  }
}

function syncTable() {
  table = {
    ...T,
    tiltX: Math.sin(Number($('tiltX').value) * DEG),
    tiltY: Math.sin(Number($('tiltY').value) * DEG),
    cushionModel: ($('model') as unknown as HTMLSelectElement).value as 'mathavan' | 'han',
  }
}

function syncLabels() {
  document.getElementById('tiltXO')!.textContent = `${Number($('tiltX').value).toFixed(2)}°`
  document.getElementById('tiltYO')!.textContent = `${Number($('tiltY').value).toFixed(2)}°`
  document.getElementById('phiO')!.textContent = `${Number($('phi').value).toFixed(1)}°`
  document.getElementById('thetaO')!.textContent = `${$('theta').value}°`
  document.getElementById('speedO')!.textContent = `${Number($('speed').value).toFixed(1)} m/s`
  document.getElementById('accelO')!.textContent = `${$('accel').value} m/s²`
  document.getElementById('rateO')!.textContent = `${Number($('rate').value).toFixed(2)}×`
  const dot = document.getElementById('tipdot')!
  dot.style.left = `${50 + side * 50}%`
  dot.style.top = `${50 - top * 50}%`
}

/** 결과 전체의 경로를 점 목록으로 뽑는다 */
function samplePaths(res: ShotResult, step = 0.01): [number, number][][] {
  const paths: [number, number][][] = res.final.map(() => [])
  for (let t = 0; t <= res.duration; t += step) {
    const st = stateAt(table, res, t)
    st.forEach((b, i) => paths[i].push([b.r[0], b.r[1]]))
  }
  res.final.forEach((b, i) => paths[i].push([b.r[0], b.r[1]]))
  return paths
}

function drawTable() {
  ctx.clearRect(0, 0, cv.width, cv.height)
  // 레일
  ctx.fillStyle = '#4a2f1c'
  ctx.fillRect(X(0) - 30, Y(T.width) - 30, T.length * SCALE + 60, T.width * SCALE + 60)
  // 천
  ctx.fillStyle = '#1f5fa8'
  ctx.fillRect(X(0), Y(T.width), T.length * SCALE, T.width * SCALE)
  // 다이아몬드
  ctx.fillStyle = '#e8e2d0'
  for (let i = 0; i <= 8; i++) {
    for (const y of [-0.045, T.width + 0.045]) dotAt((T.length * i) / 8, y, 3)
  }
  for (let i = 0; i <= 4; i++) {
    for (const x of [-0.045, T.length + 0.045]) dotAt(x, (T.width * i) / 4, 3)
  }
}
function dotAt(x: number, y: number, r: number) {
  ctx.beginPath()
  ctx.arc(X(x), Y(y), r, 0, Math.PI * 2)
  ctx.fill()
}

function drawPath(path: [number, number][], color: string, dashed: boolean) {
  if (path.length < 2) return
  ctx.save()
  ctx.strokeStyle = color
  ctx.lineWidth = dashed ? 1 : 1.5
  ctx.globalAlpha = dashed ? 0.55 : 0.8
  if (dashed) ctx.setLineDash([5, 5])
  ctx.beginPath()
  ctx.moveTo(X(path[0][0]), Y(path[0][1]))
  for (const p of path) ctx.lineTo(X(p[0]), Y(p[1]))
  ctx.stroke()
  ctx.restore()
}

function drawBalls(state: BallState[]) {
  state.forEach((b, i) => {
    if (b.s === 'out') return
    const h = b.r[2] - T.R
    // 그림자: 공이 뜨면 옆으로 벌어진다
    ctx.fillStyle = 'rgba(0,0,0,0.35)'
    ctx.beginPath()
    ctx.arc(X(b.r[0]) + 3 + h * SCALE, Y(b.r[1]) + 3 + h * SCALE, T.R * SCALE, 0, Math.PI * 2)
    ctx.fill()
    ctx.fillStyle = COLORS[i % COLORS.length]
    ctx.beginPath()
    ctx.arc(X(b.r[0]), Y(b.r[1]), T.R * SCALE * (1 + h * 2), 0, Math.PI * 2)
    ctx.fill()
    // 좌우 회전 표시: 회전 방향으로 호를 그린다
    const wz = b.w[2]
    if (Math.abs(wz) > 1) {
      ctx.strokeStyle = wz > 0 ? '#16a34a' : '#c026d3'
      ctx.lineWidth = 2
      const span = Math.min(Math.abs(wz) / 60, 1) * Math.PI * 1.6
      ctx.beginPath()
      // 화면은 y 가 뒤집혀 있으므로 반시계(wz > 0)는 화면에서 시계 반대로 그린다
      ctx.arc(X(b.r[0]), Y(b.r[1]), T.R * SCALE * 0.6, -Math.PI / 2, -Math.PI / 2 - Math.sign(wz) * span, wz > 0)
      ctx.stroke()
    }
  })
}

function drawAim() {
  const cue = balls[0]
  const s = shotInput()
  const len = 0.25
  ctx.strokeStyle = '#d9b77a'
  ctx.lineWidth = 4
  ctx.beginPath()
  ctx.moveTo(X(cue.r[0] - Math.cos(s.phi) * (T.R + 0.01)), Y(cue.r[1] - Math.sin(s.phi) * (T.R + 0.01)))
  ctx.lineTo(X(cue.r[0] - Math.cos(s.phi) * (T.R + len)), Y(cue.r[1] - Math.sin(s.phi) * (T.R + len)))
  ctx.stroke()
}

function describe(res: ShotResult, t: number): string {
  const st = stateAt(table, res, t)
  const c = st[0]
  const counts: Record<string, number> = {}
  for (const e of res.events) counts[e.type] = (counts[e.type] ?? 0) + 1
  const cush = res.events.filter((e) => e.type === 'cushion' && e.ids[0] === 0).length
  const lines = [
    `코어 버전   ${CORE_VERSION}`,
    `해시        ${res.hash}`,
    `총 시간     ${res.duration.toFixed(2)} s`,
    `이벤트      ${res.events.length}개`,
    `  공-공     ${counts['ball-ball'] ?? 0}`,
    `  쿠션      ${counts['cushion'] ?? 0} (수구 ${cush})`,
    `  상태 전이 ${counts['transition'] ?? 0}`,
    `팁 접촉    ${((res.events[0]?.contactTime ?? 0) * 1000).toFixed(2)} ms`,
    res.events[0]?.miscue ? `※ 미스큐` : '',
    res.truncated ? `※ 이벤트 상한 초과` : '',
    ``,
    `[수구] t = ${Math.min(t, res.duration).toFixed(2)} s`,
    `상태        ${c.s}`,
    `속도        ${Math.hypot(c.v[0], c.v[1]).toFixed(2)} m/s`,
    `높이        ${((c.r[2] - T.R) * 1000).toFixed(0)} mm`,
    `좌우 회전   ${c.w[2].toFixed(1)} rad/s`,
    `전후 회전   ${Math.hypot(c.w[0], c.w[1]).toFixed(1)} rad/s`,
  ]
  return lines.filter((l) => l !== '').join('\n')
}

function render() {
  drawTable()
  if (playing && result) {
    trails.forEach((p, i) => drawPath(p, COLORS[i], false))
    drawBalls(stateAt(table, result, playT))
    info.textContent = describe(result, playT)
  } else {
    // 조준 중: 예측 경로
    const pred = simulate(table, balls, shotInput())
    samplePaths(pred).forEach((p, i) => drawPath(p, COLORS[i], true))
    drawBalls(balls)
    drawAim()
    if (result) trails.forEach((p, i) => drawPath(p, COLORS[i], false))
    info.textContent = result ? describe(result, result.duration) : `예측 해시 ${pred.hash}\n예측 시간 ${pred.duration.toFixed(2)} s`
  }
}

function frame(now: number) {
  if (playing && result) {
    const dt = (now - lastFrame) / 1000
    lastFrame = now
    const prev = playT
    playT += dt * Number($('rate').value)
    // 지나온 구간을 궤적에 추가
    for (let t = prev; t < Math.min(playT, result.duration); t += 0.004) {
      stateAt(table, result, t).forEach((b, i) => trails[i].push([b.r[0], b.r[1]]))
    }
    if (playT >= result.duration) {
      playing = false
      balls = result.final.map(cloneBall)
      balls.forEach((b, i) => trails[i].push([b.r[0], b.r[1]]))
    }
    render()
    if (playing) requestAnimationFrame(frame)
  }
}

function shoot() {
  if (playing) return
  if (balls[0].s === 'out') return
  before = balls.map(cloneBall)
  result = simulate(table, balls, shotInput())
  trails = balls.map(() => [])
  playT = 0
  playing = true
  lastFrame = performance.now()
  requestAnimationFrame(frame)
}

// 입력
for (const id of ['phi', 'theta', 'speed', 'accel', 'rate']) {
  $(id).addEventListener('input', () => {
    syncLabels()
    if (!playing) render()
  })
}
for (const id of ['tiltX', 'tiltY', 'model']) {
  $(id).addEventListener('input', () => {
    if (playing) return
    syncTable()
    syncLabels()
    result = null
    trails = []
    render()
  })
}
document.getElementById('settle')!.addEventListener('click', () => {
  // 치지 않고 현재 배치를 그대로 두었을 때의 움직임 (기울기 확인용)
  if (playing) return
  before = balls.map(cloneBall)
  result = simulate(table, balls, { ...shotInput(), speed: 0 })
  trails = balls.map(() => [])
  playT = 0
  playing = true
  lastFrame = performance.now()
  requestAnimationFrame(frame)
})
document.getElementById('shoot')!.addEventListener('click', shoot)
document.getElementById('undo')!.addEventListener('click', () => {
  if (playing || !before) return
  balls = before.map(cloneBall)
  result = null
  trails = []
  render()
})
document.getElementById('reset')!.addEventListener('click', () => {
  playing = false
  balls = initialLayout()
  result = null
  trails = []
  render()
})

const pad = document.getElementById('tippad')!
function setTip(ev: PointerEvent) {
  const r = pad.getBoundingClientRect()
  let sx = ((ev.clientX - r.left) / r.width) * 2 - 1
  let sy = -(((ev.clientY - r.top) / r.height) * 2 - 1)
  const l = Math.hypot(sx, sy)
  if (l > 0.85) {
    sx *= 0.85 / l
    sy *= 0.85 / l
  }
  side = Math.round(sx * 100) / 100
  top = Math.round(sy * 100) / 100
  syncLabels()
  if (!playing) render()
}
pad.addEventListener('pointerdown', (ev) => {
  pad.setPointerCapture(ev.pointerId)
  setTip(ev)
})
pad.addEventListener('pointermove', (ev) => {
  if (ev.buttons) setTip(ev)
})

function tablePos(ev: PointerEvent): [number, number] {
  const r = cv.getBoundingClientRect()
  const px = ((ev.clientX - r.left) / r.width) * cv.width
  const py = ((ev.clientY - r.top) / r.height) * cv.height
  return [(px - MARGIN) / SCALE, (cv.height - MARGIN - py) / SCALE]
}
cv.addEventListener('pointerdown', (ev) => {
  if (playing) return
  const [x, y] = tablePos(ev)
  drag = balls.findIndex((b) => Math.hypot(b.r[0] - x, b.r[1] - y) < T.R * 1.3)
  if (drag >= 0) {
    cv.setPointerCapture(ev.pointerId)
    return
  }
  const c = balls[0]
  $('phi').value = String((Math.atan2(y - c.r[1], x - c.r[0]) / DEG).toFixed(1))
  syncLabels()
  render()
})
cv.addEventListener('pointermove', (ev) => {
  if (drag < 0 || playing) return
  const [x, y] = tablePos(ev)
  const nx = Math.min(Math.max(x, T.R), T.length - T.R)
  const ny = Math.min(Math.max(y, T.R), T.width - T.R)
  // 다른 공과 겹치면 옮기지 않는다
  const ok = balls.every((b, i) => i === drag || Math.hypot(b.r[0] - nx, b.r[1] - ny) >= 2 * T.R)
  if (ok) {
    balls[drag].r[0] = nx
    balls[drag].r[1] = ny
    result = null
    trails = []
    render()
  }
})
cv.addEventListener('pointerup', () => {
  drag = -1
})

// 디버그용: 콘솔에서 접근
Object.assign(window, {
  __dangu: { shoot, getState: () => ({ balls, result, playing }), selfTest: () => selfTestHash(), version: CORE_VERSION },
})

syncLabels()
render()
