/**
 * 3D 장면 (PRD 07). 테이블·공·큐를 실제 치수로 코드에서 만들고, 물리 코어의 결과를 그대로 그린다.
 *
 * 좌표 변환: 물리 (x 긴 변, y 짧은 변, z 위)  ->  Three (X = x - L/2, Y = z, Z = -(y - W/2)).
 * 오른손 좌표계가 유지되므로 각속도 벡터도 같은 식으로 옮기면 된다.
 */
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'
import type { BallState, TableProfile } from '../../../packages/physics/src'
import { CUE_BUTT_RADIUS, CUE_LENGTH, CUE_TIP_RADIUS, RAIL_TOP, cueFrame, type V3 } from './cueGeometry'
import { ballTexture, clothTexture, woodTexture } from './textures'

export type ViewMode = 'aim' | 'top' | 'free'

const CUSHION_DEPTH = 0.045
const RAIL_WIDTH = 0.125
const BALL_LOOK: Record<number, { base: string; dot: string }> = {
  0: { base: '#f4f1e6', dot: '#c0392b' },
  1: { base: '#f0b90b', dot: '#7a1f12' },
  2: { base: '#c41e1e', dot: '#8f1010' },
  3: { base: '#c41e1e', dot: '#8f1010' },
}
const LINE_COLORS = [0xffffff, 0xffd34d, 0xff6b6b, 0xff6b6b]

export class TableScene {
  readonly renderer: THREE.WebGLRenderer
  private scene = new THREE.Scene()
  private persp: THREE.PerspectiveCamera
  private ortho: THREE.OrthographicCamera
  private orbit: OrbitControls
  private tableGroup = new THREE.Group()
  private ballMeshes = new Map<number, THREE.Mesh>()
  private cue = new THREE.Group()
  private cueButt!: THREE.Mesh
  private cueRing!: THREE.Mesh
  private lines: THREE.Line[] = []
  private aimLine: THREE.Line
  private table!: TableProfile
  private L = 0
  private W = 0
  view: ViewMode = 'aim'
  /** 샷 진행 중에는 조준 시점 대신 전체가 보이는 시점을 쓴다 */
  overview = false
  /** 메뉴 화면용: 카메라가 테이블 주위를 천천히 돈다 */
  attract = false
  private attractAngle = 0.6
  private insets = { right: 0, top: 0, bottom: 0 }
  /** 조준 시점에서 사용자가 조절한 값: 좌우로 돈 각(rad), 높이(m), 거리 배율 */
  readonly adj = { yaw: 0, lift: 0, zoom: 1 }
  private camPos = new THREE.Vector3(0, 2, 2)
  private camLook = new THREE.Vector3()
  private raycaster = new THREE.Raycaster()

  constructor(private canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    this.renderer.shadowMap.enabled = true
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping
    this.renderer.toneMappingExposure = 1.05
    this.scene.background = new THREE.Color(0x2a2d8c)

    // 공의 반사를 위한 환경 (코드로 만든 실내)
    const pmrem = new THREE.PMREMGenerator(this.renderer)
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture
    this.scene.environmentIntensity = 0.55

    this.persp = new THREE.PerspectiveCamera(42, 1, 0.05, 30)
    this.ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 20)
    this.ortho.position.set(0, 5, 0)
    this.ortho.up.set(0, 0, -1)
    this.ortho.lookAt(0, 0, 0)

    this.orbit = new OrbitControls(this.persp, canvas)
    this.orbit.enabled = false
    this.orbit.enableDamping = true
    this.orbit.maxPolarAngle = Math.PI / 2 - 0.05
    this.orbit.minDistance = 0.4
    this.orbit.maxDistance = 6

    this.scene.add(this.tableGroup)
    this.buildCue()
    this.scene.add(this.cue)

