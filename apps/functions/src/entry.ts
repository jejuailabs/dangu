/**
 * Vercel 서버 함수의 진입점. /api/* 요청이 모두 여기로 온다.
 * 환경변수(FIREBASE_*)는 Vercel 프로젝트 설정에 들어 있다.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createBackend, nodeHandler } from './node'

let handler: ((req: IncomingMessage, res: ServerResponse) => Promise<void>) | null = null

export default async function entry(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    // 함수가 떠 있는 동안은 같은 것을 다시 쓴다 (접근 토큰과 공개 키 캐시가 유지된다)
    handler ??= nodeHandler(createBackend())
    await handler(req, res)
  } catch (e) {
    console.error(e)
    res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ error: '서버 설정 오류' }))
  }
}
