/**
 * 코드로 만드는 텍스처 (PRD 07 §2). 외부 이미지 파일 없이 캔버스에 직접 그린다.
 */
import * as THREE from 'three'

function canvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  return [c, c.getContext('2d')!]
}

/** 시드가 고정된 난수 (텍스처가 매번 같게) */
function rng(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 4294967296
  }
}

/**
 * 공 텍스처 (정방위 전개). 회전이 눈에 보이도록 점 6개를 찍는다: 적도 위 4개, 양 극 2개.
 */
export function ballTexture(base: string, dot: string, dotRadiusDeg = 13): THREE.CanvasTexture {
  const W = 1024
  const H = 512
  const [c, g] = canvas(W, H)
  g.fillStyle = base
  g.fillRect(0, 0, W, H)
  g.fillStyle = dot
  const ry = (dotRadiusDeg / 180) * H
  // 적도 위의 점: 경도 0, 90, 180, 270 도
  for (let k = 0; k < 4; k++) {
    const cx = ((k + 0.5) / 4) * W
    g.beginPath()
    g.ellipse(cx, H / 2, (dotRadiusDeg / 360) * W, ry, 0, 0, Math.PI * 2)
    g.fill()
  }
  // 극의 점: 전개도에서는 위아래 띠가 된다
  g.fillRect(0, 0, W, ry)
  g.fillRect(0, H - ry, W, ry)
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  t.anisotropy = 8
  return t
}

/** 당구 천: 미세한 섬유 얼룩 */
export function clothTexture(color: [number, number, number]): THREE.CanvasTexture {
  const S = 256
  const [c, g] = canvas(S, S)
  const img = g.createImageData(S, S)
  const r = rng(7)
  for (let i = 0; i < S * S; i++) {
    const n = 0.93 + r() * 0.14
    img.data[i * 4] = Math.min(255, color[0] * n)
    img.data[i * 4 + 1] = Math.min(255, color[1] * n)
    img.data[i * 4 + 2] = Math.min(255, color[2] * n)
    img.data[i * 4 + 3] = 255
  }
  g.putImageData(img, 0, 0)
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  t.wrapS = t.wrapT = THREE.RepeatWrapping
  t.repeat.set(24, 12)
  return t
}

/** 나무: 길이 방향의 결 */
export function woodTexture(): THREE.CanvasTexture {
  const W = 512
  const H = 128
  const [c, g] = canvas(W, H)
  g.fillStyle = '#5b3a21'
  g.fillRect(0, 0, W, H)
  const r = rng(21)
  for (let i = 0; i < 260; i++) {
    const y = r() * H
    const shade = r()
    g.strokeStyle = shade > 0.5 ? `rgba(120,78,44,${0.1 + r() * 0.25})` : `rgba(48,28,14,${0.1 + r() * 0.3})`
    g.lineWidth = 0.5 + r() * 1.8
    g.beginPath()
    g.moveTo(0, y)
    const wob = (r() - 0.5) * 6
    g.bezierCurveTo(W * 0.3, y + wob, W * 0.7, y - wob, W, y + (r() - 0.5) * 4)
    g.stroke()
  }
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  t.wrapS = t.wrapT = THREE.RepeatWrapping
  return t
}
