# dangu

논문으로 검증한 물리 모델 위에서 도는 웹 당구 게임 (3쿠션, 4구).

프로젝트 전체 설명과 현재 상태는 [MAIN.md](MAIN.md), 세부 요구사항은 [docs/](docs/) 에 있다.

## 실행

```bash
pnpm install
pnpm dev        # 게임 (http://localhost:5181)
pnpm api        # API 서버 (http://localhost:5182, Firestore 사용)
pnpm test       # 테스트
pnpm e2e        # 온라인 대전 자동 점검
```

## 환경변수

`.env.example` 을 `.env.local` 로 복사해 값을 채운다. `.env.local` 과 서비스 계정 키 파일은 Git 에 올리지 않는다.

- `VITE_FIREBASE_*` : Firebase 웹 설정. 브라우저에 실리는 공개 값이다.
- `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY_ID`, `FIREBASE_PRIVATE_KEY` : 서비스 계정. 서버에서만 쓰는 비밀이다.
