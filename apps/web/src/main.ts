/**
 * 게임 진행과 입력·화면 연결.
 *
 * 화면 흐름: 메뉴 -> (설정) -> 경기 [조준 -> 스트로크 -> 공이 구르는 중 -> 판정] -> 결과
 * 어떤 입력 방식이든 마지막에는 ShotInput 하나를 만들어 경기 기록(MatchRecord)에 추가한다.
 * 다시 보기와 지난 경기는 그 기록을 물리 코어로 다시 계산해서 보여 준다.
 */
import {
  DEG,
  type BallState,
  type ShotInput,
  type ShotResult,
  type TableProfile,
  cloneBall,
  cushionReach,
  simulate,
  stateAt,
} from '../../../packages/physics/src'
import { DEFAULT_RULES, type Discipline, average, tableFor } from '../../../packages/rules/src'
import {
  type MatchConfig,
  type MatchRecord,
  type MatchState,
  type ShotOutcome,
  type ShotRecord,
  cueIdOf,
  disciplineName,
  initialState,
  newMatch,
  play,
  rebuild,
  stateSig,
  summarize,
} from '../../../packages/game/src'
import {
  CUES,
  type Profile,
  type Reward,
  applyReward,
  buyCue,
  cueRatings,
  cueStatus,
  equipCue,
  equippedCue,
  levelOf,
} from '../../../packages/game/src/progress'
import { playBallHit, playCushion, playStrike, setSoundEnabled } from './audio'
import { clearElevation } from './cueGeometry'
import { TableScene, type ViewMode } from './scene'
import { clearCurrent, deleteMatch, loadCurrent, loadMatches, loadProfile, saveCurrent, saveMatch, saveProfile } from './store'
import { DEFAULT_STROKE, type StrokeAnalysis, type StrokeSample, analyzeStroke, describeStroke, tipGap } from './stroke'
import { type AiContext, type AiDecision, chooseShot, paramsForSkill } from '../../../packages/ai/src'
import { type AiLevel, levelById, levelsFor } from '../../../packages/ai/src/levels'
import { cueById } from '../../../packages/game/src/progress'
import '@fontsource/jua/400.css'
import '@fontsource/lilita-one/400.css'
import { careerStats, trendLine } from '../../../packages/game/src/stats'
import { type Account, api } from './api'
import { DEV_AUTH, onUser, signInDev, signInGoogle, signOutUser } from './auth'
import { Net, type ServerMsg } from './net'
import './style.css'

type Kind = 'solo' | 'versus' | 'ai' | 'online' | 'practice'
type Phase = 'menu' | 'aim' | 'think' | 'stroke' | 'run' | 'replay' | 'over'
type InputMode = 'stroke' | 'gauge' | 'numeric'
type Assist = 'none' | 'aim' | 'first' | 'full'

interface Session {
  /** 온라인 대전에서의 내 자리. 관전이면 -1 */
  seat?: number
  kind: Kind
  record: MatchRecord
  state: MatchState
  outcomes: ShotOutcome[]
}

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T
const show = (id: string, on: boolean) => $(id).classList.toggle('hide', !on)
const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi)
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

const canvas = $<HTMLCanvasElement>('cv')
const scene = new TableScene(canvas)

// ── 상태 ─────────────────────────────────────────────
let profile: Profile = loadProfile()
/** 로그인한 계정. 없으면 손님 (기록은 이 브라우저에만 남는다) */
let account: Account | null = null

/** 프로필을 남긴다. 손님이면 브라우저에, 로그인했으면 서버가 원본이라 저장하지 않는다. */
function keepProfile(): void {
  if (!account) saveProfile(profile)
}
let session: Session | null = null
let lastConfig: { kind: Kind; config: MatchConfig } | null = null
let phase: Phase = 'menu'
let inputMode: InputMode = 'stroke'
let assist: Assist = 'full'
let paused = false

let phi = 0
let thetaUser = 0
let side = 0
let top = 0
let gaugeSpeed = 2.5
let numericAccel = 0

let pending: { state: MatchState; outcome: ShotOutcome } | null = null
let result: ShotResult | null = null
let runT = 0
let nextEvent = 0
let clockLeft = 0
let practiceUndo: MatchState[] = []

const stroke = { ...DEFAULT_STROKE }
let samples: StrokeSample[] = []
let strokeSource: 'key' | 'pad' | null = null
let strokeY = 0
let strokeX = 0

/** 다시 보기 */
interface Replay {
  list: ShotOutcome[]
  record: MatchRecord
  idx: number
  t: number
  playing: boolean
  speed: number
  /** 닫았을 때 돌아갈 곳 */
  onClose: () => void
}
let replay: Replay | null = null

const cueItem = () => equippedCue(profile)
const table = (): TableProfile => session!.record.table
const balls = (): BallState[] => session!.state.balls
const cueBall = (): BallState => balls().find((b) => b.id === cueIdOf(session!.state.turn))!

function capture(el: Element, id: number): void {
  try {
    el.setPointerCapture(id)
  } catch {
    /* 잡지 못해도 동작에는 지장 없다 */
  }
}

/** 실제 고각: 큐가 허용하는 한계 안에서, 쿠션·다른 공에 걸리지 않도록 올린 값 */
function effectiveTheta(): number {
  const want = Math.min(thetaUser, cueItem().maxElevation) * DEG
  return clearElevation(table(), balls(), cueBall(), phi, want, side, top)
}

function shotInput(over: Partial<ShotInput> = {}): ShotInput {
  return {
    ballId: cueIdOf(session!.state.turn),
    phi,
    theta: effectiveTheta(),
    side,
    top,
    speed: Math.min(gaugeSpeed, cueItem().maxSpeed),
    accel: inputMode === 'numeric' ? numericAccel : 0,
    cue: cueItem().spec,
    ...over,
  }
}

// ── 화면 전환 ─────────────────────────────────────────
function layout(): void {
  const inGame = phase !== 'menu' && !(replay && !session)
  const dock = inGame ? $('dock').offsetWidth : 0
  scene.setInsets(dock, inGame ? 92 : 0, replay ? 96 : 0)
}

function showMenu(): void {
  // 온라인 경기 중에 나가면 기권이다
  if (session?.kind === 'online') leaveOnline()
  session = null
  replay = null
  pending = null
  result = null
  phase = 'menu'
  paused = false
  document.body.classList.remove('replaying')
  show('hud', false)
  show('replaybar', false)
  show('result', false)
  show('pause', false)
  show('menu', true)
  show('thinking', false)
  show('setup', false)
  for (const c of Array.from(document.querySelectorAll('.mode-card'))) c.classList.remove('on')
  // 메뉴 뒤로 보이는 테이블
  const t = tableFor('3cushion')
  const rec = newMatch({ discipline: '3cushion', players: [{ name: '', target: 1 }], rules: DEFAULT_RULES, shotClock: 0 }, 'bg', 0)
  scene.setTable(t, rec.initialBalls.map((b) => b.id))
  scene.setBalls(rec.initialBalls)
  scene.resetSpin()
  scene.setCue(false)
  scene.setAimLine(false)
  scene.setPrediction([])
  scene.attract = true
  scene.overview = false
  renderProfile()
  renderResume()
  layout()
}

/** 끝내지 않은 경기가 있으면 메뉴에 "이어서 하기" 를 보여 준다. */
function renderResume(): void {
  const c = loadCurrent()
  show('resumeBtn', !!c)
  if (!c) return
  const { state } = rebuild(c.record)
  const names = c.record.config.players.map((pl) => pl.name).join(' vs ')
  $('resumeInfo').textContent = `${disciplineName(c.record.config.discipline)} · ${names} · ${state.players.map((pl) => pl.score).join(' : ')}`
}

let setupMode: Kind = 'solo'
function openSetup(mode: Kind): void {
  setupMode = mode
  for (const c of Array.from(document.querySelectorAll<HTMLElement>('.mode-card'))) c.classList.toggle('on', c.dataset.mode === mode)
  $('setupTitle').textContent = mode === 'solo' ? '혼자 치기' : mode === 'versus' ? '2인 대전' : mode === 'ai' ? '컴퓨터 대전' : mode === 'online' ? '온라인 대전' : '연습'
  show('aiField', mode === 'ai')
  show('joinField', mode === 'online')
  $('setupEyebrow').textContent = mode === 'practice' ? '연습 설정' : '경기 설정'
  show('p1row', mode === 'versus')
  show('playersField', mode !== 'practice')
  show('clockField', mode !== 'practice')
  $<HTMLSelectElement>('shotClock').value = mode === 'versus' ? '40' : '0'
  $('start').textContent = mode === 'practice' ? '연습 시작' : mode === 'online' ? '방 만들기' : '경기 시작'
  fillTargets()
  renderLevels()
  show('setup', true)
}

/** 컴퓨터 수준 고르기. 내 다마수보다 두 단계 위까지 열려 있다. */
function renderLevels(): void {
  if (setupMode !== 'ai') return
  const mine = levelOf(profile.xp).damasu
  const list = levelsFor(setupDiscipline())
  const open = list.filter((l) => l.unlock <= mine)
  if (!open.some((l) => l.id === selectedLevel)) selectedLevel = open[Math.min(1, open.length - 1)]?.id ?? list[0].id
  $('aiLevels').innerHTML = list
    .map((l) => {
      const locked = l.unlock > mine
      const sub = locked ? `다마 ${l.unlock} 필요` : l.discipline === '4ball' ? `${l.target}개` : `AVG ${l.targetAvg.toFixed(2)}`
      return `<button class="lvl ${locked ? 'locked' : l.tier}${l.id === selectedLevel ? ' on' : ''}" data-id="${l.id}" ${locked ? 'disabled' : ''}>${esc(l.label)}<small>${sub}</small></button>`
    })
    .join('')
}

function setupDiscipline(): Discipline {
  return (document.querySelector<HTMLElement>('#segDisc button.on')?.dataset.v ?? '3cushion') as Discipline
}

