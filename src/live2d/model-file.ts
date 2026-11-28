import type { Live2dExpression, Live2dHitArea, Live2dMotion } from '@/stores/live2d'

/**
 * 直接读取模型文件（Cubism 4 的 model3.json）中的表情、动作与碰撞区域。
 *
 * 模型显示到桌面上时，渲染组件会从加载好的模型中读取这些信息（见 Live2dModel.vue 的 syncModelMeta）；
 * 还没有显示过的模型（如刚导入的）在设置中查看、打标签时，用这里的结果。两者读取的是 model3.json 中的同一份数据
 */

export interface ModelResources {
  expressions: Live2dExpression[]
  motions: Live2dMotion[]
  hitAreas: Live2dHitArea[]
}

interface ModelJson {
  FileReferences?: {
    Expressions?: { Name?: string, File?: string, Tags?: string[] }[]
    Motions?: Record<string, { File?: string, Tags?: string[] }[] | undefined>
  }
  HitAreas?: { Id?: string, Name?: string, Motion?: string }[]
}

function stringTags(tags: unknown): string[] | undefined {
  return Array.isArray(tags) ? tags.filter((tag): tag is string => typeof tag === 'string') : undefined
}

export function parseModelResources(json: unknown): ModelResources {
  const data = (json && typeof json === 'object' ? json : {}) as ModelJson
  const references = data.FileReferences ?? {}

  const expressions = (references.Expressions ?? [])
    .filter((def) => typeof def?.Name === 'string')
    .map((def) => ({ name: def.Name!, fileName: def.File ?? '', tags: stringTags(def.Tags) }))

  const motions = Object.entries(references.Motions ?? {}).flatMap(([group, defs]) =>
    (Array.isArray(defs) ? defs : []).map((def, index) => ({ group, index, fileName: def?.File ?? '', tags: stringTags(def?.Tags) })),
  )

  const hitAreas = (data.HitAreas ?? [])
    .filter((area) => typeof area?.Name === 'string')
    .map((area) => ({ name: area.Name!, id: area.Id ?? area.Name!, motion: area.Motion }))

  return { expressions, motions, hitAreas }
}

export async function readModelResources(url: string): Promise<ModelResources> {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`读取模型文件失败（HTTP ${response.status}）`)
  return parseModelResources(await response.json())
}
