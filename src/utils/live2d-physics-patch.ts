/**
 * 减少 pixi-live2d-display(cubism4) 物理模拟每帧产生的垃圾对象
 *
 * 库内置的 Cubism 框架在 CubismPhysics.evaluate 中，每帧都会：为每个物理组复制一遍 inputs / outputs / particles
 * 数组；为每个物理输出复制参数数组的后半段（实际只改其中一个值）；计算每个粒子时新建十几个 CubismVector2。
 * 物理组多的模型（如 60 组、600 个粒子）每秒会产生几十 MB 的对象，其中挂在粒子上、活到下一帧的会被晋升到
 * 老生代，攒到几百 MB 后 V8 只能停下来做一次完整的垃圾回收，表现为每隔几十秒卡顿两三秒。
 *
 * 这里按库原本的计算步骤重写 evaluate（运算顺序完全相同，结果逐位一致，见测试），
 * 改为原地修改粒子的向量、复用切好的子数组，计算过程中不再新建对象。
 */
import * as Cubism4 from 'pixi-live2d-display/cubism4'

// 与库中的常量一致
const AIR_RESISTANCE = 5
const MAXIMUM_WEIGHT = 100
const MOVEMENT_THRESHOLD = 0.001

interface Vector { x: number, y: number }

// 与库中 CubismMath 的实现一致（库的类型声明没有导出它）
const CubismMath = {
  degreesToRadian: (degrees: number) => degrees / 180 * Math.PI,
  sin: Math.sin,
  cos: Math.cos,
  abs: Math.abs,
  directionToRadian(from: Vector, to: Vector) {
    const q1 = Math.atan2(to.y, to.x)
    const q2 = Math.atan2(from.y, from.x)
    let ret = q1 - q2
    while (ret < -Math.PI) ret += Math.PI * 2
    while (ret > Math.PI) ret -= Math.PI * 2
    return ret
  },
}

interface PhysicsParticle {
  position: Vector
  lastPosition: Vector
  lastGravity: Vector
  force: Vector
  velocity: Vector
  acceleration: number
  delay: number
  mobility: number
  radius: number
}

interface PhysicsInput {
  weight: number
  reflect: boolean
  source: { id: string }
  sourceParameterIndex: number
  getNormalizedParameterValue: (
    targetTranslation: Vector, targetAngle: { angle: number }, value: number, minimum: number, maximum: number, defaultValue: number,
    normalizationPosition: unknown, normalizationAngle: unknown, isInverted: boolean, weight: number,
  ) => void
}

interface PhysicsOutput {
  vertexIndex: number
  reflect: boolean
  weight: number
  translationScale: number
  angleScale: number
  valueBelowMinimum: number
  valueExceededMaximum: number
  destination: { id: string }
  destinationParameterIndex: number
  getValue: (translation: Vector, particles: PhysicsParticle[], particleIndex: number, isInverted: boolean, parentGravity: Vector) => number
  getScale: (translationScale: number, angleScale: number) => number
}

interface PhysicsSubRig {
  baseInputIndex: number
  baseOutputIndex: number
  baseParticleIndex: number
  inputCount: number
  outputCount: number
  particleCount: number
  normalizationPosition: { maximum: number }
  normalizationAngle: unknown
}

interface PhysicsRig {
  subRigCount: number
  settings: PhysicsSubRig[]
  inputs: PhysicsInput[]
  outputs: PhysicsOutput[]
  particles: PhysicsParticle[]
}

interface PhysicsInstance {
  _physicsRig: PhysicsRig
  _options: { wind: Vector, gravity: Vector }
}

interface PhysicsModel {
  getModel(): { parameters: { values: Float32Array, minimumValues: Float32Array, maximumValues: Float32Array, defaultValues: Float32Array } }
  getParameterIndex(id: string): number
}

// 每个物理组的子数组只切一次（加载后不会再变），每帧复用
interface SubArrays { inputs: PhysicsInput[][], outputs: PhysicsOutput[][], particles: PhysicsParticle[][] }
const subArrayCache = new WeakMap<PhysicsRig, SubArrays>()