function fillTargets(): void {
  const d = setupDiscipline()
  show('finishRow', d === '4ball' && setupMode !== 'practice')
  for (const id of ['p0target', 'p1target']) {
    const sel = $<HTMLSelectElement>(id)
    sel.innerHTML = ''
    if (d === '3cushion') {
      for (const n of [5, 10, 15, 20, 25, 30, 40]) sel.add(new Option(`${n}점`, String(n), n === 10, n === 10))
    } else {
      // 4구는 내 다마수를 기본 목표로 한다
      const mine = levelOf(profile.xp).damasu
      const list = [50, 80, 100, 120, 150, 200, 250, 300, 400, 500]
      const def = list.includes(mine) ? mine : 500
      for (const s of list) sel.add(new Option(`수지 ${s} · ${s / 10}개`, String(s / 10), s === def, s === def))
    }
  }
}

function startFromSetup(): void {
  const d = setupDiscipline()
  if (setupMode === 'online') {
    createRoom(d, Number($<HTMLSelectElement>('p0target').value), Number($<HTMLSelectElement>('shotClock').value))
    return
  }
  const name = (id: string, fallback: string) => $<HTMLInputElement>(id).value.trim() || fallback
  const players = [{ name: name('p0name', '플레이어 1'), target: Number($<HTMLSelectElement>('p0target').value) }]
  if (setupMode === 'versus') players.push({ name: name('p1name', '플레이어 2'), target: Number($<HTMLSelectElement>('p1target').value) })
  if (setupMode === 'practice') players[0] = { name: '연습', target: 99999 }
  const lv = setupMode === 'ai' ? levelById(selectedLevel) : undefined
  if (lv) players.push({ name: `컴퓨터 ${lv.discipline === '4ball' && lv.label !== '프로' ? '수지 ' : ''}${lv.label}`, target: lv.target })
  startMatch(setupMode, {
    discipline: d,
    ai: lv ? { player: 1, levelId: lv.id } : undefined,
    players,
    rules: { ...DEFAULT_RULES, finishWithThreeCushion: d === '4ball' && $<HTMLInputElement>('finish3c').checked },
    shotClock: setupMode === 'practice' ? 0 : Number($<HTMLSelectElement>('shotClock').value),
  })
}

/** 진행 중인 경기를 브라우저에 남긴다 (창을 닫아도 이어서 할 수 있게). 연습은 남기지 않는다. */
function persist(): void {
  if (!session || session.kind === 'practice' || session.kind === 'online') return
  if (session.state.finished) clearCurrent()
  else saveCurrent({ kind: session.kind, record: session.record })
}

