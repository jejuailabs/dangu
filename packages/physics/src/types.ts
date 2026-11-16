import type { Vec3 } from './math/vec'

/** 공의 운동 상태 (PRD 02 §3) */
export type MotionState = 'stationary' | 'spinning' | 'sliding' | 'rolling' | 'airborne' | 'out'

export interface BallState {
  id: number
  /** 중심 위치 (m). 테이블 위에 있으면 z = R */
  r: Vec3
  /** 속도 (m/s) */
  v: Vec3
  /** 각속도 (rad/s) */
  w: Vec3
  s: MotionState
  /**
   * 기울어진 테이블에서 쿠션이나 다른 공에 기대어 멈춘 상태.
   * 기대어 있는 동안은 중력 경사 성분으로 다시 굴러가지 않는다.
   */
  held?: boolean
  /**
   * 기울어진 테이블에서 중력에 눌려 쿠션을 타고 가는(또는 쿠션에 붙어 있는) 상태.
   * 쿠션별 비트: 1 = x-, 2 = x+, 4 = y-, 8 = y+.
   * 타고 있는 쿠션 쪽으로는 가속되지 않고, 그 쿠션과의 충돌 검사도 하지 않는다.
   */
  ride?: number
}

/**
 * 테이블·공·환경의 물리 계수 묶음.
 * 좌표: x 는 긴 변(0..length), y 는 짧은 변(0..width), z 는 위쪽.
 */
export interface TableProfile {
  name: string
  /** 경기면 긴 변 (m) */
  length: number
  /** 경기면 짧은 변 (m) */
  width: number
  /** 공 반지름 (m) */
  R: number
  /** 공 질량 (kg) */
  m: number
  /** 중력 가속도 (m/s^2) */
  g: number
  /** 공-천 미끄럼 마찰 계수 */
  muSlide: number
  /** 구름 저항 계수 */
  muRoll: number
  /** 제자리(수직축) 회전 감속 (rad/s^2) */
  spinDecel: number
  /** 공-공 반발계수 */
  eBall: number
  /** 공-공 마찰: mu = a + b * exp(-c * 접점 미끄럼 속도) */
  muBallA: number
  muBallB: number
  muBallC: number
  /**
   * 쿠션 충돌 모델.
   * - mathavan: Mathavan(2010). 쿠션 접점과 바닥 접점의 마찰을 함께 수치 적분한다. 기본값.
   * - han: Han(2005) 방식의 임펄스 모델. 빠르다 (AI 대량 탐색용).
   */
  cushionModel: 'mathavan' | 'han'
  /** [mathavan] 에너지 기준 반발계수 */
  eCushionEnergetic: number
  /** [mathavan] 이 법선 속도(m/s)를 넘으면 쿠션이 눌려 반발이 줄어든다 */
  cushionRigidLimit: number
  /** [mathavan] 한계 초과분 1 m/s 당 반발계수 감소량 */
  eCushionEnergeticSlope: number
  eCushionEnergeticMin: number
  /** [han] 쿠션 반발계수 (느린 입사 기준) */
  eCushion: number
  /** [han] 쿠션 반발계수의 속도 의존: e = max(eCushionMin, eCushion - eCushionSlope * 입사속도) */
  eCushionSlope: number
  eCushionMin: number
  /** 쿠션 마찰 계수 */
  muCushion: number
  /** 쿠션 접촉 높이 (바닥에서, m) */
  cushionHeight: number
  /** 공-바닥(슬레이트+천) 수직 반발계수 */
  eTable: number
  /** 이 수직 속도 미만의 튐은 무시하고 바닥에 붙인다 (m/s) */
  hopThreshold: number
  /**
   * 테이블 기울기. 중력 가속도의 수평 성분을 g 에 대한 비율로 준다 (= sin 기울기각).
   * tiltX > 0 이면 +x 쪽이 낮다. 수평이면 0.
   */
  tiltX: number
  tiltY: number
}

export interface CueSpec {
  /** 큐 질량 (kg) */
  mass: number
  /** 팁-공 반발계수 */
  tipRestitution: number
  /** 큐 끝 유효 질량 (kg). 작을수록 스쿼트가 작다 */
  endMass: number
  /** 기준 조건(중심 타격, 큐 속도 2 m/s)에서의 팁 접촉 시간 (s). 부드러운 팁일수록 길다 */
  contactTime: number
  /** 미스큐 한계 (당점 거리 / R) */
  miscueLimit: number
}

/** 한 번의 샷 입력. 모든 입력 방식(스트로크, 게이지, 수치, AI)이 이 형식을 만든다. */
export interface ShotInput {
  /** 칠 공의 id */
  ballId: number
  /** 조준 방향 (rad). 0 은 +x, 반시계 방향이 양수 */
  phi: number
  /** 큐 고각 (rad). 0 은 수평, pi/2 는 수직 */
  theta: number
  /** 좌우 당점 (-1..1, R 기준). 양수는 공의 오른쪽 */
  side: number
  /** 상하 당점 (-1..1, R 기준). 양수는 위(밀어치기) */
  top: number
  /** 임팩트 순간 큐 속도 (m/s) */
  speed: number
  /** 임팩트 순간 큐 가속도 (m/s^2). 가속 중이면 양수, 감속 중이면 음수 */
  accel?: number
  cue: CueSpec
}

export type EventType = 'strike' | 'ball-ball' | 'cushion' | 'transition' | 'out'
export type CushionId = 'x-' | 'x+' | 'y-' | 'y+'

export interface SimEvent {
  /** 샷 시작부터의 시각 (s) */
  t: number
  type: EventType
  /** 관련된 공 id */
  ids: number[]
  cushion?: CushionId
  /** 미스큐 여부 (strike 이벤트) */
  miscue?: boolean
  /** 팁 접촉 시간 (strike 이벤트, s) */
  contactTime?: number
  /** 이벤트 직후 모든 공의 상태. 다음 이벤트까지는 이 상태에서 해석식으로 진행한다 */
  balls: BallState[]
}

export interface ShotResult {
  events: SimEvent[]
  final: BallState[]
  /** 모든 공이 멈춘 시각 (s) */
  duration: number
  /** 결과 해시. 클라이언트·서버 일치 검사용 */
  hash: string
  /** 이벤트 수 상한에 걸려 중단된 경우 true */
  truncated: boolean
}
