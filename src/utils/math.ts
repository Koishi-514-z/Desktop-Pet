// 线性插值：返回 a 到 b 之间，按比例 t（0~1）插值后的结果
export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

// 返回 [min, max) 区间内的随机浮点数
export function randFloat(min: number, max: number): number {
  return min + Math.random() * (max - min)
}

// 返回 [min, max] 区间内的随机整数
export function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min
}

// 将一个值限制在 [min, max] 区间内
export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max))
}

// 有概率 p 返回 true
export function randBool(p: number): boolean {
  return Math.random() < p
}