function startMatch(kind: Kind, config: MatchConfig, startBalls?: BallState[], resume?: MatchRecord): void {
  lastConfig = { kind, config }
  const id = `m${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
  const record = resume ?? newMatch(config, id, Date.now())
  if (startBalls && !resume) record.initialBalls = startBalls.map(cloneBall)
  if (resume) {
    // 저장된 샷 입력을 처음부터 다시 계산해 그때의 상태로 돌아간다
    const re = rebuild(resume)
    session = { kind, record, state: re.state, outcomes: re.outcomes }
  } else {
    session = { kind, record, state: initialState(record), outcomes: [] }
    if (kind !== 'practice') clearCurrent()
  }
  replay = null
  pending = null
  result = null
  practiceUndo = []
  paused = false
  phase = 'aim'
  thetaUser = 0
  side = 0
  top = 0
  show('menu', false)
  show('result', false)
  show('pause', false)
  show('replaybar', false)
  show('hud', true)
  scene.attract = false
  scene.overview = false
  scene.setTable(record.table, record.initialBalls.map((b) => b.id))
  scene.resetSpin()
  scene.setBalls(balls())
  applyCue()
  aimAtNearest()
  resetClock()
  $('board').classList.toggle('solo', config.players.length === 1)
  show('btnUndo', kind === 'practice')
  renderBoard()
  renderShotCard(session.outcomes[session.outcomes.length - 1] ?? null)
  show('thinking', false)
  syncControls()
  layout()
  refreshAim()
  updateKeys()
  if (isAiTurn()) aiTurn()
}

/** 장착한 큐의 한계를 조작부와 화면에 반영한다. */
function applyCue(): void {
  const c = cueItem()
  scene.setCueStyle(c.colors.butt, c.colors.accent)
  stroke.maxSpeed = c.maxSpeed
  const sp = $<HTMLInputElement>('speed')
  sp.max = String(c.maxSpeed)
  gaugeSpeed = Math.min(gaugeSpeed, c.maxSpeed)
  const th = $<HTMLInputElement>('theta')
  th.max = String(c.maxElevation)
  thetaUser = Math.min(thetaUser, c.maxElevation)
  $('tippad').style.setProperty('--lim', `${50 - c.spec.miscueLimit * 50}%`)
  const lv = levelOf(profile.xp)
  $('cueChip').innerHTML = `<div><div class="t">${esc(c.name)}</div><div class="d num">최대 ${c.maxSpeed.toFixed(1)} m/s · 고각 ${c.maxElevation}° · 회전 ${c.spec.miscueLimit.toFixed(2)}</div></div><span class="lv num">다마 ${lv.damasu}</span>`
}

function aimAtNearest(): void {
  const c = cueBall()
  let best: BallState | null = null
  for (const b of balls()) {
    if (b.id === c.id || b.s === 'out') continue
    if (!best || Math.hypot(b.r[0] - c.r[0], b.r[1] - c.r[1]) < Math.hypot(best.r[0] - c.r[0], best.r[1] - c.r[1])) best = b
  }
  if (best) phi = Math.atan2(best.r[1] - c.r[1], best.r[0] - c.r[0])
}

function resetClock(): void {
  clockLeft = session?.record.config.shotClock ?? 0
  const on = clockLeft > 0 && session?.kind !== 'practice' && !isAiTurn()
  if (session?.kind === 'online') clockLeft = netDeadline > 0 ? Math.max(0, (netDeadline - (Date.now() + netOffset)) / 1000) : 0
  show('clock', on)
  renderClock()
}

function renderClock(): void {
  const total = session?.record.config.shotClock ?? 0
  if (!total) return
  const el = $('clock')
  ;(el.firstElementChild as HTMLElement).style.transform = `scaleX(${clamp(clockLeft / total, 0, 1)})`
  el.classList.toggle('warn', clockLeft <= 10)
}

// ── 컴퓨터 상대 ───────────────────────────────────────
let aiWorker: Worker | null = null
let aiToken = 0
let selectedLevel = ''

function aiLevel(): AiLevel | undefined {
  const a = session?.record.config.ai
  return a ? levelById(a.levelId) : undefined
}
const isAiTurn = () => !!session && session.kind === 'ai' && session.state.turn === session.record.config.ai?.player

/** 컴퓨터에게 샷을 고르게 한다. 워커를 쓸 수 없으면 그 자리에서 계산한다. */
function askAi(ctx: AiContext): Promise<AiDecision> {
  return new Promise((resolve) => {
    const id = ++aiToken
    try {
      if (!aiWorker) aiWorker = new Worker(new URL('./aiWorker.ts', import.meta.url), { type: 'module' })
      const w = aiWorker
      const done = (e: MessageEvent<{ id: number; decision: AiDecision }>) => {
        if (e.data.id !== id) return
        w.removeEventListener('message', done)
        resolve(e.data.decision)
      }
      w.addEventListener('message', done)
      w.addEventListener(
        'error',
        () => {
          aiWorker = null
          resolve(chooseShot(ctx))
        },
        { once: true },
      )
      w.postMessage({ id, ctx })
    } catch {
      resolve(chooseShot(ctx))
    }
  })
}

/** 컴퓨터 차례: 생각하는 동안 표시를 띄우고, 고른 방향으로 큐를 겨눈 뒤 친다. */
function aiTurn(): void {
  const level = aiLevel()
  if (!session || !level || phase !== 'aim') return
  phase = 'think'
  setThinking('컴퓨터가 생각하는 중')
  scene.setCue(false)
  scene.setAimLine(false)
  scene.setPrediction([])
  updateKeys()
  const mine = session
  const cue = cueById(level.cue)
  const started = performance.now()
  void askAi({
    table: table(),
    discipline: mine.record.config.discipline,
    rules: mine.record.config.rules,
    balls: balls(),
    cueId: cueIdOf(mine.state.turn),
    finishing: mine.state.players[mine.state.turn].finishing,
    cue: cue.spec,
    maxSpeed: cue.maxSpeed,
    params: paramsForSkill(level.skill),
    seed: (mine.record.createdAt + mine.record.shots.length * 7919) >>> 0,
  }).then((dec) => {
    const wait = Math.max(0, dec.thinkMs * 0.6 - (performance.now() - started))
    window.setTimeout(() => {
      // 그 사이 경기가 바뀌었으면 버린다
      if (session !== mine || phase !== 'think') return
      // 겨누는 모습을 잠깐 보여 준다
      const c = cueBall()
      scene.setCueStyle(cue.colors.butt, cue.colors.accent)
      scene.setCue(true, c, dec.intended.phi, dec.intended.theta, dec.intended.side, dec.intended.top, stroke.startGap)
      scene.aimCamera(c, dec.intended.phi, dec.intended.theta)
      window.setTimeout(() => {
        if (session !== mine || phase !== 'think') return
        setThinking(null)
        fire(dec.executed, null)
      }, 700)
    }, wait)
  })
}

/** 사람 차례면 조준 화면으로, 컴퓨터 차례면 컴퓨터에게 넘긴다. */
function nextTurn(): void {
  if (session?.kind === 'online' && !isMyTurn()) {
    // 상대 차례(또는 관전): 입력을 막고 상대의 조준을 보여 준다
    phase = 'think'
    setThinking(session.seat === -1 ? `${session.record.config.players[session.state.turn].name} 차례` : '상대 차례')
    scene.setCue(false)
    scene.setAimLine(false)
    scene.setPrediction([])
    updateKeys()
    drainNet()
    return
  }
  setThinking(null)
  if (isAiTurn()) aiTurn()
  else {
    applyCue()
    syncControls()
    refreshAim()
    updateKeys()
  }
}

// ── 온라인 대전 ───────────────────────────────────────
let netDeadline = 0
let netOffset = 0
let netProfile: Profile | null = null
let netQueue: Extract<ServerMsg, { t: 'shot' }>[] = []
let afterLogin: (() => void) | null = null
const isMyTurn = () => !!session && (session.kind !== 'online' || session.seat === session.state.turn)

const net = new Net(onNet, (connected) => {
  show('netbar', !connected && session?.kind === 'online' && phase !== 'over')
})
// 공이 구르는 동안에는 서버에 새 샷을 물어보지 않는다
net.paused = () => phase === 'run'

function setThinking(text: string | null): void {
  show('thinking', text !== null)
  if (text !== null) $('thinking').firstChild!.textContent = text
}

function createRoom(discipline: Discipline, target: number, shotClock: number): void {
  if (!account) return
  netProfile = null
  $('lobbyMsg').textContent = ''
  void net.create({ discipline, target, shotClock })
}

function joinRoom(code: string): void {
  const c = code.trim().toUpperCase()
  if (!c) return
  if (!account) {
    afterLogin = () => joinRoom(c)
    openAccount()
    $('acctMsg').textContent = '온라인 대전은 로그인이 필요합니다'
    return
  }
  netProfile = null
  void net.join(c, Number($<HTMLSelectElement>('p0target').value) || undefined)
}

function leaveOnline(): void {
  net.leave()
  netQueue = []
  netDeadline = 0
  show('lobby', false)
  show('netbar', false)
  setThinking(null)
  history.replaceState(null, '', location.pathname)
}

/** 서버의 기록으로 화면을 맞춘다 (처음 시작, 다시 들어옴, 어긋남 복구). */
function syncOnline(m: Extract<ServerMsg, { t: 'room' }>): void {
  if (!m.record || !m.config) return
  startMatch('online', m.config, undefined, m.record)
  session!.seat = m.you
  netQueue = []
  renderBoard()
  if (session!.state.finished) {
    endMatch()
    return
  }
  phase = 'aim'
  aimAtNearest()
  resetClock()
  nextTurn()
}

/** 서버가 확정한 샷을 적용한다. 공이 구르는 중이면 끝난 뒤에 한다. */
function drainNet(): void {
  while (session?.kind === 'online' && netQueue.length > 0 && (phase === 'think' || phase === 'aim' || phase === 'stroke')) {
    const m = netQueue[0]
    const have = session.record.shots.length
    if (m.index < have) {
      netQueue.shift()
      continue
    }
    if (m.index > have) {
      // 중간 샷을 놓쳤다. 서버의 기록을 통째로 다시 받는다
      netQueue = []
      void net.join(net.room)
      return
    }
    netQueue.shift()
    netDeadline = m.deadline
    netOffset = m.serverNow - Date.now()
    if (phase === 'stroke') cancelStroke()
    setThinking(null)
    if (m.shot.input) {
      commitShot(m.shot)
      return
    }
    // 시간 초과나 기권: 공은 움직이지 않는다
    const r = play(session.record, session.state, m.shot)
    session.state = r.state
    session.outcomes.push(r.outcome)
    renderBoard()
    const who = session.record.config.players
    if (session.state.finished) {
      banner('good', '경기 종료', m.shot.forfeit ? `${who[m.shot.player].name} 기권` : '')
      endMatch()
      return
    }
    banner('foul', '시간 초과', `다음 ${who[session.state.turn].name}`)
    phase = 'aim'
    aimAtNearest()
    resetClock()
    nextTurn()
  }
}

function onNet(m: ServerMsg): void {
  switch (m.t) {
    case 'room': {
      netDeadline = m.deadline
      netOffset = m.serverNow - Date.now()
      if (m.status === 'waiting') {
        $('lobbyCode').textContent = m.code
        $('lobbyMsg').textContent = ''
        show('setup', false)
        show('lobby', true)
        history.replaceState(null, '', `?room=${m.code}`)
        return
      }
      show('lobby', false)
      show('netbar', false)
      // 같은 경기를 이미 같은 데까지 보고 있으면 그대로 둔다
      if (session?.kind === 'online' && m.record && session.record.id === m.record.id && session.record.shots.length === m.record.shots.length && phase !== 'run') {
        session.seat = m.you
        return
      }
      syncOnline(m)
      return
    }
    case 'shot':
      netQueue.push(m)
      drainNet()
      return
    case 'check':
      // 서버가 계산한 상태와 내 계산이 다르면 서버의 기록으로 다시 맞춘다
      if (session?.kind === 'online' && phase !== 'run' && netQueue.length === 0 && session.record.shots.length === m.total && stateSig(session.state) !== m.sig) {
        void net.join(net.room)
      }
      return
    case 'presence':
      if (session?.kind === 'online' && m.seat !== session.seat) {
        banner(m.connected ? 'good' : 'foul', m.connected ? '상대 복귀' : '상대 연결 끊김', m.connected ? '' : '60초 동안 기다립니다')
      }
      return
    case 'over':
      netProfile = m.profile
      if (m.profile && phase === 'over') {
        profile = m.profile
        renderProfile()
      }
      return
    case 'error':
      if (!$('lobby').classList.contains('hide')) $('lobbyMsg').textContent = m.message
      else if (session?.kind === 'online') {
        banner('foul', '알림', m.message)
        // 보낸 샷이 거절되었으면 다시 조준할 수 있게 한다
        if (phase === 'think' && isMyTurn()) {
          phase = 'aim'
          nextTurn()
        }
      } else if (!$('setup').classList.contains('hide') || phase === 'menu') alert(m.message)
      return
    default:
      return
  }
}

$('joinBtn').addEventListener('click', () => joinRoom($<HTMLInputElement>('joinCode').value))
$('joinCode').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') joinRoom($<HTMLInputElement>('joinCode').value)
})
$('lobbyCancel').addEventListener('click', leaveOnline)
$('lobbyCopy').addEventListener('click', () => {
  const link = `${location.origin}${location.pathname}?room=${net.room}`
  void navigator.clipboard
    ?.writeText(link)
    .then(() => ($('lobbyMsg').textContent = '초대 링크를 복사했습니다'))
    .catch(() => ($('lobbyMsg').textContent = link))
})

// ── 샷 ───────────────────────────────────────────────
function fire(shot: ShotInput, analysis: StrokeAnalysis | null): void {
  if (!session || (phase !== 'aim' && phase !== 'stroke' && phase !== 'think')) return
  if (!(shot.speed > 0.02)) return
  if (session.kind === 'practice') {
    practiceUndo.push(structuredClone(session.state))
    if (practiceUndo.length > 60) practiceUndo.shift()
  }
  const meta = analysis
    ? { accel: analysis.accel, backswing: analysis.backswing, aimError: analysis.aimError, label: describeStroke(analysis) }
    : undefined
  if (session.kind === 'online') {
    // 온라인: 서버에 보내고, 서버가 확정해 돌려준 샷을 재생한다
    if (!isMyTurn()) return
    endStrokeInput()
    phase = 'think'
    setThinking('보내는 중')
    scene.setPrediction([])
    void net.shot(shot, meta)
    updateKeys()
    return
  }
  commitShot({ player: session.state.turn, input: shot, stroke: meta })
}

/** 확정된 샷을 경기에 적용하고 공이 구르는 화면으로 넘어간다. */
function commitShot(rec: ShotRecord): void {
  if (!session || !rec.input) return
  const shot = rec.input
  pending = play(session.record, session.state, rec)
  result = pending.outcome.result ?? null
  runT = 0
  nextEvent = 1
  phase = 'run'
  endStrokeInput()
  scene.setCue(false)
  scene.setAimLine(false)
  scene.setPrediction([])
  scene.overview = true
  playStrike(shot.speed, result?.events[0]?.miscue === true)
  updateKeys()
}

function finishShot(): void {
  if (!session || !pending) return
  const before = session.state
  const { outcome } = pending
  session.state = pending.state
  session.outcomes.push(outcome)
  pending = null
  persist()
  scene.setBalls(balls())
  scene.overview = false
  const j = outcome.judgement
  const who = session.record.config.players
  const turnChanged = session.state.turn !== before.turn
  const run = session.state.players[outcome.player].run

  renderBoard(j.scored ? outcome.player : -1)
  renderShotCard(outcome)

  if (session.state.finished && session.kind !== 'practice') {
    banner('good', '경기 종료', `${who[session.state.winner].name} ${session.state.players[session.state.winner].score}점`)
    endMatch()
    return
  }
  if (j.scored) banner('good', run >= 2 ? `${run}연속 득점` : '득점', j.reason)
  else if (j.foul) banner('foul', '파울', j.reason + (turnChanged ? ` · 다음 ${who[session.state.turn].name}` : ''))
  else banner('bad', '실패', j.reason + (turnChanged ? ` · 다음 ${who[session.state.turn].name}` : ''))

  phase = 'aim'
  if (turnChanged) aimAtNearest()
  resetClock()
  nextTurn()
  drainNet()
}

function timeUp(): void {
  if (!session || (phase !== 'aim' && phase !== 'stroke')) return
  if (phase === 'stroke') cancelStroke()
  const r = play(session.record, session.state, { player: session.state.turn, timeout: true })
  session.state = r.state
  session.outcomes.push(r.outcome)
  persist()
  banner('foul', '시간 초과', `다음 ${session.record.config.players[session.state.turn].name}`)
  renderBoard()
  aimAtNearest()
  resetClock()
  nextTurn()
}

function endMatch(): void {
  if (!session) return
  phase = 'over'
  const online = session.kind === 'online'
  const seat = online ? Math.max(session.seat ?? 0, 0) : 0
  if (online) {
    setThinking(null)
    // 온라인 기록은 서버가 이미 저장했다. 이 브라우저의 "내 기록" 에도 내 자리 기준으로 남긴다
    if ((session.seat ?? -1) >= 0) saveMatch({ ...session.record, viewSeat: seat, online: true })
  } else {
    saveMatch(session.record)
    clearCurrent()
  }
  const wonVersus = (session.kind === 'versus' || session.kind === 'ai' || online) && session.state.winner === seat
  const { profile: next, reward } = applyReward(profile, session.state.players[seat].score, session.state.finished, wonVersus)
  profile = next
  keepProfile()
  // 서버가 보낸 프로필이 먼저 와 있으면 그것이 원본이다
  if (online && netProfile) profile = netProfile
  if (account && !online) {
    // 서버가 기록을 다시 계산해 보상을 정한다. 서버 값이 원본이다.
    const rec = session.record
    void api
      .addMatch(rec)
      .then((r) => {
        profile = r.profile
        renderProfile()
      })
      .catch(() => queueUnsynced(rec.id))
  }
  scene.setCue(false)
  scene.setAimLine(false)
  scene.setPrediction([])
  updateKeys()
  window.setTimeout(() => {
    if (phase === 'over' && session) showResult(session.record, session.state, session.kind === 'online' && (session.seat ?? -1) < 0 ? null : reward, false)
  }, 1300)
}

function undo(): void {
  if (!session || session.kind !== 'practice' || phase !== 'aim' || practiceUndo.length === 0) return
  session.state = practiceUndo.pop()!
  session.record.shots.pop()
  session.outcomes.pop()
  scene.setBalls(balls())
  refreshAim()
}

// ── 조준 화면 ─────────────────────────────────────────
function predictionPaths(): [number, number][][] {
  if (assist === 'none' || assist === 'aim') return []
  const res = simulate(table(), balls(), shotInput())
  let tEnd = res.duration
  if (assist === 'first') {
    const cueId = cueIdOf(session!.state.turn)
    const first = res.events.find((e) => e.type === 'ball-ball' && e.ids.includes(cueId))
    tEnd = first ? first.t + 0.35 : Math.min(res.duration, 1.5)
  }
  return samplePaths(table(), res, tEnd)
}

function samplePaths(t: TableProfile, res: ShotResult, tEnd: number): [number, number][][] {
  const n = res.final.length
  const paths: [number, number][][] = Array.from({ length: n }, () => [])
  const step = Math.max(0.008, tEnd / 900)
  for (let time = 0; time <= tEnd; time += step) {
    stateAt(t, res, time).forEach((b, i) => {
      if (b.s !== 'out') paths[i].push([b.r[0], b.r[1]])
    })
  }
  // 움직이지 않은 공은 그리지 않는다
  return paths.map((p) => (p.length > 1 && Math.hypot(p[0][0] - p[p.length - 1][0], p[0][1] - p[p.length - 1][1]) < 1e-4 ? [] : p))
}

function refreshAim(): void {
  if (!session || (phase !== 'aim' && phase !== 'stroke')) return
  const c = cueBall()
  const th = effectiveTheta()
  const gap = phase === 'stroke' ? Math.max(tipGap(samples, stroke), 0) : stroke.startGap
  scene.setCue(true, c, phi, th, side, top, gap)
  scene.aimCamera(c, phi, th)
  scene.setAimLine(assist !== 'none', c, phi)
  if (phase === 'aim') scene.setPrediction(predictionPaths())
  const want = Math.min(thetaUser, cueItem().maxElevation)
  const raised = th > want * DEG + 1e-6
  $('thetaO').textContent = raised ? `${Math.round(th / DEG)}°↑` : `${want}°`
  $('thetaO').title = raised ? '쿠션이나 다른 공 때문에 큐를 들어야 합니다' : ''
}

// ── 스트로크 입력 ──────────────────────────────────────
function beginStroke(source: 'key' | 'pad', t: number): void {
  if (phase !== 'aim' || inputMode !== 'stroke' || paused) return
  phase = 'stroke'
  strokeSource = source
  strokeY = 0
  strokeX = 0
  samples = [{ t, y: 0, x: 0 }]
  $('strokepad').classList.add('active')
  scene.setPrediction([])
  updateKeys()
}

/** 포인터가 움직인 만큼(px) 큐를 움직인다. 화면 위쪽이 공 쪽이다. */
function strokeMove(dx: number, dy: number, t: number): void {
  if (phase !== 'stroke') return
  strokeY -= dy
  strokeX += dx
  samples.push({ t, y: strokeY, x: strokeX })
  if (samples.length > 600) samples.splice(1, samples.length - 600)
  $('strokebar').style.top = `${clamp(50 - strokeY * 0.12, 16, 84)}%`
  const a = analyzeStroke(samples, stroke)
  if (a) {
    if (a.speed < 0.05) {
      cancelStroke()
      return
    }
    fire(shotInput({ speed: a.speed, accel: a.accel, phi: phi + a.aimError, side: clamp(side + a.sideError, -0.9, 0.9) }), a)
  } else {
    refreshAim()
  }
}

function endStrokeInput(): void {
  strokeSource = null
  samples = []
  $('strokepad').classList.remove('active')
  $('strokebar').style.top = '50%'
  if (document.pointerLockElement) document.exitPointerLock()
}

function cancelStroke(): void {
  if (phase !== 'stroke') return
  phase = 'aim'
  endStrokeInput()
  refreshAim()
  updateKeys()
}

// ── 표시 ─────────────────────────────────────────────
function banner(kind: 'good' | 'bad' | 'foul', main: string, sub: string): void {
  const el = $('banner')
  $('bannerMain').textContent = main
  $('bannerSub').textContent = sub
  el.className = ''
  void el.offsetWidth // 애니메이션을 처음부터 다시
  el.className = `show ${kind}`
}

function renderBoard(bumped = -1): void {
  if (!session) return
  const { record, state, kind } = session
  $('bMode').textContent = disciplineName(record.config.discipline) + (kind === 'practice' ? ' 연습' : '')
  const cur = state.players[state.turn]
  $('bInn').textContent = String(cur.innings)
  $('bRun').textContent = String(cur.run)
  const sides = Array.from(document.querySelectorAll<HTMLElement>('#board .side'))
  sides.forEach((el, i) => {
    const p = state.players[i]
    el.classList.toggle('hide', !p)
    if (!p) return
    el.classList.toggle('active', state.turn === i && !state.finished)
    el.querySelector('.name')!.textContent = record.config.players[i].name + (kind === 'online' && session!.seat === i ? ' (나)' : '') + (p.finishing ? ' · 마무리' : '')
    el.querySelector('.avg')!.textContent = average(p).toFixed(3)
    el.querySelector('.hr')!.textContent = String(p.highRun)
    el.querySelector('.tgt')!.textContent = kind === 'practice' ? '-' : String(p.target)
    const pts = el.querySelector<HTMLElement>('.pts')!
    pts.textContent = String(p.score)
    if (i === bumped) {
      pts.classList.remove('bump')
      void pts.offsetWidth
      pts.classList.add('bump')
    }
  })
}

function renderShotCard(o: ShotOutcome | null): void {
  const el = $('shotcard')
  if (!o || !o.shot.input) {
    el.innerHTML = `<div class="head"><span class="eyebrow">방금 친 샷</span></div><div class="empty">아직 치지 않았습니다. 조준하고 스트로크하세요.</div>`
    return
  }
  const s = o.shot.input
  const j = o.judgement
  const cls = j.scored ? 'good' : j.foul ? 'foul' : 'bad'
  const tip =
    Math.abs(s.side) < 0.03 && Math.abs(s.top) < 0.03
      ? '중심'
      : `${Math.abs(s.side) >= 0.03 ? (s.side > 0 ? '우' : '좌') + Math.abs(s.side).toFixed(2) : ''} ${Math.abs(s.top) >= 0.03 ? (s.top > 0 ? '상' : '하') + Math.abs(s.top).toFixed(2) : ''}`.trim()
  const contact = ((o.result?.events[0]?.contactTime ?? 0) * 1000).toFixed(2)
  const miscue = o.result?.events[0]?.miscue ? ' · 미스큐' : ''
  el.innerHTML = `
    <div class="head"><span class="eyebrow">방금 친 샷</span><span class="verdict ${cls}">${esc(j.reason)}${miscue}</span></div>
    <div class="tiles num">
      <div class="tile"><div class="k">큐 속도</div><div class="v">${s.speed.toFixed(2)}<small>m/s</small></div></div>
      <div class="tile"><div class="k">고각</div><div class="v">${(s.theta / DEG).toFixed(0)}<small>°</small></div></div>
      <div class="tile"><div class="k">팁 접촉</div><div class="v">${contact}<small>ms</small></div></div>
      <div class="tile wide"><span class="k">당점</span><span class="v">${tip}</span></div>
      <div class="tile wide"><span class="k">쿠션 (두 번째 공 전)</span><span class="v">${j.cushionsBeforeSecond}개</span></div>
      ${
        o.shot.stroke
          ? `<div class="tile wide"><span class="k">타법</span><span class="v">${esc(o.shot.stroke.label)}</span></div>
             <div class="tile wide"><span class="k">가속도 · 백스윙 · 흔들림</span><span class="v">${o.shot.stroke.accel.toFixed(0)}m/s² · ${(o.shot.stroke.backswing * 100).toFixed(0)}cm · ${(Math.abs(o.shot.stroke.aimError) / DEG).toFixed(2)}°</span></div>`
          : ''
      }
    </div>`
}

function updateKeys(): void {
  const el = $('keys')
  const k = (s: string) => `<kbd>${s}</kbd>`
  if (phase === 'run') el.textContent = '공이 구르는 중…'
  else if (phase === 'think') el.textContent = '컴퓨터 차례입니다'
  else if (phase === 'stroke') el.innerHTML = `마우스를 아래로 당겼다가 위로 밀어 칩니다 · 손을 떼면 취소`
  else if (phase === 'over') el.textContent = '경기가 끝났습니다'
  else if (inputMode === 'stroke') el.innerHTML = `조준 드래그·${k('A')}${k('D')} · 고각 ${k('W')}${k('S')} · ${k('Space')} 누른 채 당겼다 밀기 · 다시 보기 ${k('R')}`
  else el.innerHTML = `조준 드래그·${k('A')}${k('D')} · 고각 ${k('W')}${k('S')} · 치기 ${k('Enter')} · 다시 보기 ${k('R')}`
}

function syncControls(): void {
  const c = cueItem()
  $<HTMLInputElement>('theta').value = String(Math.min(thetaUser, c.maxElevation))
  $<HTMLInputElement>('speed').value = String(gaugeSpeed)
  $('speedO').textContent = `${gaugeSpeed.toFixed(1)} m/s`
  $('speedLabel').textContent = inputMode === 'stroke' ? '예상 속도' : '큐 속도'
  $('sensO').textContent = `${(stroke.metersPerPx * 1000).toFixed(2)}mm`
  $('tipdot').style.left = `${50 + side * 50}%`
  $('tipdot').style.top = `${50 - top * 50}%`
  const off = Math.hypot(side, top)
  const parts: string[] = []
  if (Math.abs(side) >= 0.03) parts.push(`${side > 0 ? '오른쪽' : '왼쪽'} ${Math.abs(side).toFixed(2)}`)
  if (Math.abs(top) >= 0.03) parts.push(`${top > 0 ? '위' : '아래'} ${Math.abs(top).toFixed(2)}`)
  const risky = off > c.spec.miscueLimit
  $('tipval').innerHTML = `<b style="${risky ? 'color:var(--bad)' : ''}">${risky ? '미스큐 위험' : parts.length ? parts.join(' · ') : '중심'}</b>${risky ? parts.join(' · ') : `점선 = 이 큐의 한계 ${c.spec.miscueLimit.toFixed(2)}`}`
  show('shoot', inputMode !== 'stroke')
  show('numeric', inputMode === 'numeric')
  show('strokepad', inputMode === 'stroke' && phase !== 'replay')
  if (inputMode === 'numeric') {
    $<HTMLInputElement>('nPhi').value = (phi / DEG).toFixed(1)
    $<HTMLInputElement>('nSide').value = side.toFixed(2)
    $<HTMLInputElement>('nTop').value = top.toFixed(2)
  }
}

// ── 결과 화면과 기록지 ─────────────────────────────────
function sheetHtml(record: MatchRecord, state: MatchState): string {
  const cols = Math.max(...state.players.map((p) => p.inningPoints.length), 1)
  let h = '<tr><th style="text-align:left">이닝</th>'
  for (let i = 1; i <= cols; i++) h += `<th>${i}</th>`
  h += '<th>합계</th><th>AVG</th></tr>'
  state.players.forEach((p, i) => {
    const best = Math.max(...p.inningPoints, 0)
    h += `<tr><td class="nm">${esc(record.config.players[i].name)}</td>`
    for (let k = 0; k < cols; k++) {
      const v = p.inningPoints[k]
      if (v === undefined) h += '<td class="z">·</td>'
      else h += `<td class="${v < 0 ? 'neg' : v === 0 ? 'z' : v === best && best > 1 ? 'hi' : ''}">${v}</td>`
    }
    h += `<td class="tot">${p.score}</td><td>${average(p).toFixed(3)}</td></tr>`
  })
  return h
}

function showResult(record: MatchRecord, state: MatchState, reward: Reward | null, review: boolean): void {
  const sum = summarize(record, state)
  const two = sum.length > 1
  $('resEyebrow').textContent = `${disciplineName(record.config.discipline)} · ${new Date(record.createdAt).toLocaleString('ko-KR', { dateStyle: 'medium', timeStyle: 'short' })}`
  $('resTitle').innerHTML = two
    ? state.winner >= 0
      ? `<em>${esc(sum[state.winner].name)}</em> 승리`
      : '경기 중단'
    : state.finished
      ? `목표 <em>달성</em>`
      : '경기 중단'
  $('resLead').textContent = two
    ? `${sum[0].score} : ${sum[1].score} · ${Math.max(sum[0].innings, sum[1].innings)}이닝`
    : `${sum[0].innings}이닝 · 에버리지 ${sum[0].average.toFixed(3)} · 하이런 ${sum[0].highRun}`
  const cards = $('resCards')
  cards.className = `vs${two ? '' : ' one'}`
  cards.innerHTML = sum
    .map(
      (p, i) => `
      <div class="pcard${state.winner === i && two ? ' win' : ''}">
        ${state.winner === i && two ? '<span class="crown">WIN</span>' : ''}
        <div class="pname"><span class="balldot ${i === 0 ? 'w' : 'y'}"></span>${esc(p.name)}</div>
        <div class="pscore num">${p.score}<small> / ${p.target}</small></div>
        <div class="stats num">
          <div class="tile"><div class="k">에버리지</div><div class="v">${p.average.toFixed(3)}</div></div>
          <div class="tile"><div class="k">하이런</div><div class="v">${p.highRun}</div></div>
          <div class="tile"><div class="k">성공률</div><div class="v">${Math.round(p.successRate * 100)}<small>%</small></div></div>
          <div class="tile"><div class="k">이닝 · 파울</div><div class="v">${p.innings}<small>· ${p.fouls}</small></div></div>
        </div>
      </div>`,
    )
    .join('')
  $('resSheet').innerHTML = sheetHtml(record, state)

  const rw = $('resReward')
  if (reward) {
    const lv = levelOf(profile.xp)
    rw.innerHTML = `
      <div class="reward num">
        <span class="gain">+${reward.xp} 경험치</span>
        <span class="gain"><i class="coin"></i>+${reward.coins}</span>
        ${reward.levelUp ? `<span class="up">승급! 다마 ${reward.levelUp[0]} → ${reward.levelUp[1]}</span>` : ''}
        ${reward.unlocked.length ? `<span class="tag2 on">새 큐 구매 가능: ${reward.unlocked.map((c) => esc(c.name)).join(', ')}</span>` : ''}
        <div class="xpwrap"><div class="xpbar"><i style="width:${Math.round(lv.progress * 100)}%"></i></div>
        <div class="d">다마 ${lv.damasu}${lv.next ? ` · 다음 ${lv.next} 까지 ${lv.remaining} 경험치` : ' · 최고 단계'}</div></div>
      </div>`
  } else rw.innerHTML = ''

  show('resAgain', !review && session?.kind !== 'online')
  $('resReplay').onclick = () => openReview(record, () => showResult(record, state, null, review))
  $('resMenu').textContent = review ? '닫기' : '메뉴로'
  $('resMenu').onclick = () => {
    show('result', false)
    if (review) openHistory()
    else showMenu()
  }
  show('result', true)
}

// ── 다시 보기 ─────────────────────────────────────────
function startReplay(list: ShotOutcome[], record: MatchRecord, idx: number, onClose: () => void): void {
  const playable = list.filter((o) => o.result)
  if (playable.length === 0) return
  replay = { list: playable, record, idx: clamp(idx, 0, playable.length - 1), t: 0, playing: true, speed: 1, onClose }
  phase = 'replay'
  scene.attract = false
  scene.overview = false
  scene.setCue(false)
  scene.setAimLine(false)
  if (scene.view === 'aim') setView('top')
  show('replaybar', true)
  document.body.classList.add('replaying')
  $('replaybar').classList.toggle('full', !session)
  show('keys', false)
  show('strokepad', false)
  setSeg('rpSpeed', '1')
  layout()
  loadReplayShot()
}

function loadReplayShot(): void {
  if (!replay) return
  const o = replay.list[replay.idx]
  replay.t = 0
  replay.playing = true
  scene.resetSpin()
  scene.setBalls(o.before)
  // 궤적선: 이 샷의 전체 경로
  scene.setPrediction(samplePaths(replay.record.table, o.result!, o.result!.duration))
  const name = replay.record.config.players[o.player]?.name ?? ''
  $('rpLabel').textContent = `${replay.idx + 1} / ${replay.list.length} · ${o.inning}이닝 · ${name} · ${o.judgement.reason}`
  $('rpPlay').textContent = '⏸'
  renderShotCard(o)
}

function closeReplay(): void {
  if (!replay) return
  const done = replay.onClose
  replay = null
  show('replaybar', false)
  document.body.classList.remove('replaying')
  show('keys', true)
  scene.setPrediction([])
  done()
}

/** 방금 친 샷 다시 보기 */
function instantReplay(): void {
  if (!session || phase !== 'aim' || session.outcomes.length === 0) return
  const list = session.outcomes
  const prevView = scene.view
  startReplay(list, session.record, list.filter((o) => o.result).length - 1, () => {
    phase = 'aim'
    setView(prevView)
    scene.setBalls(balls())
    renderShotCard(session!.outcomes[session!.outcomes.length - 1] ?? null)
    syncControls()
    layout()
    refreshAim()
    updateKeys()
  })
}

/** 저장된 경기 전체 다시 보기 */
function openReview(record: MatchRecord, back: () => void): void {
  const { outcomes } = rebuild(record)
  show('result', false)
  show('history', false)
  show('menu', false)
  const hadSession = session
  if (!hadSession) {
    scene.setTable(record.table, record.initialBalls.map((b) => b.id))
    show('hud', false)
  }
  startReplay(outcomes, record, 0, () => {
    if (!hadSession) {
      phase = 'menu'
      scene.attract = true
      show('menu', true)
      layout()
    } else {
      phase = 'over'
      scene.setBalls(balls())
      layout()
    }
    back()
  })
}

// ── 지난 경기 ─────────────────────────────────────────
let histFilter: 'all' | Discipline = 'all'

/** 통산 기록과 에버리지 추이 */
function renderCareer(all: MatchRecord[]): void {
  const st = careerStats(all, histFilter === 'all' ? undefined : histFilter)
  const tile = (k: string, v: string, unit = '') => `<div class="tile"><div class="k">${k}</div><div class="v">${v}<small>${unit}</small></div></div>`
  let chart = '<div class="none">경기를 끝내면 에버리지 추이가 여기에 그려집니다.</div>'
  const recent = st.trend.slice(-20)
  const pts = trendLine(recent)
  if (pts.length > 0) {
    const W = 600
    const H = 100
    const X = (x: number) => 8 + x * (W - 16)
    const Y = (y: number) => H - 6 - y * (H - 18)
    const line = pts.map((q, i) => `${i ? 'L' : 'M'}${X(q.x).toFixed(1)},${Y(q.y).toFixed(1)}`).join(' ')
    const area = `${line} L${X(pts[pts.length - 1].x).toFixed(1)},${H} L${X(pts[0].x).toFixed(1)},${H} Z`
    const dots = pts
      .map((q, i) => {
        const m = recent[i]
        const cls = m.won === null ? '' : m.won ? ' win' : ' lose'
        return `<circle class="pt${cls}" cx="${X(q.x).toFixed(1)}" cy="${Y(q.y).toFixed(1)}" r="5"><title>${new Date(m.createdAt).toLocaleDateString('ko-KR')} · 에버리지 ${q.value.toFixed(3)}${m.opponent ? ` · ${esc(m.opponent)}` : ''}</title></circle>`
      })
      .join('')
    const best = Math.max(...recent.map((m) => m.average))
    chart = `<div class="cap"><span>최근 ${recent.length}경기 에버리지</span><span class="num">최고 ${best.toFixed(3)}</span></div>
      <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none"><path class="ar" d="${area}"/><path class="ln" d="${line}"/>${dots}</svg>`
  }
  $('histStats').innerHTML = `
    <div class="career num">
      ${tile('경기', String(st.games))}
      ${tile('에버리지', st.average.toFixed(3))}
      ${tile('하이런', String(st.highRun))}
      ${tile('성공률', String(Math.round(st.successRate * 100)), '%')}
      ${tile('승률', st.versusGames ? String(Math.round(st.winRate * 100)) : '-', st.versusGames ? `% · ${st.wins}/${st.versusGames}` : '')}
    </div>
    <div class="trend">${chart}</div>`
}

