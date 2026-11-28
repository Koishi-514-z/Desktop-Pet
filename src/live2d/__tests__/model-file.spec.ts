import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseModelResources } from '@/live2d/model-file'

describe('读取模型文件中的资源', () => {
  it('表情、动作（按组编号）与碰撞区域，连同模型文件中的标签', () => {
    const resources = parseModelResources({
      FileReferences: {
        Expressions: [{ Name: 'smile', File: 'smile.exp3.json', Tags: ['happy', 1] }, { File: 'no-name.exp3.json' }],
        Motions: { Idle: [{ File: 'idle.motion3.json' }], TapBody: [{ File: 'a.motion3.json' }, { File: 'b.motion3.json', Tags: ['excited'] }] },
      },
      HitAreas: [{ Id: 'HitAreaHead', Name: 'Head', Motion: 'TapHead' }],
    })
    expect(resources.expressions).toEqual([{ name: 'smile', fileName: 'smile.exp3.json', tags: ['happy'] }])
    expect(resources.motions).toEqual([
      { group: 'Idle', index: 0, fileName: 'idle.motion3.json', tags: undefined },
      { group: 'TapBody', index: 0, fileName: 'a.motion3.json', tags: undefined },
      { group: 'TapBody', index: 1, fileName: 'b.motion3.json', tags: ['excited'] },
    ])
    expect(resources.hitAreas).toEqual([{ name: 'Head', id: 'HitAreaHead', motion: 'TapHead' }])
  })

  it('格式不对的内容按空列表处理', () => {
    expect(parseModelResources(null)).toEqual({ expressions: [], motions: [], hitAreas: [] })
    expect(parseModelResources({ FileReferences: { Motions: { Idle: 'oops' } } }).motions).toEqual([])
  })

  it('能读取预置模型 ATRI 的文件', () => {
    const json = JSON.parse(readFileSync(resolve(process.cwd(), 'public/assets/live2d/models/ATRI/model.model3.json'), 'utf-8'))
    const { expressions, motions } = parseModelResources(json)
    expect(expressions.length).toBeGreaterThan(0)
    // 标签是可选的，有的话是字符串数组（具体有哪些标签随模型文件而变）
    expect([...expressions, ...motions].every((item) => item.tags === undefined || item.tags.every((tag) => typeof tag === 'string'))).toBe(true)
    expect(motions.length).toBeGreaterThan(0)
  })
})
