/**
 * 개발용 API 서버. 실행:  pnpm api   (기본 포트 5182)
 * Vercel 에 올라가는 것과 같은 코드를 이 PC 에서 돌린다. .env.local 의 Firebase 설정을 읽는다.
 *
 *   DANGU_STORE=memory pnpm api   # Firebase 없이 메모리 저장소 + 가짜 로그인 (자동 점검용)
 */
import { existsSync, readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { createBackend, nodeHandler } from './node'

// .env.local 을 읽는다 (이미 설정된 환경변수는 덮어쓰지 않는다)
if (existsSync('.env.local')) {
  for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim())
    if (!m) continue
    let v = m[2].trim()
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1)
    process.env[m[1]] ??= v
  }
}

const PORT = Number(process.env.PORT ?? 5182)
const handler = nodeHandler(createBackend())
createServer((req, res) => void handler(req, res)).listen(PORT, () =>
  console.log(`dangu api http://localhost:${PORT}  (${process.env.DANGU_STORE === 'memory' ? '메모리 저장소, 가짜 로그인' : 'Firestore'})`),
)
