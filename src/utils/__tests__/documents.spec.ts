import { IDBFactory } from 'fake-indexeddb'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// 每个用例使用全新的数据库，并重新加载模块（db.ts 会缓存打开的数据库）
async function load() {
  vi.stubGlobal('indexedDB', new IDBFactory())
  vi.resetModules()
  return import('@/utils/documents')
}

beforeEach(() => {
  vi.unstubAllGlobals()
})

describe('对话中的文档', () => {
  it('保存文档与提取结果，删除后读取不到', async () => {
    const documents = await load()
    const ref = await documents.addDocument(new File(['hello'], '合同.docx'))
    expect(ref).toMatchObject({ name: '合同.docx', size: 5 })
    expect(ref.id).toMatch(/^doc_\w{12}$/)

    // 模拟的 IndexedDB 克隆 jsdom 的 Blob 时会丢失它的方法，这里只检查记录的信息
    const stored = await documents.loadDocument(ref.id)
    expect(stored).toMatchObject({ id: ref.id, name: '合同.docx', size: 5 })
    expect(stored!.data).toBeDefined()
    expect(stored!.extracted).toBeUndefined()

    await documents.saveExtracted(ref.id, { content: '# 合同', format: 'docx', totalChars: 4 })
    expect((await documents.loadDocument(ref.id))!.extracted).toEqual({ content: '# 合同', format: 'docx', totalChars: 4 })

    await documents.deleteDocuments([ref.id])
    expect(await documents.loadDocument(ref.id)).toBeUndefined()
  })

  it('只接受 Office 与 PDF 文件；旧版格式提示另存为新格式', async () => {
    const documents = await load()
    await expect(documents.addDocument(new File(['x'], '旧版.doc'))).rejects.toThrow('另存为 .docx')
    await expect(documents.addDocument(new File(['x'], '图片.png'))).rejects.toThrow('不支持的文件类型')
    const big = new File(['x'], '大.pdf')
    Object.defineProperty(big, 'size', { value: documents.MAX_DOCUMENT_BYTES + 1 })
    await expect(documents.addDocument(big)).rejects.toThrow('文件太大')

    expect(documents.isDocumentFile({ name: '报告.DOCX' })).toBe(true)
    expect(documents.isDocumentFile({ name: '旧版.ppt' })).toBe(true)
    expect(documents.isDocumentFile({ name: '照片.jpg' })).toBe(false)
  })

  it('消息中的文件标记', async () => {
    const documents = await load()
    const marker = documents.documentMarkers([{ id: 'doc_1', name: '合同.docx', size: 2048 }, { id: 'doc_2', name: '数据.xlsx', size: 3 * 1024 * 1024 }])
    expect(marker).toBe('【附文件：doc_1｜合同.docx｜2.0 KB】\n【附文件：doc_2｜数据.xlsx｜3.0 MB】')
    expect(documents.parseDocumentIds(`看看\n\n${marker}`)).toEqual(['doc_1', 'doc_2'])
    expect(documents.findLatestDocumentIds([
      { role: 'user', content: '【附文件：doc_1｜a.pdf｜1 B】' },
      { role: 'assistant', content: '【附文件：doc_9｜不算.pdf｜1 B】' },
      { role: 'user', content: '再看看' },
    ])).toEqual(['doc_1'])
  })
})
