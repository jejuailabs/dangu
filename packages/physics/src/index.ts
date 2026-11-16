export * from './types'
export * from './profiles'
export { simulate, evolveSystem, stateAt, makeBall } from './simulate'
export { strike, strikeImpulse, type StrikeInfo } from './collide/cue'
export { collideBalls } from './collide/ballBall'
export { collideCushion, cushionReach } from './collide/cushion'
export { energy, evolve, normalize, slipVelocity, transitionTime, cloneBall } from './motion'
export { dsin, dcos, dexp, dlog, dpow, PI, DEG } from './math/dmath'
export { selfTestHash } from './selftest'
export { realRoots, firstDownCrossing, polyEval } from './math/poly'

/** 물리 코어 버전. 결과가 달라지는 변경이 있으면 올린다. 리플레이에 함께 저장된다. */
export const CORE_VERSION = '0.2.0'
