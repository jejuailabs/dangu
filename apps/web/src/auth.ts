/**
 * 로그인. Firebase 의 구글 로그인을 쓴다.
 * 서버에는 요청마다 Firebase 가 발급한 로그인 토큰을 보내고, 서버가 구글의 공개 키로 서명을 확인한다.
 *
 * VITE_DEV_AUTH=1 로 띄우면 이름만으로 들어오는 가짜 로그인을 쓴다. 자동 점검과,
 * Firebase 없이 이 PC 에서만 돌려 볼 때를 위한 것이다 (서버도 메모리 모드여야 통한다).
 */
import { type FirebaseApp, initializeApp } from 'firebase/app'
import { type Auth, GoogleAuthProvider, getAuth, onAuthStateChanged, signInWithPopup, signOut } from 'firebase/auth'

export const DEV_AUTH = import.meta.env.VITE_DEV_AUTH === '1'
const DEV_KEY = 'dangu.devuser'

/** 환경변수 값의 앞뒤 공백과 줄바꿈을 없앤다 (등록할 때 줄바꿈이 붙는 경우가 있다) */
const clean = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined)

let app: FirebaseApp | null = null
let auth: Auth | null = null

function firebaseAuth(): Auth {
  if (auth) return auth
  const cfg = {
    apiKey: clean(import.meta.env.VITE_FIREBASE_API_KEY),
    authDomain: clean(import.meta.env.VITE_FIREBASE_AUTH_DOMAIN),
    projectId: clean(import.meta.env.VITE_FIREBASE_PROJECT_ID),
    appId: clean(import.meta.env.VITE_FIREBASE_APP_ID),
  }
  if (!cfg.apiKey || !cfg.projectId) throw new Error('Firebase 설정이 없습니다 (.env.local 의 VITE_FIREBASE_*)')
  app = initializeApp(cfg)
  auth = getAuth(app)
  return auth
}

/** 로그인 상태가 바뀔 때마다 알려 준다 (처음 한 번은 반드시 부른다). */
export function onUser(cb: (signedIn: boolean) => void): void {
  if (DEV_AUTH) {
    cb(sessionStorage.getItem(DEV_KEY) !== null)
    return
  }
  try {
    onAuthStateChanged(firebaseAuth(), (u) => cb(u !== null))
  } catch {
    cb(false)
  }
}

/** 서버에 보낼 로그인 토큰. 로그인하지 않았으면 null. 만료가 가까우면 Firebase 가 알아서 새로 받는다. */
export async function idToken(): Promise<string | null> {
  if (DEV_AUTH) {
    const name = sessionStorage.getItem(DEV_KEY)
    return name ? `dev:${name}` : null
  }
  try {
    return (await firebaseAuth().currentUser?.getIdToken()) ?? null
  } catch {
    return null
  }
}

export async function signInGoogle(): Promise<void> {
  const provider = new GoogleAuthProvider()
  provider.setCustomParameters({ prompt: 'select_account' })
  try {
    await signInWithPopup(firebaseAuth(), provider)
  } catch (e) {
    const code = (e as { code?: string }).code ?? ''
    if (code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request') throw new Error('로그인 창을 닫았습니다')
    if (code === 'auth/popup-blocked') throw new Error('브라우저가 로그인 창을 막았습니다. 팝업을 허용해 주세요')
    if (code === 'auth/unauthorized-domain') throw new Error('이 주소는 Firebase 에 로그인 허용 도메인으로 등록되어 있지 않습니다')
    if (code === 'auth/operation-not-supported-in-this-environment') throw new Error('이 브라우저에서는 로그인 창을 열 수 없습니다. 크롬 같은 일반 브라우저에서 열어 주세요')
    // 오류 원문에는 주소와 설정 값이 섞여 있을 수 있으므로 화면에는 띄우지 않는다
    throw new Error(code ? `로그인하지 못했습니다 (${code})` : '로그인하지 못했습니다. 잠시 후 다시 시도해 주세요')
  }
}

/** 가짜 로그인 (VITE_DEV_AUTH=1 일 때만) */
export function signInDev(name: string): void {
  if (!DEV_AUTH) throw new Error('개발용 로그인은 꺼져 있습니다')
  if (!/^[\p{L}\p{N}_]{2,12}$/u.test(name)) throw new Error('이름은 2~12자의 한글, 영문, 숫자, 밑줄만 쓸 수 있습니다')
  sessionStorage.setItem(DEV_KEY, name)
}

export async function signOutUser(): Promise<void> {
  if (DEV_AUTH) {
    sessionStorage.removeItem(DEV_KEY)
    return
  }
  await signOut(firebaseAuth())
}