function openHistory(): void {
  const every = loadMatches()
  renderCareer(every)
  const list = every.filter((m) => histFilter === 'all' || m.config.discipline === histFilter)
  const el = $('histList')
  if (list.length === 0) {
    el.innerHTML = '<div class="hempty">아직 끝낸 경기가 없습니다. 혼자 치기나 2인 대전을 끝까지 치면 여기에 남습니다.</div>'
  } else {
    el.innerHTML =
      '<div class="hlist">' +
      list
        .map((m) => {
          const { state } = rebuild(m)
          const names = m.config.players.map((p) => esc(p.name)).join(' vs ')
          const sc = state.players.map((p) => p.score).join(' : ')
          const when = new Date(m.createdAt).toLocaleString('ko-KR', { dateStyle: 'medium', timeStyle: 'short' })
          return `<div class="hitem"><div><div class="t">${names}</div><div class="d num">${disciplineName(m.config.discipline)} · ${when} · ${m.shots.length}샷</div></div><div class="sc num">${sc}</div><div><button class="btn" data-open="${esc(m.id)}">열기</button> <button class="btn ghost" data-del="${esc(m.id)}" title="삭제">✕</button></div></div>`
        })
        .join('') +
      '</div>'
  }
  show('history', true)
}
$('histList').addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest('button')
  if (!b) return
  if (b.dataset.del) {
    deleteMatch(b.dataset.del)
    openHistory()
  } else if (b.dataset.open) {
    const m = loadMatches().find((x) => x.id === b.dataset.open)
    if (!m) return
    show('history', false)
    showResult(m, rebuild(m).state, null, true)
  }
})
$('histClose').addEventListener('click', () => show('history', false))
onSeg('segHist', (v) => {
  histFilter = v as 'all' | Discipline
  openHistory()
})

