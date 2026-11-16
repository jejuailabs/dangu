import type { CueSpec, TableProfile } from './types'

/**
 * 계수의 근거 표기는 docs/02-physics-engine.md §5 참조.
 * [확인] 출처 확인, [지식] 재검증 필요, [초기값] 테스트로 보정 예정.
 */

/** 국제식 대대 (3쿠션 표준) */
export const CAROM_LARGE: TableProfile = {
  name: '대대 (3쿠션)',
  length: 2.84, // [지식]
  width: 1.42, // [지식]
  R: 0.03075, // 61.5mm [지식]
  m: 0.21, // [지식]
  g: 9.81,
  muSlide: 0.2, // [확인] Alciatore TP B-6
  muRoll: 0.01, // [확인] TP B-6
  spinDecel: 10.9, // [지식]
  eBall: 0.94, // [확인] TP A-6
  muBallA: 0.009951, // [지식] TP A-14 계열
  muBallB: 0.108,
  muBallC: 1.088,
  cushionModel: 'mathavan',
  eCushionEnergetic: 0.98, // [확인] Mathavan 2010 (스누커 실측 맞춤값)
  cushionRigidLimit: 2.5, // [확인] Mathavan 2010: 강체 쿠션 가정의 한계
  eCushionEnergeticSlope: 0.03, // [초기값]
  eCushionEnergeticMin: 0.8, // [초기값]
  eCushion: 0.85, // [초기값]
  eCushionSlope: 0.02, // [초기값]
  eCushionMin: 0.6, // [초기값]
  muCushion: 0.14, // [확인] Mathavan 2010
  cushionHeight: 0.037, // [지식]
  eTable: 0.5, // [초기값]
  hopThreshold: 0.25, // [초기값]
  tiltX: 0,
  tiltY: 0,
}

/**
 * Mathavan(2010) 논문의 스누커 조건. 논문 수치와 대조하는 검증용.
 * M = 0.1406 kg, R = 26.25 mm, sin(theta) = 2/5, mu_s = 0.212, mu_w = 0.14, e_e = 0.98
 */
export const SNOOKER_MATHAVAN: TableProfile = {
  ...CAROM_LARGE,
  name: '스누커 (Mathavan 2010 검증용)',
  length: 3.569,
  width: 1.778,
  R: 0.02625,
  m: 0.1406,
  muSlide: 0.212,
  cushionHeight: 0.02625 * 1.4,
  cushionModel: 'mathavan',
  eCushionEnergetic: 0.98,
  muCushion: 0.14,
}

/** 한국식 중대 (4구) */
export const CAROM_MEDIUM_4BALL: TableProfile = {
  ...CAROM_LARGE,
  name: '중대 (4구)',
  length: 2.448, // [지식, 재검증]
  width: 1.224, // [지식, 재검증]
  R: 0.03275, // 65.5mm [지식, 재검증]
  m: 0.23, // [초기값]
  cushionHeight: 0.039, // [초기값]
}

export const DEFAULT_CUE: CueSpec = {
  mass: 0.52, // [지식]
  tipRestitution: 0.75, // [지식]
  endMass: 0.01, // [초기값] 공 질량의 약 1/20
  contactTime: 0.0015, // [확인] 0.8~3ms 범위
  miscueLimit: 0.5, // [지식]
}
