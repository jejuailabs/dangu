export type Vec3 = [number, number, number]

export const v3 = (x = 0, y = 0, z = 0): Vec3 => [x, y, z]
export const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
export const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
export const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s]
export const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
export const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
]
export const len = (a: Vec3): number => Math.sqrt(dot(a, a))
/** a + b*s */
export const addScaled = (a: Vec3, b: Vec3, s: number): Vec3 => [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s]
export const unit = (a: Vec3): Vec3 => {
  const l = len(a)
  return l === 0 ? [0, 0, 0] : [a[0] / l, a[1] / l, a[2] / l]
}