// ── 프로필과 큐 상점 ───────────────────────────────────
function renderProfile(): void {
  const lv = levelOf(profile.xp)
  const c = cueItem()
  $('profile').innerHTML = `
    <div class="badge num"><div><small>다마</small><b>${lv.damasu}</b></div></div>
    <div class="chipbar grow">
      <div class="t">${esc(c.name)} · ${lv.next ? `다음 다마 ${lv.next} 까지 ${lv.remaining}` : '최고 단계'}</div>
      <div class="xpbar"><i style="width:${Math.round(lv.progress * 100)}%"></i></div>
    </div>
    <span class="spacer"></span>
    <button class="acct${account ? ' in' : ''}" id="acctBtn">${account ? `${esc(account.name)} · 로그아웃` : '로그인'}</button>
    <div class="chipbar coins num"><i class="coin"></i>${profile.coins}</div>`
  $('foot').textContent = `물리 코어 ${session ? session.record.coreVersion : '0.2.0'} · 기록은 이 브라우저에 저장됩니다`
}

function renderShop(): void {
  const lv = levelOf(profile.xp)
  $('shopWallet').innerHTML = `<span class="lv num">다마 <b>${lv.damasu}</b></span><span class="coins num"><i class="coin"></i>${profile.coins}</span>`
  const hex = (n: number) => `#${n.toString(16).padStart(6, '0')}`
  $('shopList').innerHTML = CUES.map((c) => {
    const st = cueStatus(profile, c)
    const r = cueRatings(c)
    const bar = (cls: string, label: string, v: number, val: string) =>
      `<div class="bar ${cls}"><span>${label}</span><span class="tr"><i style="width:${Math.round(8 + v * 92)}%"></i></span><span class="val num">${val}</span></div>`
    const action =
      st === 'equipped'
        ? '<button class="btn yellow" disabled>장착 중</button>'
        : st === 'owned'
          ? `<button class="btn" data-equip="${c.id}">장착</button>`
          : st === 'available'
            ? `<button class="btn green" data-buy="${c.id}">구매</button>`
            : st === 'poor'
              ? '<button class="btn" disabled>코인 부족</button>'
              : `<button class="btn" disabled>다마 ${c.minDamasu} 필요</button>`
    return `
      <div class="cue ${st}">
        <div class="stick" style="background:linear-gradient(90deg, ${hex(c.colors.butt)} 0 38%, ${hex(c.colors.accent)} 38% 41%, #d9b77a 41% 97%, #2c6fb5 97%)"></div>
        <div class="hd"><span class="nm">${esc(c.name)}</span><span class="req num">${c.minDamasu ? `다마 ${c.minDamasu}+` : '기본'}</span></div>
        <div class="bl">${esc(c.blurb)}</div>
        <div class="bars">
          ${bar('pow', '힘', r.power, `${c.maxSpeed.toFixed(1)}m/s`)}
          ${bar('spin', '회전 범위', r.spin, c.spec.miscueLimit.toFixed(2))}
          ${bar('elev', '고각', r.elevation, `${c.maxElevation}°`)}
          ${bar('ctl', '밀림 억제', r.control, `${(c.spec.endMass * 1000).toFixed(0)}g`)}
        </div>
        <div class="tags">
          <span class="tag2${c.maxElevation >= 60 ? ' on' : ''}">${c.maxElevation >= 60 ? '찍어치기 가능' : '찍어치기 불가'}</span>
          <span class="tag2${c.maxElevation >= 80 ? ' on' : ''}">${c.maxElevation >= 80 ? '마세 가능' : '마세 불가'}</span>
        </div>
        <div class="buy"><span class="coins num">${c.price ? `<i class="coin"></i>${c.price}` : '무료'}</span>${action}</div>
      </div>`
  }).join('')
}
$('shopList').addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest('button')
  if (!b) return
  const done = () => {
    keepProfile()
    renderShop()
    renderProfile()
  }
  if (account) {
    // 로그인 중에는 서버가 다마수와 코인을 확인하고 산다
    const req = b.dataset.buy ? api.buyCue(b.dataset.buy) : b.dataset.equip ? api.equipCue(b.dataset.equip) : null
    if (!req) return
    void req
      .then((r) => {
        profile = r.profile
        done()
      })
      .catch((err: Error) => alert(err.message))
    return
  }
  if (b.dataset.buy) profile = buyCue(profile, b.dataset.buy)
  else if (b.dataset.equip) profile = equipCue(profile, b.dataset.equip)
  else return
  done()
})
$('shopClose').addEventListener('click', () => show('shop', false))

