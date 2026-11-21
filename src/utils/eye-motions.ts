// 每个间隔档位的基础时长增量（毫秒），实际间隔会在 [基准值, 基准值 + STEP) 之间随机
const EYE_SACCADE_INT_STEP = 800

// 眼球扫视间隔的概率分布表：[该档位的相对概率, 间隔基准时间(ms)]
// 下方循环会将第一列转换为累积概率，将第二列转换为递增的基准时间
const EYE_SACCADE_INT_P: [number, number][] = [
  [0.075, 1600],
  [0.110, 0],
  [0.125, 0],
  [0.140, 0],
  [0.125, 0],
  [0.050, 0],
  [0.040, 0],
  [0.030, 0],
  [0.020, 0],
  [1.000, 0],
]
for (let i = 1; i < EYE_SACCADE_INT_P.length; i++) {
  const prev = EYE_SACCADE_INT_P[i - 1]!
  const curr = EYE_SACCADE_INT_P[i]!
  curr[0] += prev[0]
  curr[1] = prev[1] + EYE_SACCADE_INT_STEP
}

// 根据概率分布表随机生成下一次眼球扫视的间隔时间（毫秒）
export function randomSaccadeInterval(): number {
  const r = Math.random()
  for (let i = 0; i < EYE_SACCADE_INT_P.length; i++) {
    const [cumulativeP, baseInterval] = EYE_SACCADE_INT_P[i]!
    if (r <= cumulativeP) {
      return baseInterval + Math.random() * EYE_SACCADE_INT_STEP
    }
  }
  const last = EYE_SACCADE_INT_P[EYE_SACCADE_INT_P.length - 1]!
  return last[1] + Math.random() * EYE_SACCADE_INT_STEP
}
