/**
 * 실제 Firestore 로 서버 로직이 도는지 확인한다:  pnpm exec tsx tools/smoke-firebase.ts
 *
 * .env.local 의 서비스 계정으로 dangu_users / dangu_rooms 에 시험용 문서를 만들고,
 * 끝나면 만든 문서를 모두 지운다. 다른 컬렉션은 읽지도 쓰지도 않는다.
 */
import { readFileSync } from 'node:fs'
import { DEFAULT_CUE, DEG, type ShotInput } from '../packages/physics/src'
import { DEFAULT_RULES } from '../packages/rules/src'
import { type MatchConfig, initialState, newMatch, play, rebuild } from '../packages/game/src'
import { Core } from '../apps/functions/src/core'
import { Firestore, type Identity, serviceAccountFromEnv } from '../apps/functions/src/google'
import { FirestoreStore } from '../apps/functions/src/store'

for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim())
  if (!m) continue
  let v = m[2].trim()
  if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1)
  process.env[m[1]] ??= v
}

const tag = Date.now().toString(36)
const A: Identity = { uid: `smoketest_a_${tag}`, name: '시험A' }
const B: Identity = { uid: `smoketest_b_${tag}`, name: '시험B' }
const fs = new Firestore(serviceAccountFromEnv())
const core = new Core(new FirestoreStore(fs))
let failed = false
const check = (name: string, ok: boolean, detail = '') => {
  if (!ok) failed = true
  console.log(`${ok ? '통과' : '실패'}  ${name}${detail ? '  ' + detail : ''}`)
}
const created: string[] = []

try {
  const t0 = Date.now()
  const me = await core.me(A)
  check('사용자 문서 만들기와 읽기', me.profile.equipped === 'house' && me.profile.xp === 0, `${Date.now() - t0}ms`)
  created.push(`dangu_users/${A.uid}`, `dangu_users/${B.uid}`)

  // 끝난 경기 하나를 올린다
  const config: MatchConfig = { discipline: '3cushion', players: [{ name: '시험A', target: 1 }], rules: DEFAULT_RULES, shotClock: 0 }
  const rec = newMatch(config, `smoke${tag}`, Date.now())
  const st = play(rec, initialState(rec), { player: 0, input: { ballId: 0, phi: 2 * DEG, theta: 0, side: 0, top: 0.2, speed: 4, cue: DEFAULT_CUE } as ShotInput }).state
  if (!st.finished) throw new Error('시험용 경기가 끝나지 않음')
  const added = await core.addMatch(A, rec)
  created.push(`dangu_users/${A.uid}/matches/${rec.id}`)
  check('경기 저장과 보상 (묶음 쓰기, 증가 연산)', !added.duplicate && added.profile.xp === 1 && added.profile.coins === 12 && added.profile.games === 1)
  const dup = await core.addMatch(A, rec)
  check('같은 경기를 다시 올리면 보상이 늘지 않는다', dup.duplicate && dup.profile.coins === 12 && dup.profile.games === 1)
  const list = await core.matches(A)
  check('경기 목록 조회 (정렬 조회)', list.length === 1 && list[0].id === rec.id)

  // 방: 만들기 -> 참가 -> 샷 -> 조회 -> 기권
  const room = await core.roomCreate(A, { discipline: '3cushion', target: 5, shotClock: 0 })
  created.push(`dangu_rooms/${room.code}`)
  check('방 만들기', /^[A-Z2-9]{5}$/.test(room.code) && room.status === 'waiting', room.code)
  const joined = await core.roomJoin(B, { code: room.code, target: 5 })
  check('방 참가 (바뀌지 않았을 때만 저장)', joined.status === 'playing' && joined.you === 1)
  const t1 = Date.now()
  const shot = await core.roomShot(A, room.code, { input: { phi: 4.4, theta: 0, side: 0, top: 0, speed: 0.5 }, have: 0 })
  check('샷 확정', shot.total === 1 && shot.sig.length === 16, `${Date.now() - t1}ms`)
  const seen = await core.roomState(B, room.code, 0, true)
  const mine = structuredClone(joined.record!)
  mine.shots.push(...seen.shots)
  const { stateSig } = await import('../packages/game/src')
  check('상대가 받은 샷으로 다시 계산한 상태가 서버와 같다', stateSig(rebuild(mine).state) === seen.sig)
  await core.roomLeave(A, room.code)
  created.push(`dangu_users/${A.uid}/matches/${joined.record!.id}`, `dangu_users/${B.uid}/matches/${joined.record!.id}`)
  const over = await core.roomState(B, room.code, 1, false)
  check('기권 처리와 승자 보상', over.status === 'over' && over.profile?.wins === 1)
} catch (e) {
  failed = true
  console.log('오류:', (e as Error).message)
} finally {
  // 만든 문서를 지운다 (하위 문서부터)
  for (const path of created.sort((a, b) => b.split('/').length - a.split('/').length)) await fs.remove(path).catch(() => undefined)
  const left = (await fs.get(`dangu_users/${A.uid}`)) !== null
  check('시험용 문서 정리', !left)
}
process.exit(failed ? 1 : 0)