// ── 계정 ─────────────────────────────────────────────
const UNSYNCED_KEY = 'dangu.unsynced.v1'
function queueUnsynced(id: string): void {
  try {
    const list = JSON.parse(localStorage.getItem(UNSYNCED_KEY) ?? '[]') as string[]
    if (!list.includes(id)) list.push(id)
    localStorage.setItem(UNSYNCED_KEY, JSON.stringify(list))
  } catch {
    /* 무시 */
  }
}

/**
 * 로그인 직후: 이 브라우저에 있던 끝난 경기를 서버로 올리고(서버가 다시 계산해 보상을 준다),
 * 서버에 있는 기록을 내려받아 "내 기록" 에 보이게 한다.
 */
async function syncAfterLogin(): Promise<void> {
  for (const m of loadMatches().reverse()) {
    try {
      profile = (await api.addMatch(m)).profile
    } catch {
      /* 버전이 다르거나 끝나지 않은 기록은 건너뛴다 */
    }
  }
  try {
    localStorage.removeItem(UNSYNCED_KEY)
    const { matches } = await api.matches()
    for (const m of matches.reverse()) saveMatch(m)
    const me = await api.me()
    if (me.profile) profile = me.profile
  } catch {
    /* 다음 접속 때 다시 맞춘다 */
  }
  renderProfile()
  if (session) applyCue()
}

function setAccount(a: Account | null, p?: Profile): void {
  account = a
  if (a && p) profile = p
  if (!a) profile = loadProfile()
  renderProfile()
  if (session) applyCue()
}

function openAccount(): void {
  $('acctMsg').className = ''
  $('acctMsg').textContent = ''
  show('devLogin', DEV_AUTH)
  $('acctSubmit').textContent = DEV_AUTH ? '들어가기' : '구글로 로그인'
  show('account', true)
}
$('acctClose').addEventListener('click', () => show('account', false))
$('acctSubmit').addEventListener('click', () => {
  const msg = $('acctMsg')
  msg.className = ''
  msg.textContent = '로그인하는 중…'
  const done = DEV_AUTH
    ? Promise.resolve().then(() => {
        signInDev($<HTMLInputElement>('acctName').value.trim())
        return refreshAccount()
      })
    : signInGoogle() // 로그인이 되면 onUser 가 불려 refreshAccount 가 실행된다
  void done
    .then(() => {
      if (DEV_AUTH) show('account', false)
    })
    .catch((err: Error) => {
      msg.textContent = err.message
    })
})
$('profile').addEventListener('click', (e) => {
  if (!(e.target as HTMLElement).closest('#acctBtn')) return
  if (!account) return openAccount()
  if (session?.kind === 'online') return
  void signOutUser()
    .catch(() => undefined)
    .then(() => setAccount(null))
})