function subArrays(rig: PhysicsRig): SubArrays {
  let cached = subArrayCache.get(rig)
  if (!cached) {
    cached = { inputs: [], outputs: [], particles: [] }
    for (const setting of rig.settings.slice(0, rig.subRigCount)) {
      cached.inputs.push(rig.inputs.slice(setting.baseInputIndex, setting.baseInputIndex + setting.inputCount))
      cached.outputs.push(rig.outputs.slice(setting.baseOutputIndex, setting.baseOutputIndex + setting.outputCount))
      cached.particles.push(rig.particles.slice(setting.baseParticleIndex, setting.baseParticleIndex + setting.particleCount))
    }
    subArrayCache.set(rig, cached)
  }
  return cached
}

// 计算过程中复用的临时对象（evaluate 不会重入）
const totalTranslation: Vector = { x: 0, y: 0 }
const totalAngle = { angle: 0 }
const translation: Vector = { x: 0, y: 0 }
const gravity: Vector = { x: 0, y: 0 }

/** 对应库中的 updateParticles：计算步骤与运算顺序完全相同，只是原地修改向量 */
function updateParticles(
  strand: PhysicsParticle[], strandCount: number, translationOfRoot: Vector, angle: number,
  wind: Vector, thresholdValue: number, deltaTimeSeconds: number, airResistance: number,
) {
  strand[0]!.position.x = translationOfRoot.x
  strand[0]!.position.y = translationOfRoot.y

  // CubismMath.radianToDirection 之后 normalize()
  const totalRadian = CubismMath.degreesToRadian(angle)
  let gravityX = CubismMath.sin(totalRadian)
  let gravityY = CubismMath.cos(totalRadian)
  const gravityLength = Math.pow(gravityX * gravityX + gravityY * gravityY, 0.5)
  gravityX = gravityX / gravityLength
  gravityY = gravityY / gravityLength
  gravity.x = gravityX
  gravity.y = gravityY

  for (let i = 1; i < strandCount; ++i) {
    const particle = strand[i]!
    const previous = strand[i - 1]!.position
    const { position, lastPosition, force, velocity } = particle

    force.x = gravityX * particle.acceleration + wind.x
    force.y = gravityY * particle.acceleration + wind.y
    lastPosition.x = position.x
    lastPosition.y = position.y
    const delay = particle.delay * deltaTimeSeconds * 30

    let directionX = position.x - previous.x
    let directionY = position.y - previous.y
    const radian = CubismMath.directionToRadian(particle.lastGravity, gravity) / airResistance
    // 与库中相同：算 y 时用的是已经旋转过的 x
    directionX = CubismMath.cos(radian) * directionX - directionY * CubismMath.sin(radian)
    directionY = CubismMath.sin(radian) * directionX + directionY * CubismMath.cos(radian)

    let x = previous.x + directionX
    let y = previous.y + directionY
    x = x + velocity.x * delay + force.x * delay * delay
    y = y + velocity.y * delay + force.y * delay * delay

    let newDirectionX = x - previous.x
    let newDirectionY = y - previous.y
    const newDirectionLength = Math.pow(newDirectionX * newDirectionX + newDirectionY * newDirectionY, 0.5)
    newDirectionX = newDirectionX / newDirectionLength
    newDirectionY = newDirectionY / newDirectionLength
    x = previous.x + newDirectionX * particle.radius
    y = previous.y + newDirectionY * particle.radius
    if (CubismMath.abs(x) < thresholdValue) x = 0
    position.x = x
    position.y = y

    if (delay != 0) {
      velocity.x = (x - lastPosition.x) / delay * particle.mobility
      velocity.y = (y - lastPosition.y) / delay * particle.mobility
    }
    force.x = 0
    force.y = 0
    particle.lastGravity.x = gravityX
    particle.lastGravity.y = gravityY
  }
}

