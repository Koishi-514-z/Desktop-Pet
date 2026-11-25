import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import * as Cubism4 from 'pixi-live2d-display/cubism4'
import { patchLive2dPhysics } from '@/utils/live2d-physics-patch'

// pixi-live2d-display/cubism4 导入时会检查 Cubism 运行时是否已加载；物理模拟用不到运行时，放一个空对象即可
vi.hoisted(() => {
  (globalThis as Record<string, unknown>).Live2DCubismCore = {}
})

interface Vector { x: number, y: number }
interface Physics {
  evaluate: (model: FakeModel, deltaTimeSeconds: number) => void
  _physicsRig: { particles: { position: Vector, velocity: Vector, lastGravity: Vector }[] }
}
interface FakeModel {
  getModel: () => { parameters: { values: Float32Array, minimumValues: Float32Array, maximumValues: Float32Array, defaultValues: Float32Array } }
  getParameterIndex: (id: string) => number
}
interface PhysicsJson {
  PhysicsSettings: { Input: { Source: { Id: string } }[], Output: { Destination: { Id: string } }[] }[]
}

const { CubismPhysics } = Cubism4 as unknown as { CubismPhysics: { create: (json: unknown) => Physics, prototype: Physics } }
const originalEvaluate = CubismPhysics.prototype.evaluate
patchLive2dPhysics()
const patchedEvaluate = CubismPhysics.prototype.evaluate

const MODELS_DIR = resolve(process.cwd(), 'public/assets/live2d/models')

function loadPhysics(folder: string): PhysicsJson {
  const settings = JSON.parse(readFileSync(resolve(MODELS_DIR, folder, 'model.model3.json'), 'utf-8'))
  return JSON.parse(readFileSync(resolve(MODELS_DIR, folder, settings.FileReferences.Physics), 'utf-8'))
}

/** 只包含物理用到的参数的假模型：输入参数范围 -30 ~ 30，输出参数 -1 ~ 1（会触发越界的处理） */
function fakeModel(json: PhysicsJson) {
  const inputIds = new Set(json.PhysicsSettings.flatMap((setting) => setting.Input.map((input) => input.Source.Id)))
  const ids = [...new Set([...inputIds, ...json.PhysicsSettings.flatMap((setting) => setting.Output.map((output) => output.Destination.Id))])]
  const values = new Float32Array(ids.length)
  const minimumValues = Float32Array.from(ids, (id) => (inputIds.has(id) ? -30 : -1))
  const maximumValues = Float32Array.from(ids, (id) => (inputIds.has(id) ? 30 : 1))
  const defaultValues = new Float32Array(ids.length)
  const model: FakeModel = {
    getModel: () => ({ parameters: { values, minimumValues, maximumValues, defaultValues } }),
    getParameterIndex: (id) => ids.indexOf(id),
  }
  // 模拟动画：每帧改动输入参数
  const drive = (frame: number) => ids.forEach((id, index) => {
    if (inputIds.has(id)) values[index] = 30 * Math.sin(frame / 7 + index)
  })
  const outputIndices = ids.flatMap((id, index) => (inputIds.has(id) ? [] : [index]))
  return { model, values, drive, outputIndices }
}

describe('物理模拟的优化补丁', () => {
  it.each(['Virescent Fawn Witch', 'Kuma_Maid', 'AyachiNene', 'ATRI'])('与库中原来的实现逐位一致：%s', (folder) => {
    const json = loadPhysics(folder)
    const original = CubismPhysics.create(json)
    const patched = CubismPhysics.create(json)
    const a = fakeModel(json)
    const b = fakeModel(json)
    // 帧间隔有长有短，也有 0（同一毫秒内更新两次）
    const steps = [1 / 60, 1 / 120, 1 / 30, 0, 1 / 144]

    const mismatches: string[] = []
    for (let frame = 0; frame < 600 && mismatches.length < 5; frame++) {
      a.drive(frame)
      b.drive(frame)
      const dt = steps[frame % steps.length]!
      originalEvaluate.call(original, a.model, dt)
      patchedEvaluate.call(patched, b.model, dt)
      for (let i = 0; i < a.values.length; i++) {
        if (!Object.is(a.values[i], b.values[i])) mismatches.push(`第 ${frame} 帧参数 ${i}：${a.values[i]} ≠ ${b.values[i]}`)
      }
    }
    expect(mismatches).toEqual([])
    // 确认比较的不是全 0 或 NaN：大部分输出参数都被物理驱动到了有效的非零值
    const moving = b.outputIndices.filter((index) => b.values[index] !== 0 && Number.isFinite(b.values[index]))
    expect(moving.length).toBeGreaterThan(b.outputIndices.length / 2)

    const state = (physics: Physics) => physics._physicsRig.particles.flatMap(({ position, velocity, lastGravity }) => [position.x, position.y, velocity.x, velocity.y, lastGravity.x, lastGravity.y])
    const expected = state(original)
    const actual = state(patched)
    expect(actual.every((value, index) => Object.is(value, expected[index]))).toBe(true)
  })

  it('计算过程中不再复制数组', () => {
    const json = loadPhysics('Virescent Fawn Witch')
    const physics = CubismPhysics.create(json)
    const { model, drive } = fakeModel(json)
    drive(0)
    // 第一次计算时切好各物理组的子数组
    physics.evaluate(model, 1 / 60)

    const arraySlice = vi.spyOn(Array.prototype, 'slice')
    const typedArraySlice = vi.spyOn(Float32Array.prototype, 'slice')
    for (let frame = 1; frame <= 10; frame++) {
      drive(frame)
      physics.evaluate(model, 1 / 60)
    }
    const patchedSlices = arraySlice.mock.calls.length + typedArraySlice.mock.calls.length
    originalEvaluate.call(physics, model, 1 / 60)
    const originalSlices = arraySlice.mock.calls.length + typedArraySlice.mock.calls.length - patchedSlices
    vi.restoreAllMocks()

    expect(patchedSlices).toBe(0)
    // 对照：原来的实现一帧就要复制几百次
    expect(originalSlices).toBeGreaterThan(300)
  })
})