/** 서버에 내가 누구인지 묻고 프로필과 기록을 맞춘다. 로그인 직후와 접속했을 때 부른다. */
let refreshing: Promise<void> | null = null
function refreshAccount(): Promise<void> {
  refreshing ??= api
    .me()
    .then(async (r) => {
      if (!r.account || !r.profile) {
        setAccount(null)
        return
      }
      setAccount(r.account, r.profile)
      $('acctMsg').className = 'ok'
      $('acctMsg').textContent = '기록을 맞추는 중…'
      await syncAfterLogin()
      show('account', false)
      const next = afterLogin
      afterLogin = null
      next?.()
    })
    .catch((err: Error) => {
      // 서버에 닿지 않으면 손님으로 둔다
      $('acctMsg').className = ''
      $('acctMsg').textContent = err.message
    })
    .finally(() => {
      refreshing = null
    })
  return refreshing
}

// 접속했을 때 이미 로그인되어 있으면 이어 간다. 초대 링크(?room=코드)로 왔으면 그 방으로 간다.
let firstAuth = true
onUser((signedIn) => {
  const p = signedIn ? refreshAccount() : Promise.resolve(setAccount(null))
  if (!firstAuth) return
  firstAuth = false
  void p.then(() => {
    const code = new URLSearchParams(location.search).get('room')
    if (code) joinRoom(code)
  })
})

// ── 조작 연결 ─────────────────────────────────────────
function setSeg(id: string, value: string): void {
  for (const b of Array.from($(id).querySelectorAll('button'))) b.classList.toggle('on', b.dataset.v === value)
}
function onSeg(id: string, fn: (v: string) => void): void {
  $(id).addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest('button')
    if (!b?.dataset.v) return
    setSeg(id, b.dataset.v)
    fn(b.dataset.v)
  })
}
function setView(v: ViewMode): void {
  scene.setView(v)
  setSeg('segView', v)
}

for (const card of Array.from(document.querySelectorAll<HTMLElement>('.mode-card'))) {
  card.addEventListener('click', () => {
    const m = card.dataset.mode!
    if (m === 'history') openHistory()
    else if (m === 'shop') {
      renderShop()
      show('shop', true)
    } else if (m === 'online' && !account) {
      // 온라인은 누구인지 알아야 하므로 로그인이 필요하다
      afterLogin = () => openSetup('online')
      openAccount()
      $('acctMsg').textContent = '온라인 대전은 로그인이 필요합니다'
    } else openSetup(m as Kind)
  })
}
onSeg('segDisc', () => {
  fillTargets()
  renderLevels()
})
$('aiLevels').addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button.lvl')
  if (!b || b.disabled || !b.dataset.id) return
  selectedLevel = b.dataset.id
  renderLevels()
})
$('setupBack').addEventListener('click', () => {
  show('setup', false)
  for (const c of Array.from(document.querySelectorAll('.mode-card'))) c.classList.remove('on')
})
$('start').addEventListener('click', startFromSetup)
$('resumeBtn').addEventListener('click', () => {
  const c = loadCurrent()
  if (c) startMatch(c.kind, c.record.config, undefined, c.record)
})
$('resAgain').addEventListener('click', () => {
  if (lastConfig) startMatch(lastConfig.kind, lastConfig.config)
})

function setPaused(on: boolean): void {
  if (!session || phase === 'over' || phase === 'menu') return
  if (on && phase === 'stroke') cancelStroke()
  paused = on
  show('pause', on)
  show('pauseRestart', session.kind !== 'online')
  $('pauseMenu').textContent = session.kind === 'online' && !session.state.finished && (session.seat ?? -1) >= 0 ? '기권하고 나가기' : '메뉴로 나가기'
}
$('btnPause').addEventListener('click', () => setPaused(true))
$('pauseResume').addEventListener('click', () => setPaused(false))
$('pauseRestart').addEventListener('click', () => {
  if (lastConfig) startMatch(lastConfig.kind, lastConfig.config)
})
$('pauseMenu').addEventListener('click', showMenu)

onSeg('segView', (v) => setView(v as ViewMode))
onSeg('segInput', (v) => {
  if (phase === 'stroke') cancelStroke()
  inputMode = v as InputMode
  syncControls()
  updateKeys()
  refreshAim()
})
$('theta').addEventListener('input', (e) => {
  thetaUser = Number((e.target as HTMLInputElement).value)
  refreshAim()
})
$('speed').addEventListener('input', (e) => {
  gaugeSpeed = Number((e.target as HTMLInputElement).value)
  syncControls()
  refreshAim()
})
$('assist').addEventListener('change', (e) => {
  assist = (e.target as HTMLSelectElement).value as Assist
  refreshAim()
})
$('sound').addEventListener('change', (e) => setSoundEnabled((e.target as HTMLInputElement).checked))
$('sens').addEventListener('input', (e) => {
  stroke.metersPerPx = Number((e.target as HTMLInputElement).value) / 1000
  syncControls()
})
$('shoot').addEventListener('click', () => fire(shotInput(), null))
$('btnReplay').addEventListener('click', instantReplay)
$('btnUndo').addEventListener('click', undo)
for (const id of ['nPhi', 'nSide', 'nTop', 'nAccel']) {
  $(id).addEventListener('change', () => {
    phi = Number($<HTMLInputElement>('nPhi').value) * DEG
    side = clamp(Number($<HTMLInputElement>('nSide').value), -0.9, 0.9)
    top = clamp(Number($<HTMLInputElement>('nTop').value), -0.9, 0.9)
    numericAccel = Number($<HTMLInputElement>('nAccel').value)
    syncControls()
    refreshAim()
  })
}

// 다시 보기 조작
$('rpPlay').addEventListener('click', () => {
  if (!replay) return
  const o = replay.list[replay.idx]
  if (replay.t >= o.result!.duration) replay.t = 0
  replay.playing = !replay.playing
  $('rpPlay').textContent = replay.playing ? '⏸' : '▶'
})
$('rpPrev').addEventListener('click', () => {
  if (!replay) return
  replay.idx = Math.max(0, replay.idx - 1)
  loadReplayShot()
})
$('rpNext').addEventListener('click', () => {
  if (!replay) return
  replay.idx = Math.min(replay.list.length - 1, replay.idx + 1)
  loadReplayShot()
})
$('rpSeek').addEventListener('input', (e) => {
  if (!replay) return
  const o = replay.list[replay.idx]
  replay.t = (Number((e.target as HTMLInputElement).value) / 1000) * o.result!.duration
  replay.playing = false
  $('rpPlay').textContent = '▶'
  scene.setBalls(stateAt(replay.record.table, o.result!, replay.t))
})
onSeg('rpSpeed', (v) => {
  if (replay) replay.speed = Number(v)
})
$('rpClose').addEventListener('click', closeReplay)
$('rpPractice').addEventListener('click', () => {
  if (!replay) return
  const o = replay.list[replay.idx]
  const d = replay.record.config.discipline
  replay = null
  show('replaybar', false)
  document.body.classList.remove('replaying')
  show('keys', true)
  startMatch('practice', { discipline: d, players: [{ name: '연습', target: 99999 }], rules: DEFAULT_RULES, shotClock: 0 }, o.before)
})

// 당점 패드
const pad = $('tippad')
function setTip(ev: PointerEvent): void {
  if (phase !== 'aim') return
  const r = pad.getBoundingClientRect()
  let sx = ((ev.clientX - r.left) / r.width) * 2 - 1
  let sy = -(((ev.clientY - r.top) / r.height) * 2 - 1)
  const l = Math.hypot(sx, sy)
  if (l > 0.85) {
    sx *= 0.85 / l
    sy *= 0.85 / l
  }
  side = Math.abs(sx) < 0.04 ? 0 : Math.round(sx * 100) / 100
  top = Math.abs(sy) < 0.04 ? 0 : Math.round(sy * 100) / 100
  syncControls()
  refreshAim()
}
pad.addEventListener('pointerdown', (ev) => {
  capture(pad, ev.pointerId)
  setTip(ev)
})
pad.addEventListener('pointermove', (ev) => {
  if (ev.buttons) setTip(ev)
})

// 테이블 위 포인터: 조준 드래그, 연습 모드의 공 옮기기
let drag: { kind: 'aim' | 'ball'; id?: number; x: number; moved: number } | null = null
canvas.addEventListener('pointerdown', (ev) => {
  if (!session || phase !== 'aim' || paused || scene.view === 'free') return
  const pos = scene.pick(ev.clientX, ev.clientY)
  if (session.kind === 'practice' && pos) {
    const hit = balls().find((b) => Math.hypot(b.r[0] - pos[0], b.r[1] - pos[1]) < table().R * 1.4)
    if (hit) {
      drag = { kind: 'ball', id: hit.id, x: ev.clientX, moved: 0 }
      capture(canvas, ev.pointerId)
      return
    }
  }
  drag = { kind: 'aim', x: ev.clientX, moved: 0 }
  capture(canvas, ev.pointerId)
})
canvas.addEventListener('pointermove', (ev) => {
  if (!drag || !session || phase !== 'aim') return
  const dx = ev.clientX - drag.x
  drag.x = ev.clientX
  drag.moved += Math.abs(dx)
  const t = table()
  if (drag.kind === 'ball') {
    const pos = scene.pick(ev.clientX, ev.clientY)
    if (!pos) return
    const reach = cushionReach(t)
    const nx = clamp(pos[0], reach, t.length - reach)
    const ny = clamp(pos[1], reach, t.width - reach)
    const b = balls().find((x) => x.id === drag!.id)!
    if (balls().every((o) => o === b || Math.hypot(o.r[0] - nx, o.r[1] - ny) >= 2 * t.R + 1e-4)) {
      b.r[0] = nx
      b.r[1] = ny
      scene.setBalls(balls())
      refreshAim()
    }
    return
  }
  if (scene.view === 'top') {
    const pos = scene.pick(ev.clientX, ev.clientY)
    const c = cueBall()
    if (pos && Math.hypot(pos[0] - c.r[0], pos[1] - c.r[1]) > t.R) phi = Math.atan2(pos[1] - c.r[1], pos[0] - c.r[0])
  } else {
    phi -= dx * (ev.shiftKey ? 0.0004 : 0.004)
  }
  syncControls()
  refreshAim()
})
canvas.addEventListener('pointerup', (ev) => {
  if (session && drag?.kind === 'aim' && scene.view === 'top' && drag.moved < 3 && phase === 'aim') {
    const pos = scene.pick(ev.clientX, ev.clientY)
    const c = cueBall()
    if (pos && Math.hypot(pos[0] - c.r[0], pos[1] - c.r[1]) > table().R) {
      phi = Math.atan2(pos[1] - c.r[1], pos[0] - c.r[0])
      syncControls()
      refreshAim()
    }
  }
  drag = null
})
canvas.addEventListener(
  'wheel',
  (ev) => {
    if (phase !== 'aim' || scene.view === 'free' || paused) return
    ev.preventDefault()
    phi -= Math.sign(ev.deltaY) * (ev.shiftKey ? 0.0005 : 0.003)
    syncControls()
    refreshAim()
  },
  { passive: false },
)