/** 对应库中的 updateOutputParameterValue：返回新的参数值 */
function outputParameterValue(current: number, minimum: number, maximum: number, value: number, output: PhysicsOutput): number {
  value = value * output.getScale(output.translationScale, output.angleScale)
  if (value < minimum) {
    if (value < output.valueBelowMinimum) output.valueBelowMinimum = value
    value = minimum
  }
  else if (value > maximum) {
    if (value > output.valueExceededMaximum) output.valueExceededMaximum = value
    value = maximum
  }
  const weight = output.weight / MAXIMUM_WEIGHT
  return weight >= 1 ? value : current * (1 - weight) + value * weight
}

/** 对应库中的 CubismPhysics.evaluate */
function evaluate(this: PhysicsInstance, model: PhysicsModel, deltaTimeSeconds: number) {
  const rig = this._physicsRig
  const { values, minimumValues, maximumValues, defaultValues } = model.getModel().parameters
  const { inputs, outputs, particles } = subArrays(rig)

  for (let settingIndex = 0; settingIndex < rig.subRigCount; ++settingIndex) {
    const setting = rig.settings[settingIndex]!
    const currentInputs = inputs[settingIndex]!
    const currentOutputs = outputs[settingIndex]!
    const currentParticles = particles[settingIndex]!
    totalAngle.angle = 0
    totalTranslation.x = 0
    totalTranslation.y = 0

    for (let i = 0; i < setting.inputCount; ++i) {
      const input = currentInputs[i]!
      const weight = input.weight / MAXIMUM_WEIGHT
      if (input.sourceParameterIndex == -1) input.sourceParameterIndex = model.getParameterIndex(input.source.id)
      const source = input.sourceParameterIndex
      input.getNormalizedParameterValue(
        totalTranslation, totalAngle, values[source]!, minimumValues[source]!, maximumValues[source]!, defaultValues[source]!,
        setting.normalizationPosition, setting.normalizationAngle, input.reflect, weight,
      )
    }

    // 与库中相同：算 y 时用的是已经旋转过的 x
    const radAngle = CubismMath.degreesToRadian(-totalAngle.angle)
    totalTranslation.x = totalTranslation.x * CubismMath.cos(radAngle) - totalTranslation.y * CubismMath.sin(radAngle)
    totalTranslation.y = totalTranslation.x * CubismMath.sin(radAngle) + totalTranslation.y * CubismMath.cos(radAngle)

    updateParticles(
      currentParticles, setting.particleCount, totalTranslation, totalAngle.angle, this._options.wind,
      MOVEMENT_THRESHOLD * setting.normalizationPosition.maximum, deltaTimeSeconds, AIR_RESISTANCE,
    )

    for (let i = 0; i < setting.outputCount; ++i) {
      const output = currentOutputs[i]!
      const particleIndex = output.vertexIndex
      if (particleIndex < 1 || particleIndex >= setting.particleCount) break
      if (output.destinationParameterIndex == -1) output.destinationParameterIndex = model.getParameterIndex(output.destination.id)
      translation.x = currentParticles[particleIndex]!.position.x - currentParticles[particleIndex - 1]!.position.x
      translation.y = currentParticles[particleIndex]!.position.y - currentParticles[particleIndex - 1]!.position.y
      const outputValue = output.getValue(translation, currentParticles, particleIndex, output.reflect, this._options.gravity)
      const destination = output.destinationParameterIndex
      // 参数不存在时下标超出数组范围，读到 undefined、写入被忽略，与库中的行为一致
      values[destination] = outputParameterValue(values[destination]!, minimumValues[destination]!, maximumValues[destination]!, outputValue, output)
    }
  }
}

let patched = false

export function patchLive2dPhysics() {
  if (patched) return
  patched = true

  // 库的类型声明没有导出 CubismPhysics，运行时是导出了的
  const CubismPhysics = (Cubism4 as unknown as Record<string, { prototype: { evaluate: unknown } } | undefined>).CubismPhysics
  if (!CubismPhysics) {
    console.warn('未找到 CubismPhysics，跳过物理模拟的优化补丁')
    return
  }
  CubismPhysics.prototype.evaluate = evaluate
}
