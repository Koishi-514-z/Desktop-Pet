// 根据字符串生成稳定的色相，用于头像等装饰色
export function hashHue(text: string): number {
  let hash = 0
  for (let i = 0; i < text.length; i++) hash = (hash * 31 + text.charCodeAt(i)) | 0
  return Math.abs(hash) % 360
}

// 取名称的首个字符作为头像文字
export function getInitial(name: string): string {
  return (name.trim()[0] ?? '?').toUpperCase()
}
