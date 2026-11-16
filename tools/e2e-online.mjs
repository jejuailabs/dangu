/**
 * 온라인 대전 자동 점검:  node tools/e2e-online.mjs   (pnpm e2e)
 *
 * Firebase 를 건드리지 않는다. 메모리 저장소와 가짜 로그인으로 API 서버를 따로 띄우고,
 * 쿠키·저장소가 분리된 두 브라우저(두 사용자)로 실제 대전을 해 본다:
 * 방 만들기 -> 초대 링크로 참가 -> 번갈아 치기 -> 속인 입력 -> 다시 들어오기 -> 기권.
 * 서버 코드는 배포되는 것과 같고, 저장소와 로그인 확인만 가짜다.
 */
import { spawn } from 'node:child_process'
import { chromium } from 'playwright'

const API_PORT = 5193
const WEB_PORT = 5191
const BASE = `http://localhost:${WEB_PORT}`
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
}
async function waitFor(url, ms = 60000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    try {
      if ((await fetch(url)).status < 500) return
    } catch {
      /* 아직 안 떴다 */
    }
    await new Promise((r) => setTimeout(r, 300))
  }
  throw new Error(`서버가 뜨지 않음: ${url}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const state = (page) => page.evaluate(() => window.__game.state())
const until = (page, fn, arg, ms = 40000) => page.waitForFunction(fn, arg, { timeout: ms }).then(() => true).catch(() => false)

let browser
try {
  run(['tsx', 'apps/functions/src/dev.ts'], { PORT: String(API_PORT), DANGU_STORE: 'memory' })
  run(['vite', 'apps/web', '--port', String(WEB_PORT), '--strictPort'], { DANGU_API: `http://localhost:${API_PORT}`, VITE_DEV_AUTH: '1' })
  await waitFor(`http://localhost:${API_PORT}/api/health`)
  await waitFor(BASE)

  // 로그인하지 않은 요청은 거절된다
  const anon = await fetch(`http://localhost:${API_PORT}/api/room/create`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
  const forged = await fetch(`http://localhost:${API_PORT}/api/matches`, { headers: { Authorization: 'Bearer eyJhbGciOiJub25lIn0.e30.' } })
  check('로그인하지 않았거나 가짜 토큰인 요청은 거절', anon.status === 401 && forged.status === 401, `${anon.status}, ${forged.status}`)

  browser = await chromium.launch()
  const A = await (await browser.newContext()).newPage()
  const B = await (await browser.newContext()).newPage()
  const errors = []
  for (const [n, pg] of [['A', A], ['B', B]]) {
    pg.on('pageerror', (e) => errors.push(`${n}: ${e.message}`))
    // 409 는 이 점검이 일부러 보낸 '차례가 아닌 샷' 의 거절 응답이라 오류로 세지 않는다
    pg.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('409')) errors.push(`${n} console: ${m.text().slice(0, 200)}`) })
  }
  globalThis.__dbg = { A, B, errors }

  // 가짜 로그인: 이름을 넣어 두고 페이지를 연다
  const open = async (page, name, url) => {
    await page.goto(BASE, { waitUntil: 'domcontentloaded' })
    await page.evaluate((n) => sessionStorage.setItem('dangu.devuser', n), name)
    await page.goto(url, { waitUntil: 'domcontentloaded' })
    await page.waitForFunction(() => window.__game !== undefined, null, { timeout: 60000 })
    return until(page, (n) => window.__game.state().account === n, name, 40000)
  }
  check('두 사람 로그인', (await open(A, 'e2e_alice', `${BASE}/?norender=1`)) && true)

  // A: 방 만들기
  await A.click('.mode-card[data-mode="online"]')
  await A.selectOption('#shotClock', '0')
  await A.click('#start')
  await until(A, () => !document.getElementById('lobby').classList.contains('hide'))
  const code = await A.textContent('#lobbyCode')
  check('방 코드 발급', /^[A-Z2-9]{5}$/.test(code ?? ''), code ?? '')

  // B: 초대 링크로 참가
  const loggedB = await open(B, 'e2e_bob', `${BASE}/?norender=1&room=${code}`)
  const okA = await until(A, () => window.__game.state().kind === 'online' && window.__game.state().phase !== 'menu')
  const okB = await until(B, () => window.__game.state().kind === 'online' && window.__game.state().phase !== 'menu')
  const sa = await state(A)
  const sb = await state(B)
  check('초대 링크로 들어오면 경기 시작', loggedB && okA && okB && sa.seat === 0 && sb.seat === 1, `자리 ${sa.seat}, ${sb.seat}`)
  check('먼저 치는 사람만 조준 상태', sa.phase === 'aim' && sb.phase === 'think', `${sa.phase} / ${sb.phase}`)

  // 차례가 아닌 사람이 쳐도 반영되지 않는다 (화면에서도 막히고, 서버에 직접 보내도 거절된다)
  await B.evaluate(() => window.__game.shoot({ phi: 1, speed: 2 }))
  const direct = await B.evaluate(
    async (c) => (await fetch('/api/room/shot', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer dev:e2e_bob' }, body: JSON.stringify({ code: c, input: { phi: 1, speed: 2 } }) })).status,
    code,
  )
  await sleep(1200)
  check('차례가 아닌 사람의 샷은 서버가 거절', direct === 409 && (await state(A)).shots === 0, `HTTP ${direct}`)

  // 번갈아 여섯 번 친다
  const pages = [A, B]
  const angles = [0.3, 2.1, 4.0, 5.2, 1.1, 3.3]
  for (let i = 0; i < angles.length; i++) {
    const turn = (await state(A)).turn
    const me = pages[turn]
    const other = pages[1 - turn]
    await until(me, () => window.__game.state().phase === 'aim')
    await me.evaluate((phi) => window.__game.shoot({ phi, speed: 2.5 + (phi % 1), side: 0.1, top: 0.1 }), angles[i])
    await me.waitForFunction((n) => window.__game.state().shots === n, i + 1, { timeout: 40000 })
    await other.waitForFunction((n) => window.__game.state().shots === n, i + 1, { timeout: 40000 })
    // 공이 구르는 애니메이션은 건너뛴다
    await me.evaluate(() => window.__game.skip())
    await other.evaluate(() => window.__game.skip())
    await sleep(150)
  }
  const fa = await state(A)
  const fb = await state(B)
  check('여섯 샷 뒤 두 화면의 상태 지문이 같다', fa.sig === fb.sig && fa.sig.length === 16 && fa.shots === 6 && fb.shots === 6, `${fa.sig} / ${fb.sig}`)
  check('공 위치, 점수, 차례가 같다', JSON.stringify(fa.balls.map((b) => b.r)) === JSON.stringify(fb.balls.map((b) => b.r)) && JSON.stringify(fa.players.map((p) => [p.score, p.innings])) === JSON.stringify(fb.players.map((p) => [p.score, p.innings])) && fa.turn === fb.turn)

  // 큐 사양을 속여 보낸다: 서버가 하우스 큐로 고정해야 한다
  const turn = (await state(A)).turn
  const cheater = pages[turn]
  await until(cheater, () => window.__game.state().phase === 'aim')
  await cheater.evaluate(() => window.__game.shoot({ phi: 0.9, speed: 999, cue: { mass: 5, tipRestitution: 5, endMass: 0.001, contactTime: 0.001, miscueLimit: 5 } }))
  await A.waitForFunction(() => window.__game.state().shots === 7, null, { timeout: 40000 })
  await B.waitForFunction(() => window.__game.state().shots === 7, null, { timeout: 40000 })
  const lastSpeed = await A.evaluate(() => window.__game.lastInput().speed)
  check('속인 속도와 큐는 서버가 한계 안으로 고정', lastSpeed <= 5.0001, `속도 ${lastSpeed}`)
  await A.evaluate(() => window.__game.skip())
  await B.evaluate(() => window.__game.skip())
  await sleep(1500)
  check('속인 샷 뒤에도 두 화면이 같다', (await state(A)).sig === (await state(B)).sig)

  // B 가 방에 다시 들어온다 (끊겼다 돌아온 경우와 같은 경로): 서버의 기록으로 화면을 다시 만든다
  await B.evaluate(() => window.__game.rejoin())
  await sleep(1500)
  const rb = await state(B)
  const ra = await state(A)
  check('다시 들어와도 같은 경기, 같은 상태', rb.seat === 1 && rb.shots === 7 && rb.sig === ra.sig && rb.kind === 'online')

  // 다시 들어온 뒤에도 이어서 칠 수 있다
  const t2 = (await state(A)).turn
  await until(pages[t2], () => window.__game.state().phase === 'aim')
  await pages[t2].evaluate(() => window.__game.shoot({ phi: 4.4, speed: 0.4 }))
  const cont = (await until(A, () => window.__game.state().shots === 8)) && (await until(B, () => window.__game.state().shots === 8))
  await A.evaluate(() => window.__game.skip())
  await B.evaluate(() => window.__game.skip())
  check('다시 들어온 뒤에도 이어서 친다', cont)

  // A 가 나가면 기권, B 가 이긴다
  await A.evaluate(() => window.__game.menu())
  const over = await until(B, () => window.__game.state().finished === true, null, 12000)
  await sleep(2500)
  const me = (name) => fetch(`http://localhost:${API_PORT}/api/me`, { headers: { Authorization: `Bearer dev:${name}` } }).then((r) => r.json())
  const pb = (await me('e2e_bob')).profile
  const pa = (await me('e2e_alice')).profile
  check('상대가 나가면 기권승', over && pb.wins === 1 && pa.wins === 0, `B 승 ${pb.wins}, A 승 ${pa.wins}`)
  const listB = (await fetch(`http://localhost:${API_PORT}/api/matches`, { headers: { Authorization: 'Bearer dev:e2e_bob' } }).then((r) => r.json())).matches
  check('서버에 온라인 기록이 내 자리 기준으로 저장', listB.length === 1 && listB[0].online === true && listB[0].viewSeat === 1)
  const shown = await B.evaluate(() => window.__game.state().profile.wins)
  check('화면의 프로필에도 승리가 반영', shown === 1, `화면 승 ${shown}`)
  check('화면 오류 없음', errors.length === 0, errors.join(' | '))
} catch (e) {
  failed = true
  console.log('점검 중 오류:', e?.message ?? e)
  try {
    const d = globalThis.__dbg
    for (const k of ['A', 'B']) {
      const st = await d[k].evaluate(() => { const s = window.__game.state(); return { phase: s.phase, kind: s.kind, seat: s.seat, turn: s.turn, shots: s.shots, room: s.room, banner: document.getElementById('bannerMain').textContent + ' / ' + document.getElementById('bannerSub').textContent, thinking: document.getElementById('thinking').textContent } })
      console.log('  상태', k, JSON.stringify(st))
    }
    console.log('  오류 기록', d.errors.join(' | ') || '(없음)')
  } catch {}
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
  await sleep(1000)
}
console.log(`\n${results.filter((r) => r.ok).length} / ${results.length} 통과`)
process.exit(failed ? 1 : 0)
