import type { InternalModel } from 'pixi-live2d-display/cubism4'

import { randomSaccadeInterval } from '@/utils/eye-motions'
import { lerp, randFloat, clamp } from '@/utils/math'
import { useLive2dStore } from '@/stores/live2d'


// Live2D 模型的眼球扫视与跟随
export function useLive2DEyeFocus() {
  const live2dStore = useLive2dStore()

  // 下一次触发扫视的时间点（毫秒）
  let nextSaccadeAfter = -1
  // 当前眼球注视的目标坐标 [x, y]，范围约为 [-1, 1]
  let focusTarget: [number, number] = [0, 0]
  // 上一次扫视发生的时间点（毫秒）
  let lastSaccadeAt = -1

  // 当前缓动后的视线焦点坐标，逐帧向 focusTarget 靠近后写入 focusController
  let currentFocus: [number, number] = [0, 0]

  function idleUpdate(model: InternalModel, now: number) {
    // 到达下次扫视时间，或时间发生回退（如重新开始计时）时，重新生成扫视目标
    if (now >= nextSaccadeAfter || now < lastSaccadeAt) {
      focusTarget = [randFloat(-1, 1), randFloat(-1, 1)]
      lastSaccadeAt = now
      nextSaccadeAfter = now + (randomSaccadeInterval())
    }

    // 视线焦点自行缓动后，以 instant 模式写入 focusController，
    // 避免其自带的缓动（速度过快）与此处叠加
    currentFocus = [
      lerp(currentFocus[0], focusTarget[0], live2dStore.focusLerpFactorIdle),
      lerp(currentFocus[1], focusTarget[1], live2dStore.focusLerpFactorIdle),
    ]
    model.focusController.focus(currentFocus[0], currentFocus[1], true)

    // 每帧将眼球参数缓动到当前的扫视目标
    const coreModel = model.coreModel as any
    coreModel.setParameterValueById('ParamEyeBallX', currentFocus[0])
    coreModel.setParameterValueById('ParamEyeBallY', currentFocus[1])
  }

  // 鼠标移动时，缓动跟随鼠标对应的目标坐标 [x, y]
  function mouseMoveUpdate(model: InternalModel, target: [number, number]) {
    // 同步更新扫视状态，避免空闲扫视与鼠标跟随之间出现跳
    focusTarget = target
    lastSaccadeAt = -1
    nextSaccadeAfter = -1

    // 视线焦点自行缓动后，以 instant 模式写入 focusController，原因同 idleUpdate
    currentFocus = [
      lerp(currentFocus[0], target[0], live2dStore.focusLerpFactorMouse),
      lerp(currentFocus[1], target[1], live2dStore.focusLerpFactorMouse),
    ]
    model.focusController.focus(currentFocus[0], currentFocus[1], true)

    // 每帧将眼球参数缓动到鼠标对应的目标
    const coreModel = model.coreModel as any
    coreModel.setParameterValueById('ParamEyeBallX', currentFocus[0])
    coreModel.setParameterValueById('ParamEyeBallY', currentFocus[1])
  }

  // 重置眼球扫视状态，停止扫视并重置焦点
  function resetFocus(model: InternalModel) {
    const coreModel = model.coreModel as any
    lastSaccadeAt = -1
    nextSaccadeAfter = -1
    focusTarget = [0, 0]
    currentFocus = [0, 0]
    model.focusController.focus(0, 0)
    coreModel.setParameterValueById('ParamEyeBallX', 0)
    coreModel.setParameterValueById('ParamEyeBallY', 0)
  }

  return { 
    idleUpdate, 
    mouseMoveUpdate, 
    resetFocus 
  }
}
