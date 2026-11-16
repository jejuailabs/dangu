/**
 * 브라우저 간 결정성 확인.
 * 디버그 뷰어(pnpm viewer)가 떠 있는 상태에서 실행한다:  node tools/crossbrowser.mjs
 * Chromium, Firefox, WebKit(Safari 엔진)에서 자가 점검 해시를 구해 Node 의 기준값과 비교한다.
 */
import { chromium, firefox, webkit } from 'playwright'

const URL = process.env.VIEWER_URL ?? 'http://localhost:5180'
const EXPECTED = process.argv[2]
const engines = { chromium, firefox, webkit }
let failed = false

for (const [name, engine] of Object.entries(engines)) {
  let browser
  try {
    browser = await engine.launch()
    const page = await browser.newPage()
    await page.goto(URL)
    await page.waitForFunction(() => window.__dangu !== undefined)
    const { hash, version } = await page.evaluate(() => ({ hash: window.__dangu.selfTest(), version: window.__dangu.version }))
    const ok = !EXPECTED || hash === EXPECTED
    if (!ok) failed = true
    console.log(`${name.padEnd(9)} ${browser.version().padEnd(14)} 코어 ${version}  ${hash}  ${EXPECTED ? (ok ? '일치' : '불일치') : ''}`)
  } catch (e) {
    failed = true
    console.log(`${name.padEnd(9)} 실행 실패: ${String(e.message).split('\n')[0]}`)
  } finally {
    await browser?.close()
  }
}
process.exit(failed ? 1 : 0)
