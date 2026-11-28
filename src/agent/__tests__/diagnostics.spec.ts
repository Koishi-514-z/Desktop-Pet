import type { ToolExecutionOptions } from 'ai'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/utils/diagnostics', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/utils/diagnostics')>(),
  getSystemSnapshot: vi.fn(async () => ({
    os: 'Windows 11', uptimeSeconds: 600, sampleSeconds: 1,
    cpu: { name: 'CPU', physicalCores: 4, logicalCores: 8, usage: 20, frequencyMhz: 3000 },
    memory: { total: 8 * 1024 ** 3, used: 4 * 1024 ** 3, available: 4 * 1024 ** 3, swapTotal: 0, swapUsed: 0 },
    gpus: [], disks: [], network: [], battery: null, processCount: 3,
    processes: [
      { name: 'chrome', count: 12, pids: [10, 11], cpu: 5, memory: 2 * 1024 ** 3, gpuMemory: 0, gpuSharedMemory: 0, gpuUsage: 0, diskReadPerSec: 0, diskWritePerSec: 0 },
      { name: 'chromedriver', count: 1, pids: [20], cpu: 0, memory: 50 * 1024 ** 2, gpuMemory: 0, gpuSharedMemory: 0, gpuUsage: 0, diskReadPerSec: 0, diskWritePerSec: 0 },
    ],
  })),
}))

import { diagnosticsSkill } from '@/agent/skills/diagnostics'

function run(name: keyof typeof diagnosticsSkill.tools, input: unknown) {
  const options = { toolCallId: 'call', messages: [], experimental_context: { model: {}, visionModel: {}, setStatus: vi.fn() } } as unknown as ToolExecutionOptions
  return diagnosticsSkill.tools[name]!.execute!(input as never, options) as Promise<Record<string, unknown>>
}

describe('系统诊断技能', () => {
  it('检查系统：返回摘要与异常', async () => {
    const result = await run('check_system', {})
    expect(result).toMatchObject({ issues: [], cpu: { usage: '20%', cores: '4 核 8 线程' }, battery: '没有电池（台式机）' })
  })

  it('按名称查找程序（不区分大小写），按内存从多到少；找不到时提示进程名可能不同', async () => {
    const result = await run('find_processes', { query: 'CHROME' })
    expect((result.processes as { name: string }[]).map((item) => item.name)).toEqual(['chrome', 'chromedriver'])
    expect(result.processes).toContainEqual(expect.objectContaining({ name: 'chrome', processes: 12, memory: '2.0 GB' }))
    expect((await run('find_processes', { query: '微信' })).message).toContain('进程名与软件名不同')
  })
})
