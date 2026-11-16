/**
 * Vercel 용 빌드:  node tools/build-vercel.mjs   (pnpm build)
 *
 * Vercel 의 "Build Output API" 형식으로 .vercel/output 을 만든다.
 *   static/                 게임 화면 (vite 빌드 결과)
 *   functions/api.func/     서버 함수 하나. /api/* 요청을 모두 받는다
 *   config.json             주소 규칙
 *
 * 서버 함수는 esbuild 로 한 파일로 묶는다. 물리 코어와 규칙 코드가 함께 들어가므로
 * 브라우저와 서버가 정확히 같은 코드로 계산한다.
 */
import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { build } from 'esbuild'

const out = '.vercel/output'
rmSync(out, { recursive: true, force: true })

// 1. 게임 화면
const vite = spawnSync('pnpm', ['exec', 'vite', 'build', 'apps/web', '--outDir', '../../dist/web', '--emptyOutDir'], { stdio: 'inherit', shell: true })
if (vite.status !== 0) process.exit(vite.status ?? 1)
mkdirSync(`${out}/static`, { recursive: true })
cpSync('dist/web', `${out}/static`, { recursive: true })

// 2. 서버 함수
const fn = `${out}/functions/api.func`
mkdirSync(fn, { recursive: true })
await build({
  entryPoints: ['apps/functions/src/entry.ts'],
  outfile: `${fn}/index.mjs`,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  logLevel: 'info',
})
writeFileSync(
  `${fn}/.vc-config.json`,
  JSON.stringify({ runtime: 'nodejs22.x', handler: 'index.mjs', launcherType: 'Nodejs', shouldAddHelpers: false, maxDuration: 20 }, null, 2),
)

// 3. 주소 규칙: /api/* 는 서버 함수로, 나머지는 정적 파일로
writeFileSync(
  `${out}/config.json`,
  JSON.stringify(
    {
      version: 3,
      routes: [
        { src: '^/api/(.*)$', dest: '/api?__path=$1' },
        { handle: 'filesystem' },
        { src: '^/(.*)$', dest: '/index.html' },
      ],
    },
    null,
    2,
  ),
)
console.log('\n.vercel/output 완성')
