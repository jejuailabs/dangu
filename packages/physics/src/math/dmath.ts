/**
 * 결정적 수학 함수.
 *
 * Math.sin / Math.cos / Math.exp 는 자바스크립트 엔진마다 마지막 자리가 다를 수 있다.
 * 온라인 검증과 리플레이를 위해 물리 코어는 사칙연산과 Math.sqrt(IEEE 754로 정확히 정의됨)만
 * 사용하는 아래 구현만 쓴다. 물리 코어 안에서 Math.sin 등은 사용 금지.
 */

export const PI = 3.141592653589793
export const DEG = PI / 180

// pi/2 를 두 부분으로 나눠 범위 축소 시 자릿수 손실을 줄인다.
const PIO2_HI = 1.5707963267341256
const PIO2_LO = 6.077100506506192e-11
const TWO_OVER_PI = 0.6366197723675814

// 테일러 계수 (높은 차수부터). 1/n! 은 정수 나눗셈이라 모든 환경에서 같은 값이다.
const SIN_C = [
  1 / 355687428096000,
  -1 / 1307674368000,
  1 / 6227020800,
  -1 / 39916800,
  1 / 362880,
  -1 / 5040,
  1 / 120,
  -1 / 6,
  1,
]
const COS_C = [
  1 / 20922789888000,
  -1 / 87178291200,
  1 / 479001600,
  -1 / 3628800,
  1 / 40320,
  -1 / 720,
  1 / 24,
  -1 / 2,
  1,
]

/** r - r^3/3! + ... + r^17/17! */
function sinPoly(r: number): number {
  const r2 = r * r
  let s = 0
  for (let i = 0; i < SIN_C.length; i++) s = s * r2 + SIN_C[i]
  return r * s
}

/** 1 - r^2/2! + ... + r^16/16! */
function cosPoly(r: number): number {
  const r2 = r * r
  let s = 0
  for (let i = 0; i < COS_C.length; i++) s = s * r2 + COS_C[i]
  return s
}

/** x 를 [-pi/4, pi/4] 로 줄이고 사분면 번호(0~3)를 돌려준다. */
function reduce(x: number): [number, number] {
  const k = Math.round(x * TWO_OVER_PI)
  const r = x - k * PIO2_HI - k * PIO2_LO
  return [r, ((k % 4) + 4) % 4]
}

export function dsin(x: number): number {
  const [r, q] = reduce(x)
  switch (q) {
    case 0:
      return sinPoly(r)
    case 1:
      return cosPoly(r)
    case 2:
      return -sinPoly(r)
    default:
      return -cosPoly(r)
  }
}

export function dcos(x: number): number {
  const [r, q] = reduce(x)
  switch (q) {
    case 0:
      return cosPoly(r)
    case 1:
      return -sinPoly(r)
    case 2:
      return -cosPoly(r)
    default:
      return sinPoly(r)
  }
}

const LN2 = 0.6931471805599453

export function dexp(x: number): number {
  if (x > 700) return Infinity
  if (x < -700) return 0
  const k = Math.round(x / LN2)
  const r = x - k * LN2
  // |r| <= 0.35, 테일러 14차
  let term = 1
  let sum = 1
  for (let i = 1; i <= 14; i++) {
    term = (term * r) / i
    sum += term
  }
  // 2^k 는 반복 곱으로 정확히 계산
  let p = 1
  if (k >= 0) for (let i = 0; i < k; i++) p *= 2
  else for (let i = 0; i < -k; i++) p *= 0.5
  return sum * p
}

/** 자연로그. dexp 를 이용한 핼리 반복이라 결과가 환경에 무관하다. x > 0 */
export function dlog(x: number): number {
  if (!(x > 0)) return NaN
  // 2 의 거듭제곱을 먼저 떼어 반복 횟수를 줄인다.
  let k = 0
  let m = x
  while (m > 1.5) {
    m *= 0.5
    k++
  }
  while (m < 0.75) {
    m *= 2
    k--
  }
  let y = 0
  for (let i = 0; i < 12; i++) {
    const e = dexp(y)
    y += (2 * (m - e)) / (m + e)
  }
  return y + k * LN2
}

/** x^p (x > 0) */
export function dpow(x: number, p: number): number {
  return dexp(p * dlog(x))
}
