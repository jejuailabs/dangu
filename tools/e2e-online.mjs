/**
 * 온라인 대전 자동 점검:  node tools/e2e-online.mjs
 *
 * 임시 서버와 임시 DB 를 따로 띄우고, 서로 다른 두 브라우저(쿠키가 분리된 두 사용자)로
 * 방 만들기 -> 초대 링크로 참가 -> 번갈아 치기 -> 새로고침 후 복귀 -> 기권까지 실제로 해 본다.
 * 끝나면 임시 서버와 DB 를 지운다. 평소 쓰는 서버와 DB 는 건드리지 않는다.
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'
import WebSocket from 'ws'

const API_PORT = 5193
const WEB_PORT = 5191
const BASE = `http://localhost:${WEB_PORT}`
const dir = mkdtempSync(join(tmpdir(), 'dangu-e2e-'))
const procs = []
const results = []
let failed = false

function check(name, ok, detail = '') {
  results.push({ name, ok })
  if (!ok) failed = true
  console.log(`${ok ? '통과' : '실패'}  ${name}${detail ? '  ' + detail : ''}`)
}

function run(args, env) {
  const p = spawn('pnpm', ['exec', ...args], { env: { ...process.env, ...env }, shell: true, stdio: 'ignore' })
  procs.push(p)
  return p
}

async function waitFor(url, ms = 40000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    try {
      const r = await fetch(url)
      if (r.status < 500) return
    } catch {
      /* 아직 안 떴다 */
    }
    await new Promise((r) => setTimeout(r, 300))
  }
  throw new Error(`서버가 뜨지 않음: ${url}`)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const state = (page) => page.evaluate(() => window.__game.state())
async function until(page, fn, label, ms = 15000) {
  try {
    await page.waitForFunction(fn, null, { timeout: ms })
    return true
  } catch {
    console.log(`  (시간 초과: ${label})`)
    return false
  }
}

