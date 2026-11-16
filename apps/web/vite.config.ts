import { defineConfig } from 'vite'

// 개발 중에는 /api 와 /ws 를 계정·대전 서버(pnpm server, 포트 5182)로 넘긴다.
// 같은 출처로 보이므로 세션 쿠키가 그대로 동작한다.
// DANGU_API 로 다른 서버를 가리킬 수 있다 (자동 점검에서 임시 서버를 쓸 때).
const api = process.env.DANGU_API ?? 'http://localhost:5182'

export default defineConfig({
  // 환경변수 파일(.env.local)은 저장소 루트에 둔다.
  // 브라우저에는 VITE_ 로 시작하는 값만 실린다. 서비스 계정 키 같은 비밀은 실리지 않는다.
  envDir: '../../',
  server: {
    proxy: {
      '/api': { target: api, changeOrigin: false },
      '/ws': { target: api.replace(/^http/, 'ws'), ws: true, changeOrigin: false },
    },
  },
})