    const aimGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()])
    this.aimLine = new THREE.Line(aimGeo, new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.35 }))
    this.aimLine.visible = false
    this.scene.add(this.aimLine)

    this.scene.add(new THREE.HemisphereLight(0xe6ecff, 0x3a2f6a, 0.7))
  }

  toThree(x: number, y: number, z: number): THREE.Vector3 {
    return new THREE.Vector3(x - this.L / 2, z, -(y - this.W / 2))
  }
  private dirToThree(v: V3): THREE.Vector3 {
    return new THREE.Vector3(v[0], v[2], -v[1])
  }

  /** 테이블과 공을 새 규격으로 다시 만든다. */
  setTable(table: TableProfile, ballIds: number[]): void {
    this.table = table
    this.L = table.length
    this.W = table.width
    this.tableGroup.clear()
    this.ballMeshes.clear()
    const L = this.L
    const W = this.W
    const cd = CUSHION_DEPTH
    const h = table.cushionHeight

    const clothMat = new THREE.MeshStandardMaterial({ map: clothTexture([24, 92, 172]), roughness: 0.95, metalness: 0 })
    const cushionMat = new THREE.MeshStandardMaterial({ color: 0x1a569f, roughness: 0.9 })
    const wood = woodTexture()
    const woodMat = new THREE.MeshStandardMaterial({ map: wood, roughness: 0.45, metalness: 0.05 })
    const bodyMat = new THREE.MeshStandardMaterial({ color: 0x1b1410, roughness: 0.7 })

    // 경기면
    const bed = new THREE.Mesh(new THREE.PlaneGeometry(L + 2 * cd, W + 2 * cd), clothMat)
    bed.rotation.x = -Math.PI / 2
    bed.receiveShadow = true
    this.tableGroup.add(bed)

    // 쿠션: 코(nose)가 경기면 경계 위 높이 h 에 오는 쐐기 단면을 길이 방향으로 밀어낸다
    const profile = new THREE.Shape()
    profile.moveTo(0, h)
    profile.lineTo(cd, RAIL_TOP)
    profile.lineTo(cd, 0)
    profile.lineTo(0.02, 0)
    profile.lineTo(0, h - 0.008)
    profile.closePath()
    const addCushion = (len: number, rotY: number, px: number, pz: number) => {
      const geo = new THREE.ExtrudeGeometry(profile, { depth: len, bevelEnabled: false })
      const m = new THREE.Mesh(geo, cushionMat)
      m.rotation.y = rotY
      m.position.set(px, 0, pz)
      m.castShadow = true
      m.receiveShadow = true
      this.tableGroup.add(m)
    }
    addCushion(W + 2 * cd, 0, L / 2, -(W / 2 + cd)) // x+
    addCushion(W + 2 * cd, Math.PI, -L / 2, W / 2 + cd) // x-
    addCushion(L + 2 * cd, Math.PI / 2, -(L / 2 + cd), -W / 2) // y+
    addCushion(L + 2 * cd, -Math.PI / 2, L / 2 + cd, W / 2) // y-

    // 나무 레일
    const railH = RAIL_TOP + 0.14
    const addRail = (sx: number, sz: number, px: number, pz: number) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(sx, railH, sz), woodMat)
      m.position.set(px, RAIL_TOP - railH / 2, pz)
      m.castShadow = true
      m.receiveShadow = true
      this.tableGroup.add(m)
    }
    const ox = L / 2 + cd + RAIL_WIDTH / 2
    const oz = W / 2 + cd + RAIL_WIDTH / 2
    addRail(RAIL_WIDTH, W + 2 * cd + 2 * RAIL_WIDTH, ox, 0)
    addRail(RAIL_WIDTH, W + 2 * cd + 2 * RAIL_WIDTH, -ox, 0)
    addRail(L + 2 * cd, RAIL_WIDTH, 0, oz)
    addRail(L + 2 * cd, RAIL_WIDTH, 0, -oz)

    // 다이아몬드 (포인트)
    const diaMat = new THREE.MeshStandardMaterial({ color: 0xf2ead8, roughness: 0.3 })
    const diaGeo = new THREE.CircleGeometry(0.008, 20)
    const addDia = (x: number, z: number) => {
      const m = new THREE.Mesh(diaGeo, diaMat)
      m.rotation.x = -Math.PI / 2
      m.position.set(x, RAIL_TOP + 0.0006, z)
      this.tableGroup.add(m)
    }
    for (let i = 0; i <= 8; i++) {
      addDia(-L / 2 + (L * i) / 8, oz)
      addDia(-L / 2 + (L * i) / 8, -oz)
    }
    for (let i = 0; i <= 4; i++) {
      addDia(ox, -W / 2 + (W * i) / 4)
      addDia(-ox, -W / 2 + (W * i) / 4)
    }

    // 몸체와 바닥
    const body = new THREE.Mesh(new THREE.BoxGeometry(L + 0.2, 0.5, W + 0.2), bodyMat)
    body.position.y = -0.36
    this.tableGroup.add(body)
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(14, 14),
      new THREE.MeshStandardMaterial({ color: 0x23267a, roughness: 0.9 }),
    )
    floor.rotation.x = -Math.PI / 2
    floor.position.y = -0.8
    floor.receiveShadow = true
    this.tableGroup.add(floor)

    // 테이블 위 조명 3개
    for (const fx of [-0.33, 0, 0.33]) {
      const light = new THREE.SpotLight(0xfff4dc, 9, 5, 0.62, 0.55, 1.4)
      light.position.set(fx * L, 1.55, 0)
      light.target.position.set(fx * L, 0, 0)
      light.castShadow = true
      light.shadow.mapSize.set(1024, 1024)
      light.shadow.camera.near = 0.5
      light.shadow.camera.far = 3
      light.shadow.bias = -0.0004
      light.shadow.radius = 4
      this.tableGroup.add(light, light.target)
    }

    // 공
    const geo = new THREE.SphereGeometry(table.R, 48, 32)
    for (const id of ballIds) {
      const look = BALL_LOOK[id] ?? BALL_LOOK[2]
      const mat = new THREE.MeshPhysicalMaterial({
        map: ballTexture(look.base, look.dot),
        roughness: 0.14,
        clearcoat: 1,
        clearcoatRoughness: 0.06,
        envMapIntensity: 1.1,
      })
      const mesh = new THREE.Mesh(geo, mat)
      mesh.castShadow = true
      mesh.receiveShadow = true
      this.tableGroup.add(mesh)
      this.ballMeshes.set(id, mesh)
    }

    // 예측선
    for (const l of this.lines) this.scene.remove(l)
    this.lines = ballIds.map((id) => {
      const line = new THREE.Line(
        new THREE.BufferGeometry(),
        new THREE.LineBasicMaterial({ color: LINE_COLORS[id] ?? 0xffffff, transparent: true, opacity: 0.6 }),
      )
      line.visible = false
      this.scene.add(line)
      return line
    })

    // 탑뷰 카메라가 테이블 전체를 담게 한다
    this.resize()
    this.orbit.target.set(0, 0, 0)
    this.persp.position.set(0, 1.9, 2.3)
  }

  private buildCue(): void {
    // 팁이 원점, 몸통은 -Y 방향으로 뻗는다
    const shaft = new THREE.Mesh(
      new THREE.CylinderGeometry(CUE_TIP_RADIUS, CUE_BUTT_RADIUS, CUE_LENGTH, 20),
      new THREE.MeshStandardMaterial({ color: 0xd9b77a, roughness: 0.4 }),
    )
    shaft.position.y = -CUE_LENGTH / 2 - 0.012
    const butt = new THREE.Mesh(
      new THREE.CylinderGeometry(CUE_BUTT_RADIUS * 0.82, CUE_BUTT_RADIUS, CUE_LENGTH * 0.4, 20),
      new THREE.MeshStandardMaterial({ color: 0x2a1a12, roughness: 0.5 }),
    )
    butt.position.y = -CUE_LENGTH * 0.8 - 0.012
    this.cueButt = butt
    // 손잡이와 상대 사이의 장식 링 (큐마다 색이 다르다)
    const ring = new THREE.Mesh(
      new THREE.CylinderGeometry(CUE_BUTT_RADIUS * 0.8, CUE_BUTT_RADIUS * 0.84, 0.03, 20),
      new THREE.MeshStandardMaterial({ color: 0xc9a66b, roughness: 0.25, metalness: 0.6 }),
    )
    ring.position.y = -CUE_LENGTH * 0.6 - 0.012
    ring.castShadow = true
    this.cueRing = ring
    this.cue.add(ring)
    const ferrule = new THREE.Mesh(
      new THREE.CylinderGeometry(CUE_TIP_RADIUS, CUE_TIP_RADIUS, 0.012, 16),
      new THREE.MeshStandardMaterial({ color: 0xf2f2f2, roughness: 0.3 }),
    )
    ferrule.position.y = -0.012
    const tip = new THREE.Mesh(
      new THREE.CylinderGeometry(CUE_TIP_RADIUS * 0.92, CUE_TIP_RADIUS, 0.006, 16),
      new THREE.MeshStandardMaterial({ color: 0x2c6fb5, roughness: 0.9 }),
    )
    tip.position.y = -0.003
    for (const m of [shaft, butt, ferrule, tip]) {
      m.castShadow = true
      this.cue.add(m)
    }
  }

  /** 큐의 색을 바꾼다 (장착한 큐에 따라). */
  setCueStyle(butt: number, accent: number): void {
    ;(this.cueButt.material as THREE.MeshStandardMaterial).color.setHex(butt)
    ;(this.cueRing.material as THREE.MeshStandardMaterial).color.setHex(accent)
  }

  /** 공의 위치를 갱신한다. */
  setBalls(states: BallState[]): void {
    for (const b of states) {
      const mesh = this.ballMeshes.get(b.id)
      if (!mesh) continue
      mesh.visible = b.s !== 'out'
      mesh.position.copy(this.toThree(b.r[0], b.r[1], b.r[2]))
    }
  }

  /** 각속도대로 공의 자세를 dt 만큼 돌린다. 물리 코어의 3축 회전을 그대로 쓴다 (근사 애니메이션 아님). */
  advanceSpin(states: BallState[], dt: number): void {
    const axis = new THREE.Vector3()
    const dq = new THREE.Quaternion()
    for (const b of states) {
      const mesh = this.ballMeshes.get(b.id)
      if (!mesh) continue
      axis.set(b.w[0], b.w[2], -b.w[1])
      const speed = axis.length()
      if (speed < 1e-6) continue
      dq.setFromAxisAngle(axis.divideScalar(speed), speed * dt)
      mesh.quaternion.premultiply(dq)
    }
  }

  resetSpin(): void {
    for (const m of this.ballMeshes.values()) m.quaternion.identity()
  }

  /** 큐를 그린다. pull 은 팁과 공 사이의 간격(m) */
  setCue(visible: boolean, ball?: BallState, phi = 0, theta = 0, side = 0, top = 0, pull = 0.02): void {
    this.cue.visible = visible
    if (!visible || !ball) return
    const { q, p } = cueFrame(this.table.R, phi, theta, side, top)
    const tipPos = this.toThree(
      ball.r[0] + p[0] - q[0] * pull,
      ball.r[1] + p[1] - q[1] * pull,
      ball.r[2] + p[2] - q[2] * pull,
    )
    this.cue.position.copy(tipPos)
    this.cue.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), this.dirToThree(q).normalize())
  }

  /** 조준선 (수구에서 조준 방향으로 뻗는 직선) */
  setAimLine(visible: boolean, ball?: BallState, phi = 0, length = 3): void {
    this.aimLine.visible = visible
    if (!visible || !ball) return
    const a = this.toThree(ball.r[0], ball.r[1], 0.003)
    const b = this.toThree(ball.r[0] + Math.cos(phi) * length, ball.r[1] + Math.sin(phi) * length, 0.003)
    this.aimLine.geometry.setFromPoints([a, b])
  }

  /** 예측 경로. paths[i] 는 i 번째 공의 (x, y) 점 목록. 비어 있으면 숨긴다 */
  setPrediction(paths: [number, number][][]): void {
    this.lines.forEach((line, i) => {
      const pts = paths[i]
      if (!pts || pts.length < 2) {
        line.visible = false
        return
      }
      line.geometry.dispose()
      line.geometry = new THREE.BufferGeometry().setFromPoints(pts.map((p) => this.toThree(p[0], p[1], 0.004)))
      line.visible = true
    })
  }

  /** 조준 시점 카메라의 목표 위치를 정한다. */
  aimCamera(ball: BallState, phi: number, theta: number): void {
    const back = 0.95
    // 고각이 클수록 위에서 내려다본다
    const a = phi + this.adj.yaw
    const z = this.adj.zoom
    const lift = Math.min(Math.max((0.36 + 0.9 * Math.sin(theta)) * z + this.adj.lift, 0.09), 3.2)
    const pull = back * (1 - 0.55 * Math.sin(theta)) * z
    this.camPos.copy(this.toThree(ball.r[0] - Math.cos(a) * pull, ball.r[1] - Math.sin(a) * pull, lift))
    this.camLook.copy(this.toThree(ball.r[0] + Math.cos(a) * 0.55, ball.r[1] + Math.sin(a) * 0.55, 0.02))
  }

  /** 조준 시점을 돌리고(yaw), 올리고(lift), 당기거나 민다(zoom 배율). */
  adjustView(dyaw: number, dlift: number, zoomMul: number): void {
    let y = this.adj.yaw + dyaw
    while (y > Math.PI) y -= 2 * Math.PI
    while (y < -Math.PI) y += 2 * Math.PI
    this.adj.yaw = y
    this.adj.lift = Math.min(Math.max(this.adj.lift + dlift, -0.25), 1.8)
    this.adj.zoom = Math.min(Math.max(this.adj.zoom * zoomMul, 0.45), 2.6)
  }

  resetView(): void {
    this.adj.yaw = 0
    this.adj.lift = 0
    this.adj.zoom = 1
  }

  setView(v: ViewMode): void {
    this.view = v
    this.orbit.enabled = v === 'free'
  }

  get camera(): THREE.Camera {
    return this.view === 'top' ? this.ortho : this.persp
  }

  /** 화면 좌표를 테이블 위의 물리 좌표 (x, y) 로 바꾼다 (공 중심 높이의 평면 기준). */
  pick(clientX: number, clientY: number): [number, number] | null {
    const rect = this.canvas.getBoundingClientRect()
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1)
    this.raycaster.setFromCamera(ndc, this.camera)
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -this.table.R)
    const hit = new THREE.Vector3()
    if (!this.raycaster.ray.intersectPlane(plane, hit)) return null
    return [hit.x + this.L / 2, -hit.z + this.W / 2]
  }

  /**
   * 화면 가장자리의 UI(오른쪽 조작 패널, 위 점수판, 아래 표시줄)가 가리는 폭.
   * 테이블이 그 사이의 빈 영역 가운데에 오도록 카메라를 옮긴다.
   */
  setInsets(right: number, top: number, bottom: number): void {
    this.insets = { right, top, bottom }
    this.resize()
  }

  resize(): void {
    const w = this.canvas.clientWidth || 1
    const h = this.canvas.clientHeight || 1
    const { right, top, bottom } = this.insets
    this.renderer.setSize(w, h, false)
    // 원근 카메라: 더 큰 가상 화면의 일부만 그려서 중심을 빈 영역 가운데로 옮긴다
    this.persp.aspect = (w + right) / (h + top)
    this.persp.setViewOffset(w + right, h + top, right, 0, w, h)
    this.persp.updateProjectionMatrix()
    // 탑뷰: 레일까지 빈 영역 안에 들어오게 맞춘다
    const needW = this.L + 2 * (CUSHION_DEPTH + RAIL_WIDTH) + 0.08
    const needH = this.W + 2 * (CUSHION_DEPTH + RAIL_WIDTH) + 0.08
    const availW = Math.max(w - right, 50)
    const availH = Math.max(h - top - bottom, 50)
    const scale = Math.max(needW / availW, needH / availH)
    const cx = availW / 2
    const cy = top + availH / 2
    this.ortho.left = -cx * scale
    this.ortho.right = (w - cx) * scale
    this.ortho.top = cy * scale
    this.ortho.bottom = -(h - cy) * scale
    this.ortho.updateProjectionMatrix()
  }

  render(dt: number): void {
    if (this.attract) {
      // 메뉴 화면: 테이블 주위를 천천히 돈다
      this.attractAngle += dt * 0.1
      this.persp.position.set(Math.cos(this.attractAngle) * 3.0, 1.35, Math.sin(this.attractAngle) * 3.0)
      this.orbit.target.set(0, -0.05, 0)
      this.persp.lookAt(this.orbit.target)
      this.renderer.render(this.scene, this.persp)
      return
    }
    if (this.view === 'free') {
      this.orbit.update()
    } else if (this.view === 'aim') {
      const pos = this.overview ? new THREE.Vector3(0, 2.25, this.W / 2 + 1.45) : this.camPos
      const look = this.overview ? new THREE.Vector3(0, 0, 0.05) : this.camLook
      // 시점이 바뀔 때 부드럽게 따라간다
      const k = 1 - Math.exp(-dt * 9)
      this.persp.position.lerp(pos, k)
      this.orbit.target.lerp(look, k)
      this.persp.lookAt(this.orbit.target)
    }
    this.renderer.render(this.scene, this.camera)
  }
}
