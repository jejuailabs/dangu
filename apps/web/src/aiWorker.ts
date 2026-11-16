/**
 * 컴퓨터 상대의 계산을 화면과 따로 돌린다 (PRD 05 §3). 계산 중에도 화면이 멈추지 않는다.
 */
import { type AiContext, chooseShot } from '../../../packages/ai/src'

self.onmessage = (e: MessageEvent<{ id: number; ctx: AiContext }>) => {
  const decision = chooseShot(e.data.ctx)
  ;(self as unknown as Worker).postMessage({ id: e.data.id, decision })
}
