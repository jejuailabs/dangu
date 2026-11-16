/**
 * 4차 이하 다항식의 실근 찾기.
 *
 * 닫힌 해(페라리 공식)는 세제곱근과 삼각함수가 필요하고 수치적으로 불안정하다.
 * 여기서는 도함수의 근으로 구간을 단조 구간으로 나눈 뒤 이분법을 쓴다.
 * 사칙연산만 사용하므로 모든 환경에서 결과가 같다.
 *
 * 계수는 낮은 차수부터: c[0] + c[1] t + c[2] t^2 + ...
 */

export function polyEval(c: number[], t: number): number {
  let r = 0
  for (let i = c.length - 1; i >= 0; i--) r = r * t + c[i]
  return r
}

export function polyDeriv(c: number[]): number[] {
  const d: number[] = []
  for (let i = 1; i < c.length; i++) d.push(c[i] * i)
  return d
}

/** [lo, hi] 에서 부호가 바뀌는 지점을 이분법으로 찾는다. f(lo) 와 f(hi) 의 부호가 달라야 한다. */
function bisect(c: number[], lo: number, hi: number, flo: number): [number, number] {
  for (let i = 0; i < 200; i++) {
    const mid = 0.5 * (lo + hi)
    if (mid === lo || mid === hi) break
    const fm = polyEval(c, mid)
    if (fm === 0) return [mid, mid]
    if (fm > 0 === flo > 0) lo = mid
    else hi = mid
  }
  return [lo, hi]
}

/** 구간 [a, b] 안의 실근(부호가 바뀌는 지점)을 오름차순으로 돌려준다. */
export function realRoots(c: number[], a: number, b: number): number[] {
  // 유효 차수
  let n = c.length - 1
  while (n > 0 && c[n] === 0) n--
  if (n === 0) return []
  if (n === 1) {
    const r = -c[0] / c[1]
    return r >= a && r <= b ? [r] : []
  }
  const cc = n === c.length - 1 ? c : c.slice(0, n + 1)
  const crit = realRoots(polyDeriv(cc), a, b)
  const pts = [a, ...crit, b]
  const roots: number[] = []
  const push = (r: number) => {
    if (roots.length === 0 || roots[roots.length - 1] !== r) roots.push(r)
  }
  for (let i = 0; i < pts.length - 1; i++) {
    const lo = pts[i]
    const hi = pts[i + 1]
    if (hi <= lo) continue
    const flo = polyEval(cc, lo)
    const fhi = polyEval(cc, hi)
    if (flo === 0) {
      push(lo)
      continue
    }
    if (fhi === 0) continue // 다음 구간의 lo 또는 마지막 검사에서 처리
    if (flo > 0 !== fhi > 0) {
      const [l, h] = bisect(cc, lo, hi, flo)
      push(0.5 * (l + h))
    }
  }
  if (polyEval(cc, b) === 0) push(b)
  return roots
}

/**
 * f(t) 가 양수에서 0 이하로 내려가는 가장 이른 시각을 [0, tmax] 에서 찾는다.
 * f 는 "간격" 함수(공 사이 거리, 쿠션까지 거리 등)이고, 0 이하가 되는 순간이 충돌이다.
 *
 * - 이미 닿아 있고(f(0) <= 0) 더 가까워지는 중이면 0 을 돌려준다.
 * - 닿아 있지만 멀어지는 중이면 무시하고 이후의 재접근만 찾는다.
 * - 없으면 Infinity.
 */
export function firstDownCrossing(c: number[], tmax: number): number {
  const f0 = c[0]
  const c1 = c.length > 1 ? c[1] : 0
  const c2 = c.length > 2 ? c[2] : 0
  if (f0 <= 0 && (c1 < 0 || (c1 === 0 && c2 < 0))) return 0
  if (!(tmax > 0)) return Infinity

  const crit = realRoots(polyDeriv(c), 0, tmax)
  const pts = [0, ...crit, tmax]
  for (let i = 0; i < pts.length - 1; i++) {
    const lo = pts[i]
    const hi = pts[i + 1]
    if (hi <= lo) continue
    const flo = polyEval(c, lo)
    const fhi = polyEval(c, hi)
    if (flo > 0 && fhi <= 0) {
      // 접촉이 성립한 쪽(f <= 0)을 돌려준다.
      const [, h] = bisect(c, lo, hi, flo)
      return h
    }
  }
  return Infinity
}