// 스트로크: Space 를 누른 채 마우스 움직임 (포인터 잠금), 또는 스트로크 패드
document.addEventListener('pointermove', (ev) => {
  if (phase !== 'stroke' || strokeSource !== 'key') return
  const list = typeof ev.getCoalescedEvents === 'function' ? ev.getCoalescedEvents() : []
  for (const e of list.length ? list : [ev]) {
    if (phase !== 'stroke') break
    strokeMove(e.movementX, e.movementY, e.timeStamp)
  }
})
const spad = $('strokepad')
let padLast: [number, number] | null = null
spad.addEventListener('pointerdown', (ev) => {
  capture(spad, ev.pointerId)
  padLast = [ev.clientX, ev.clientY]
  beginStroke('pad', ev.timeStamp)
})
spad.addEventListener('pointermove', (ev) => {
  if (!padLast || strokeSource !== 'pad') return
  const list = typeof ev.getCoalescedEvents === 'function' ? ev.getCoalescedEvents() : []
  for (const e of list.length ? list : [ev]) {
    if (phase !== 'stroke' || !padLast) break
    const dx = e.clientX - padLast[0]
    const dy = e.clientY - padLast[1]
    padLast = [e.clientX, e.clientY]
    strokeMove(dx, dy, e.timeStamp)
  }
})
const padEnd = () => {
  padLast = null
  if (strokeSource === 'pad') cancelStroke()
}
spad.addEventListener('pointerup', padEnd)
spad.addEventListener('pointercancel', padEnd)

window.addEventListener('keydown', (ev) => {
  const el = ev.target as HTMLElement
  if ((el.tagName === 'INPUT' && ['number', 'text', 'password'].includes((el as HTMLInputElement).type)) || el.tagName === 'SELECT') return
  if (ev.code === 'Escape') {
    if (replay) closeReplay()
    else if (!$('shop').classList.contains('hide')) show('shop', false)
    else if (!$('history').classList.contains('hide')) show('history', false)
    else if (session) setPaused(!paused)
    return
  }
  if (!session || paused) return
  const fine = ev.shiftKey ? 0.1 : 1
  switch (ev.code) {
    case 'Digit1':
      if (phase !== 'replay') setView('aim')
      break
    case 'Digit2':
      setView('top')
      break
    case 'Digit3':
      setView('free')
      break
    case 'KeyA':
    case 'ArrowLeft':
      if (phase === 'aim') phi += 0.01 * fine
      break
    case 'KeyD':
    case 'ArrowRight':
      if (phase === 'aim') phi -= 0.01 * fine
      break
    case 'KeyW':
    case 'ArrowUp':
      if (phase === 'aim') thetaUser = clamp(thetaUser + 1, 0, cueItem().maxElevation)
      break
    case 'KeyS':
    case 'ArrowDown':
      if (phase === 'aim') thetaUser = clamp(thetaUser - 1, 0, cueItem().maxElevation)
      break
    case 'KeyZ':
      undo()
      break
    case 'KeyR':
      instantReplay()
      return
    case 'Enter':
      if (phase === 'aim' && inputMode !== 'stroke') fire(shotInput(), null)
      break
    case 'Space':
      ev.preventDefault()
      if (!ev.repeat && phase === 'aim' && inputMode === 'stroke') {
        beginStroke('key', ev.timeStamp)
        try {
          void (canvas.requestPointerLock() as unknown as Promise<void> | undefined)?.catch?.(() => {})
        } catch {
          /* 잠금 없이 진행 */
        }
      }
      return
    default:
      return
  }
  ev.preventDefault()
  if (phase === 'aim') {
    syncControls()
    refreshAim()
  }
})
window.addEventListener('keyup', (ev) => {
  if (ev.code === 'Space' && strokeSource === 'key') cancelStroke()
})
window.addEventListener('resize', layout)

// ── 매 프레임 ─────────────────────────────────────────
let lastFrame = performance.now()
function speedBefore(t: TableProfile, res: ShotResult, time: number, ids: number[]): number {
  const st = stateAt(t, res, Math.max(time - 1e-6, 0))
  const a = st.find((b) => b.id === ids[0])
  const b = ids.length > 1 ? st.find((x) => x.id === ids[1]) : undefined
  if (!a) return 0
  if (b) return Math.hypot(a.v[0] - b.v[0], a.v[1] - b.v[1], a.v[2] - b.v[2])
  return Math.hypot(a.v[0], a.v[1])
}

/** from 에서 to 까지 공을 진행시켜 그린다. 자세는 각속도를 잘게 나눠 적분한다. */
function drawSpan(t: TableProfile, res: ShotResult, from: number, to: number): void {
  if (to > from) {
    const steps = Math.min(Math.max(Math.ceil((to - from) * 240), 1), 60)
    const h = (to - from) / steps
    for (let i = 0; i < steps; i++) scene.advanceSpin(stateAt(t, res, from + (i + 0.5) * h), h)
  }
  scene.setBalls(stateAt(t, res, to))
}

function frame(now: number): void {
  const real = (now - lastFrame) / 1000
  const dt = Math.min(real, 0.05)
  lastFrame = now

  if (phase === 'run' && result && session) {
    // 경기 시간은 실제 시간을 따른다 (프레임이 드물게 와도 느려지지 않는다)
    const from = runT
    runT = Math.min(runT + Math.min(real, 1), result.duration)
    while (nextEvent < result.events.length && result.events[nextEvent].t <= runT) {
      const e = result.events[nextEvent++]
      if (runT - e.t > 0.15) continue
      if (e.type === 'ball-ball') playBallHit(speedBefore(table(), result, e.t, e.ids))
      else if (e.type === 'cushion') playCushion(speedBefore(table(), result, e.t, e.ids))
    }
    drawSpan(table(), result, from, runT)
    if (runT >= result.duration) finishShot()
  } else if (phase === 'replay' && replay) {
    const o = replay.list[replay.idx]
    const res = o.result!
    if (replay.playing) {
      const from = replay.t
      replay.t = Math.min(replay.t + Math.min(real, 1) * replay.speed, res.duration)
      drawSpan(replay.record.table, res, from, replay.t)
      if (replay.t >= res.duration) {
        replay.playing = false
        $('rpPlay').textContent = '▶'
      }
      $<HTMLInputElement>('rpSeek').value = String(Math.round((replay.t / res.duration) * 1000))
    }
  } else if ((phase === 'aim' || phase === 'stroke') && session && !paused && clockLeft > 0 && session.kind !== 'practice' && session.kind !== 'online' && !isAiTurn()) {
    clockLeft -= Math.min(real, 1)
    renderClock()
    if (clockLeft <= 0) timeUp()
  }

  if (session?.kind === 'online' && netDeadline > 0 && phase !== 'over' && phase !== 'run') {
    // 온라인의 제한 시간은 서버가 잰다. 여기서는 남은 시간만 보여 준다
    clockLeft = Math.max(0, (netDeadline - (Date.now() + netOffset)) / 1000)
    renderClock()
  }
  scene.render(dt)
  requestAnimationFrame(frame)
}

// 자동 점검과 디버그용 접근
Object.assign(window, {
  __game: {
    state: () => ({
      phase,
      kind: session?.kind,
      seat: session?.seat,
      room: net.room,
      account: account?.name,
      sig: session ? stateSig(session.state) : '',
      turn: session?.state.turn,
      players: session?.state.players,
      balls: session?.state.balls,
      finished: session?.state.finished,
      shots: session?.record.shots.length,
      last: session?.outcomes[session.outcomes.length - 1]?.judgement,
      phi,
      theta: session ? effectiveTheta() : 0,
      profile,
      cue: cueItem().id,
      replay: replay ? { idx: replay.idx, n: replay.list.length, t: replay.t, playing: replay.playing } : null,
    }),
    start: (kind: Kind, config: MatchConfig) => startMatch(kind, config),
    shoot: (over: Partial<ShotInput> = {}) => fire(shotInput(over), null),
    skip: () => {
      if (phase === 'run' && result) {
        runT = result.duration
        finishShot()
      }
    },
    set: (v: { phi?: number; theta?: number; side?: number; top?: number; speed?: number }) => {
      if (v.phi !== undefined) phi = v.phi
      if (v.theta !== undefined) thetaUser = v.theta
      if (v.side !== undefined) side = v.side
      if (v.top !== undefined) top = v.top
      if (v.speed !== undefined) gaugeSpeed = v.speed
      syncControls()
      refreshAim()
    },
    setProfile: (p: Profile) => {
      profile = p
      keepProfile()
      renderProfile()
      if (session) applyCue()
    },
    menu: showMenu,
    rejoin: () => net.join(net.room),
    lastInput: () => session?.record.shots[session.record.shots.length - 1]?.input,
  },
})

showMenu()
requestAnimationFrame(frame)
