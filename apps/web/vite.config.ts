import { defineConfig } from 'vite'

// 개발 중에는 /api 를 이 PC 의 API 서버(pnpm api, 포트 5182)로 넘긴다.
// 배포본에서는 같은 주소의 Vercel 함수가 받는다.
// DANGU_API 로 다른 서버를 가리킬 수 있다 (자동 점검에서 임시 서버를 쓸 때).
const api = process.env.DANGU_API ?? 'http://localhost:5182'

export default defineConfig({
  // 환경변수 파일(.env.local)은 저장소 루트에 둔다.
  // 브라우저에는 VITE_ 로 시작하는 값만 실린다. 서비스 계정 키 같은 비밀은 실리지 않는다.
  envDir: '../../',
  server: {
    proxy: {
      '/api': { target: api, changeOrigin: false },
    },
  },
})
