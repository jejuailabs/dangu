/**
 * HTTP 서버. 실행:  pnpm server   (기본 포트 5182, DB 는 data/dangu.db)
 *
 * 세션은 HttpOnly 쿠키로 주고받는다. 스크립트가 토큰을 읽을 수 없으므로
 * 페이지에 끼어든 코드가 세션을 훔쳐 갈 수 없다.
 */
import { mkdirSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { dirname } from 'node:path'
import { WebSocketServer, type WebSocket } from 'ws'
import { type Conn, Rooms, type ServerMsg } from './rooms'
import { Service, ServiceError } from './service'

const PORT = Number(process.env.PORT ?? 5182)
const DB_PATH = process.env.DANGU_DB ?? 'data/dangu.db'
const COOKIE = 'dangu_session'
const MAX_BODY = 400_000

mkdirSync(dirname(DB_PATH), { recursive: true })
const service = new Service(DB_PATH)

/** 로그인 시도 제한: IP 당 10분에 20번 */
const attempts = new Map<string, { n: number; reset: number }>()
function limited(ip: string): boolean {
  const now = Date.now()
  const a = attempts.get(ip)
  if (!a || a.reset < now) {
    attempts.set(ip, { n: 1, reset: now + 600_000 })
    return false
  }
  a.n++
  return a.n > 20
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > MAX_BODY) {
        reject(new ServiceError(413, '요청이 너무 큽니다'))
        req.destroy()
      } else chunks.push(c)
    })
    req.on('end', () => {
      if (chunks.length === 0) return resolve({})
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        reject(new ServiceError(400, 'JSON 형식이 아닙니다'))
      }
    })
    req.on('error', reject)
  })
}

function tokenOf(req: IncomingMessage): string | undefined {
  const m = (req.headers.cookie ?? '').match(new RegExp(`(?:^|; )${COOKIE}=([a-f0-9]{64})`))
  return m?.[1]
}

function send(res: ServerResponse, status: number, body: unknown, cookie?: string): void {
  const headers: Record<string, string> = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
  if (cookie) headers['Set-Cookie'] = cookie
  res.writeHead(status, headers)
  res.end(JSON.stringify(body))
}

const sessionCookie = (token: string) => `${COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${30 * 86400}${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`
const clearCookie = `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const route = `${req.method} ${url.pathname}`
  try {
    // 상태를 바꾸는 요청은 JSON 으로만 받는다 (다른 사이트의 폼 전송을 막는다)
    if (req.method !== 'GET' && !(req.headers['content-type'] ?? '').includes('application/json')) {
      throw new ServiceError(415, 'Content-Type 은 application/json 이어야 합니다')
    }
    const ip = req.socket.remoteAddress ?? ''

    if (route === 'POST /api/signup' || route === 'POST /api/login') {
      if (limited(ip)) throw new ServiceError(429, '잠시 후 다시 시도하세요')
      const b = (await readBody(req)) as { name?: unknown; password?: unknown }
      const r = route.endsWith('signup') ? service.signup(b.name, b.password) : service.login(b.name, b.password)
      return send(res, 200, { account: r.account, profile: service.profile(r.account.id) }, sessionCookie(r.token))
    }
    if (route === 'POST /api/logout') {
      service.logout(tokenOf(req))
      return send(res, 200, { ok: true }, clearCookie)
    }

    const me = service.auth(tokenOf(req))
    if (route === 'GET /api/me') {
      return send(res, 200, me ? { account: me, profile: service.profile(me.id) } : { account: null })
    }
    if (!me) throw new ServiceError(401, '로그인이 필요합니다')

    if (route === 'GET /api/matches') return send(res, 200, { matches: service.listMatches(me.id) })
    if (route === 'POST /api/matches') return send(res, 200, service.addMatch(me.id, await readBody(req)))
    if (route === 'POST /api/cues/buy') {
      const b = (await readBody(req)) as { id?: unknown }
      return send(res, 200, { profile: service.buyCue(me.id, b.id) })
    }
    if (route === 'POST /api/cues/equip') {
      const b = (await readBody(req)) as { id?: unknown }
      return send(res, 200, { profile: service.equipCue(me.id, b.id) })
    }
    throw new ServiceError(404, '없는 주소입니다')
  } catch (e) {
    if (e instanceof ServiceError) return send(res, e.status, { error: e.message })
    console.error(e)
    return send(res, 500, { error: '서버 오류' })
  }
})

// ── 온라인 대전 (웹소켓 /ws) ──────────────────────────
const rooms = new Rooms(service)
const wss = new WebSocketServer({ noServer: true, maxPayload: 20_000 })

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url ?? '/', 'http://localhost')
  // 다른 사이트의 페이지가 내 쿠키로 소켓을 여는 것을 막는다: 출처가 이 서버(또는 그 앞의 개발 서버)와 같아야 한다
  const origin = req.headers.origin
  const sameOrigin = !origin || new URL(origin).host === req.headers.host
  const me = service.auth(tokenOf(req))
  if (url.pathname !== '/ws' || !sameOrigin || !me) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
    socket.destroy()
    return
  }
  wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
    const conn: Conn = {
      send(msg: ServerMsg) {
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg))
      },
    }
    let alive = true
    let budget = 40 // 1초에 받을 수 있는 메시지 수
    const refill = setInterval(() => (budget = 40), 1000)
    const beat = setInterval(() => {
      if (!alive) return ws.terminate()
      alive = false
      ws.ping()
    }, 20_000)
    ws.on('pong', () => (alive = true))
    ws.on('message', (data) => {
      if (--budget < 0) return
      let m: Record<string, unknown>
      try {
        m = JSON.parse(String(data)) as Record<string, unknown>
      } catch {
        return
      }
      if (!m || typeof m !== 'object') return
      try {
        if (m.t === 'create') rooms.create(me, conn, m)
        else if (m.t === 'join') rooms.join(me, conn, m)
        else if (m.t === 'shot') rooms.shot(conn, m)
        else if (m.t === 'aim') rooms.aim(conn, m)
        else if (m.t === 'leave') {
          rooms.leave(conn)
          conn.send({ t: 'left' })
        }
      } catch (e) {
        console.error(e)
        conn.send({ t: 'error', message: '서버 오류' })
      }
    })
    ws.on('close', () => {
      clearInterval(refill)
      clearInterval(beat)
      rooms.disconnect(conn)
    })
  })
})
setInterval(() => rooms.tick(), 1000)

server.listen(PORT, () => console.log(`dangu server http://localhost:${PORT}  (db: ${DB_PATH})`))
