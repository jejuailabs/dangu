/**
 * 자동 대국 보정 도구 (PRD 05 §5).
 * 평소 테스트에서는 건너뛴다. 실행 예:
 *   CAL=4ball SKILLS=0,0.5,1 INNINGS=100 pnpm exec vitest run packages/ai/test/calibrate.test.ts
 *
 * skill 값마다 혼자 치는 이닝을 여러 번 돌려 이닝당 평균 득점(에버리지)을 잰다.
 * 이 표에서 수지별 목표 에버리지에 맞는 skill 을 찾아 levels.ts 에 넣는다.
 */
import { describe, it } from 'vitest'
import { measure } from '../src/measure'
import type { Discipline } from '../../rules/src'

const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {}

describe.skipIf(!env.CAL)('보정: skill 별 에버리지', () => {
  const d = (env.CAL ?? '4ball') as Discipline
  const innings = Number(env.INNINGS ?? 100)
  const skills = (env.SKILLS ?? '0,0.25,0.5,0.75,1').split(',').map(Number)
  for (const skill of skills) {
    it(
      `${d} skill ${skill}`,
      () => {
        const r = measure(d, skill, innings, env.CUE ?? 'gold')
        console.log(
          `CAL ${d} skill ${skill.toFixed(2)}  avg ${r.avg.toFixed(3)}  high ${r.high}  찾음 ${(r.foundRate * 100).toFixed(0)}%  샷 ${r.shots}  샷당 ${r.msPerShot.toFixed(0)}ms`,
        )
      },
      3_600_000,
    )
  }
})
