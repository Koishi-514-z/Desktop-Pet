import type { ProcessGroup, SystemSnapshot } from '@/utils/diagnostics'
import { describe, expect, it } from 'vitest'
import { findIssues, formatBytes, summarizeSnapshot, topProcesses } from '@/utils/diagnostics'

const GB = 1024 ** 3
const MB = 1024 ** 2

const group = (name: string, extra: Partial<ProcessGroup> = {}): ProcessGroup => ({
  name, count: 1, pids: [1], cpu: 0, memory: 100 * MB, gpuMemory: 0, gpuSharedMemory: 0, gpuUsage: 0, diskReadPerSec: 0, diskWritePerSec: 0, ...extra,
})

function snapshot(extra: Partial<SystemSnapshot> = {}): SystemSnapshot {
  return {
    os: 'Windows 11',
    uptimeSeconds: 3600,
    sampleSeconds: 1.02,
    cpu: { name: 'Intel Core', physicalCores: 8, logicalCores: 16, usage: 12, frequencyMhz: 2700 },
    memory: { total: 32 * GB, used: 12 * GB, available: 20 * GB, swapTotal: 8 * GB, swapUsed: 0 },
    gpus: [{ name: 'RTX', dedicatedTotal: 16 * GB, dedicatedUsed: 3 * GB, sharedUsed: 300 * MB, usage: 5 }],
    disks: [{ mount: 'C:', total: 1000 * GB, available: 400 * GB }],
    network: [],
    battery: null,
    processCount: 300,
    processes: [group('chrome', { count: 30, cpu: 8, memory: 3 * GB, gpuMemory: 400 * MB }), group('wallpaper64', { gpuMemory: 1.3 * GB, gpuUsage: 2 }), group('idle')],
    ...extra,
  }
}

describe('系统诊断', () => {
  it('一切正常时没有异常；各项指标列出占用最多的程序，占用为 0 的不列出', () => {
    const summary = summarizeSnapshot(snapshot())
    expect(summary.issues).toEqual([])
    expect(summary.memory.used).toBe('12.0 GB / 32.0 GB（37.5%）')
    expect(summary.gpus[0]).toMatchObject({ usage: '5%', vram: '3.0 GB / 16.0 GB' })
    expect(summary.battery).toBe('没有电池（台式机）')
    expect(summary.topProcesses.gpuMemory.map((item) => item.name)).toEqual(['wallpaper64', 'chrome'])
    expect(summary.topProcesses.cpu).toEqual([{ name: 'chrome', processes: 30, pids: [1], cpu: '8%', memory: '3.0 GB', gpuMemory: '400 MB' }])
    expect(summary.topProcesses.disk).toEqual([])
  })

  it('按阈值标出明显的异常：CPU、单个程序、内存与虚拟内存、显卡、磁盘、电池、很久没重启', () => {
    const issues = findIssues(snapshot({
      uptimeSeconds: 20 * 86400,
      cpu: { name: 'Intel', physicalCores: 8, logicalCores: 16, usage: 97, frequencyMhz: 2700 },
      memory: { total: 16 * GB, used: 15.5 * GB, available: 0.5 * GB, swapTotal: 8 * GB, swapUsed: 6 * GB },
      gpus: [{ name: 'RTX', dedicatedTotal: 8 * GB, dedicatedUsed: 7.8 * GB, sharedUsed: 0, usage: 99 }],
      disks: [{ mount: 'C:', total: 500 * GB, available: 5 * GB }, { mount: 'D:', total: 1000 * GB, available: 600 * GB }],
      battery: { percent: 12, pluggedIn: false, charging: false, remainingSeconds: 1800, saver: true },
      processes: [group('MsMpEng', { cpu: 60, diskReadPerSec: 120 * MB })],
    }))
    expect(issues).toEqual([
      'CPU 占用很高（97%）',
      '「MsMpEng」占用了 60% 的 CPU',
      '「MsMpEng」在大量读写磁盘（读 120 MB/s，写 0 KB/s）',
      '内存快用完了（已用 96.9%，只剩 512 MB）',
      '虚拟内存用了 6.0 GB，内存不够时会频繁读写磁盘，明显变卡',
      '显卡「RTX」占用很高（99%）',
      '显卡「RTX」的显存快用完了（7.8 GB / 8.0 GB）',
      '磁盘 C: 空间不足（只剩 5.0 GB）',
      '开着省电模式，性能会被限制',
      '电量低（12%）且没有插电，系统可能降低了性能',
      '已经 20 天 0 小时没有重启',
    ])
  })

  it('集成显卡的独立显存很小，不按显存快用完报告；显存用量未知时如实说明', () => {
    const issues = findIssues(snapshot({ gpus: [{ name: 'Intel Graphics', dedicatedTotal: 128 * MB, dedicatedUsed: 128 * MB, sharedUsed: 0, usage: 0 }] }))
    expect(issues).toEqual([])
    const summary = summarizeSnapshot(snapshot({ gpus: [{ name: 'GPU', dedicatedTotal: 4 * GB, dedicatedUsed: null, sharedUsed: null, usage: null }] }))
    expect(summary.gpus[0]).toEqual({ name: 'GPU', usage: '未知', vram: '共 4.0 GB，用量未知' })
  })

  it('格式化与排序', () => {
    expect(formatBytes(1.5 * GB)).toBe('1.5 GB')
    expect(formatBytes(300 * MB)).toBe('300 MB')
    expect(topProcesses([group('a', { cpu: 1 }), group('b', { cpu: 5 }), group('c')], 'cpu').map((item) => item.name)).toEqual(['b', 'a'])
  })
})