let browser
try {
  run(['tsx', 'apps/server/src/index.ts'], { PORT: String(API_PORT), DANGU_DB: join(dir, 'e2e.db') })
  run(['vite', 'apps/web', '--port', String(WEB_PORT), '--strictPort'], { DANGU_API: `http://localhost:${API_PORT}` })
  await waitFor(`http://localhost:${API_PORT}/api/me`)
  await waitFor(BASE)

  browser = await chromium.launch()
  // 서로 다른 사람: 쿠키가 분리된 두 컨텍스트
  const ctxA = await browser.newContext()
  const ctxB = await browser.newContext()
  const A = await ctxA.newPage()
  const B = await ctxB.newPage()
  const errors = []
  for (const [n, pg] of [['A', A], ['B', B]]) pg.on('pageerror', (e) => errors.push(`${n}: ${e.message}`))

  const pw = `E2e${Math.random().toString(36).slice(2, 12)}`
  const signup = (page, name) =>
    page.evaluate(
      async ([n, p]) => (await fetch('/api/signup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: n, password: p }) })).status,
      [name, pw],
    )
  await A.goto(BASE, { waitUntil: 'domcontentloaded' })
  await A.waitForFunction(() => window.__game !== undefined, null, { timeout: 60000 })
  await B.goto(BASE, { waitUntil: 'domcontentloaded' })
  check('두 사람 가입', (await signup(A, 'e2e_alice')) === 200 && (await signup(B, 'e2e_bob')) === 200)

  // 로그인하지 않은 연결은 거절된다 (쿠키 없이 서버에 직접 붙어 본다)
  const anon = await new Promise((res) => {
    const ws = new WebSocket(`ws://localhost:${API_PORT}/ws`)
    ws.on('open', () => res('open'))
    ws.on('error', () => res('refused'))
    ws.on('unexpected-response', () => res('refused'))
    setTimeout(() => res('timeout'), 4000)
  })
  check('로그인하지 않은 웹소켓 연결은 거절', anon === 'refused', anon)

  // A: 방 만들기
  await A.reload({ waitUntil: 'domcontentloaded' })
  await until(A, () => window.__game.state().account === 'e2e_alice', 'A 로그인 상태')
  await A.click('.mode-card[data-mode="online"]')
  await A.selectOption('#shotClock', '0')
  await A.click('#start')
  await until(A, () => !document.getElementById('lobby').classList.contains('hide'), '대기실')
  const code = await A.textContent('#lobbyCode')
  check('방 코드 발급', /^[A-Z2-9]{5}$/.test(code ?? ''), code ?? '')

  // B: 초대 링크로 참가
  await B.goto(`${BASE}/?room=${code}`, { waitUntil: 'domcontentloaded' })
  const okA = await until(A, () => window.__game.state().kind === 'online' && window.__game.state().phase !== 'menu', 'A 경기 시작')
  const okB = await until(B, () => window.__game.state().kind === 'online' && window.__game.state().phase !== 'menu', 'B 경기 시작')
  const sa = await state(A)
  const sb = await state(B)
  check('초대 링크로 들어오면 경기 시작', okA && okB && sa.seat === 0 && sb.seat === 1, `자리 ${sa.seat}, ${sb.seat}`)
  check('먼저 치는 사람만 조준 상태', sa.phase === 'aim' && sb.phase === 'think', `${sa.phase} / ${sb.phase}`)

  // 차례가 아닌 사람이 쳐도 반영되지 않는다
  await B.evaluate(() => window.__game.shoot({ phi: 1, speed: 2 }))
  await sleep(400)
  check('차례가 아닌 사람의 샷은 무시', (await state(A)).shots === 0 && (await state(B)).shots === 0)

  // 번갈아 여섯 번 친다
  const pages = [A, B]
  const angles = [0.3, 2.1, 4.0, 5.2, 1.1, 3.3]
  for (let i = 0; i < angles.length; i++) {
    const turn = (await state(A)).turn
    const me = pages[turn]
    const other = pages[1 - turn]
    await until(me, () => window.__game.state().phase === 'aim', `샷 ${i + 1} 조준`)
    await me.evaluate((phi) => window.__game.shoot({ phi, speed: 2.5 + (phi % 1), side: 0.1, top: 0.1 }), angles[i])
    await me.waitForFunction((n) => window.__game.state().shots === n, i + 1, { timeout: 8000 })
    await other.waitForFunction((n) => window.__game.state().shots === n, i + 1, { timeout: 8000 })
    // 공이 구르는 애니메이션은 건너뛴다
    await me.evaluate(() => window.__game.skip())
    await other.evaluate(() => window.__game.skip())
    await sleep(120)
  }
  const fa = await state(A)
  const fb = await state(B)
  const same = JSON.stringify(fa.balls.map((b) => b.r)) === JSON.stringify(fb.balls.map((b) => b.r))
  check('여섯 샷 뒤 두 화면의 공 위치가 완전히 같다', same && fa.shots === 6 && fb.shots === 6)
  check('점수와 차례가 같다', JSON.stringify(fa.players.map((p) => [p.score, p.innings])) === JSON.stringify(fb.players.map((p) => [p.score, p.innings])) && fa.turn === fb.turn)

  // 큐 사양을 속여 보낸다: 서버가 하우스 큐로 고정해야 한다
  const turn = (await state(A)).turn
  const cheater = pages[turn]
  await until(cheater, () => window.__game.state().phase === 'aim', '속임 샷 조준')
  await cheater.evaluate(() => window.__game.shoot({ phi: 0.9, speed: 999, cue: { mass: 5, tipRestitution: 5, endMass: 0.001, contactTime: 0.001, miscueLimit: 5 } }))
  await A.waitForFunction(() => window.__game.state().shots === 7, null, { timeout: 8000 })
  await B.waitForFunction(() => window.__game.state().shots === 7, null, { timeout: 8000 })
  const lastSpeed = await A.evaluate(() => window.__game.lastInput().speed)
  check('속인 속도와 큐는 서버가 한계 안으로 고정', lastSpeed <= 5.0001, `속도 ${lastSpeed}`)
  await A.evaluate(() => window.__game.skip())
  await B.evaluate(() => window.__game.skip())
  await sleep(200)

  // B 의 연결이 끊긴다. 그 사이 A 가 한 번 치면 B 는 그 샷을 놓친다.
  // 다시 연결되면 서버의 기록으로 화면을 맞춰야 한다.
  // 먼저 A 의 차례가 되게 한다 (B 차례면 B 가 일부러 빗맞힌다)
  let expected = 7
  for (let k = 0; k < 6 && (await state(A)).turn !== 0; k++) {
    await until(B, () => window.__game.state().phase === 'aim', 'B 조준')
    await B.evaluate(() => window.__game.shoot({ phi: 4.4, speed: 0.4 }))
    expected++
    await A.waitForFunction((n) => window.__game.state().shots === n, expected, { timeout: 8000 })
    await B.waitForFunction((n) => window.__game.state().shots === n, expected, { timeout: 8000 })
    await A.evaluate(() => window.__game.skip())
    await B.evaluate(() => window.__game.skip())
    await sleep(150)
  }
  await B.evaluate(() => window.__game.dropNet())
  if ((await state(A)).turn === 0) {
    await until(A, () => window.__game.state().phase === 'aim', '끊긴 동안 A 조준')
    await A.evaluate(() => window.__game.shoot({ phi: 2.7, speed: 2 }))
    expected++
    await A.waitForFunction((n) => window.__game.state().shots === n, expected, { timeout: 8000 })
    await A.evaluate(() => window.__game.skip())
    var missed = true
  }
  const okBack = await B.waitForFunction((n) => window.__game.state().shots === n, expected, { timeout: 15000 }).then(() => true).catch(() => false)
  await B.evaluate(() => window.__game.skip())
  await sleep(300)
  const rb = await state(B)
  const ra = await state(A)
  check(
    `끊겼다 돌아오면 놓친 샷까지 맞춰진다 (${typeof missed !== 'undefined' ? '놓친 샷 1개' : '놓친 샷 없음'})`,
    okBack && rb.seat === 1 && rb.shots === expected && JSON.stringify(rb.balls.map((x) => x.r)) === JSON.stringify(ra.balls.map((x) => x.r)),
  )

  // A 가 나가면 기권, B 가 이긴다
  await A.evaluate(() => window.__game.menu())
  const over = await until(B, () => window.__game.state().finished === true, 'B 승리 처리', 10000)
  await sleep(800)
  const prof = await B.evaluate(async () => (await (await fetch('/api/me')).json()).profile)
  const profA = await A.evaluate(async () => (await (await fetch('/api/me')).json()).profile)
  check('상대가 나가면 기권승', over && prof.wins === 1 && profA.wins === 0, `B 승 ${prof.wins}, A 승 ${profA.wins}`)
  const listB = await B.evaluate(async () => (await (await fetch('/api/matches')).json()).matches)
  check('서버에 온라인 기록이 내 자리 기준으로 저장', listB.length === 1 && listB[0].online === true && listB[0].viewSeat === 1)
  check('화면 오류 없음', errors.length === 0, errors.join(' | '))
} catch (e) {
  failed = true
  console.log('점검 중 오류:', e?.message ?? e)
} finally {
  await browser?.close().catch(() => {})
  for (const p of procs) {
    try {
      if (process.platform === 'win32') spawn('taskkill', ['/pid', String(p.pid), '/T', '/F'], { stdio: 'ignore' })
      else p.kill()
    } catch {
      /* 이미 끝남 */
    }
  }
  await sleep(1500)
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    /* 임시 폴더는 운영체제가 정리한다 */
  }
}
console.log(`\n${results.filter((r) => r.ok).length} / ${results.length} 통과`)
process.exit(failed ? 1 : 0)
