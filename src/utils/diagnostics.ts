import { invoke } from '@tauri-apps/api/core'
import { isTauri } from '@/composables/desktop'

/**
 * 系统诊断（Rust 端见 src-tauri/src/diagnostics.rs）：读取系统状态，并整理成交给模型分析的简明摘要——
 * 换算单位、每项指标挑出占用最多的几个程序、按阈值标出明显的异常，模型据此推断原因。
 */

export interface ProcessGroup {
  name: string
  /** 同名进程的数量 */
  count: number
  pids: number[]
  /** 占整机 CPU 的百分比 */
  cpu: number
  memory: number
  gpuMemory: number
  gpuSharedMemory: number
  gpuUsage: number
  diskReadPerSec: number
  diskWritePerSec: number
}

export interface SystemSnapshot {
  os: string
  uptimeSeconds: number
  sampleSeconds: number
  cpu: { name: string, physicalCores: number | null, logicalCores: number, usage: number, frequencyMhz: number }
  memory: { total: number, used: number, available: number, swapTotal: number, swapUsed: number }
  gpus: { name: string, dedicatedTotal: number, dedicatedUsed: number | null, sharedUsed: number | null, usage: number | null }[]
  disks: { mount: string, total: number, available: number }[]
  network: { name: string, receivedPerSec: number, sentPerSec: number }[]
  battery: { percent: number | null, pluggedIn: boolean, charging: boolean, remainingSeconds: number | null, saver: boolean } | null
  processCount: number
  processes: ProcessGroup[]
}

export async function getSystemSnapshot(): Promise<SystemSnapshot> {
  if (!isTauri) throw new Error('系统诊断需要在桌面应用中使用')
  return invoke('diagnostics_snapshot')
}

// ===== 格式化 =====

const GB = 1024 ** 3
const MB = 1024 ** 2

export function formatBytes(bytes: number): string {
  if (bytes >= GB) return `${(bytes / GB).toFixed(1)} GB`
  if (bytes >= MB) return `${Math.round(bytes / MB)} MB`
  return `${Math.round(bytes / 1024)} KB`
}

export function formatRate(bytesPerSec: number): string {
  return `${formatBytes(bytesPerSec)}/s`
}

const percent = (value: number) => `${Math.round(value * 10) / 10}%`
const ratio = (used: number, total: number) => (total > 0 ? used / total * 100 : 0)

function formatDuration(seconds: number): string {
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  if (hours >= 24) return `${Math.floor(hours / 24)} 天 ${hours % 24} 小时`
  return hours ? `${hours} 小时 ${minutes} 分钟` : `${minutes} 分钟`
}

// ===== 异常判断 =====

/** 明显异常的阈值：超过时在摘要中标出，模型据此重点分析 */
export const THRESHOLDS = {
  cpu: 85,
  /** 单个程序占整机 CPU */
  processCpu: 50,
  memory: 90,
  /** 虚拟内存（页面文件）已用 */
  swap: 50,
  gpu: 90,
  vram: 90,
  /** 磁盘剩余空间低于总容量的百分比，或低于多少字节 */
  diskFreePercent: 10,
  diskFreeBytes: 10 * GB,
  /** 单个程序的磁盘读写 */
  processDisk: 50 * MB,
  batteryLow: 20,
  /** 开机超过多少天 */
  uptimeDays: 14,
}

/** 按阈值找出明显的异常，每条一句话 */
export function findIssues(snapshot: SystemSnapshot): string[] {
  const issues: string[] = []
  const { cpu, memory, gpus, disks, battery, processes } = snapshot

  if (cpu.usage >= THRESHOLDS.cpu) issues.push(`CPU 占用很高（${percent(cpu.usage)}）`)
  for (const group of processes) {
    if (group.cpu >= THRESHOLDS.processCpu) issues.push(`「${group.name}」占用了 ${percent(group.cpu)} 的 CPU`)
    if (group.diskReadPerSec + group.diskWritePerSec >= THRESHOLDS.processDisk) {
      issues.push(`「${group.name}」在大量读写磁盘（读 ${formatRate(group.diskReadPerSec)}，写 ${formatRate(group.diskWritePerSec)}）`)
    }
  }

  const memoryUsage = ratio(memory.used, memory.total)
  if (memoryUsage >= THRESHOLDS.memory) issues.push(`内存快用完了（已用 ${percent(memoryUsage)}，只剩 ${formatBytes(memory.available)}）`)
  if (memory.swapTotal > 0 && ratio(memory.swapUsed, memory.swapTotal) >= THRESHOLDS.swap) {
    issues.push(`虚拟内存用了 ${formatBytes(memory.swapUsed)}，内存不够时会频繁读写磁盘，明显变卡`)
  }

  for (const gpu of gpus) {
    if ((gpu.usage ?? 0) >= THRESHOLDS.gpu) issues.push(`显卡「${gpu.name}」占用很高（${percent(gpu.usage!)}）`)
    if (gpu.dedicatedTotal >= GB && gpu.dedicatedUsed !== null && ratio(gpu.dedicatedUsed, gpu.dedicatedTotal) >= THRESHOLDS.vram) {
      issues.push(`显卡「${gpu.name}」的显存快用完了（${formatBytes(gpu.dedicatedUsed)} / ${formatBytes(gpu.dedicatedTotal)}）`)
    }
  }

  for (const disk of disks) {
    if (disk.total > 0 && (ratio(disk.available, disk.total) < THRESHOLDS.diskFreePercent || disk.available < THRESHOLDS.diskFreeBytes)) {
      issues.push(`磁盘 ${disk.mount} 空间不足（只剩 ${formatBytes(disk.available)}）`)
    }
  }

  if (battery) {
    if (battery.saver) issues.push('开着省电模式，性能会被限制')
    if (!battery.pluggedIn && battery.percent !== null && battery.percent < THRESHOLDS.batteryLow) {
      issues.push(`电量低（${battery.percent}%）且没有插电，系统可能降低了性能`)
    }
  }

  if (snapshot.uptimeSeconds >= THRESHOLDS.uptimeDays * 86400) issues.push(`已经 ${formatDuration(snapshot.uptimeSeconds)}没有重启`)
  return issues
}

// ===== 摘要 =====

type Metric = 'cpu' | 'memory' | 'gpuMemory' | 'gpuUsage' | 'disk'

const METRIC_VALUE: Record<Metric, (group: ProcessGroup) => number> = {
  cpu: (group) => group.cpu,
  memory: (group) => group.memory,
  gpuMemory: (group) => group.gpuMemory,
  gpuUsage: (group) => group.gpuUsage,
  disk: (group) => group.diskReadPerSec + group.diskWritePerSec,
}

/** 一个程序的状态：只写出有意义的项 */
export function describeProcess(group: ProcessGroup) {
  return {
    name: group.name,
    ...(group.count > 1 ? { processes: group.count } : {}),
    pids: group.pids,
    cpu: percent(group.cpu),
    memory: formatBytes(group.memory),
    ...(group.gpuMemory > 0 ? { gpuMemory: formatBytes(group.gpuMemory) } : {}),
    ...(group.gpuUsage > 0 ? { gpuUsage: percent(group.gpuUsage) } : {}),
    ...(group.diskReadPerSec + group.diskWritePerSec > 0
      ? { disk: `读 ${formatRate(group.diskReadPerSec)}，写 ${formatRate(group.diskWritePerSec)}` }
      : {}),
  }
}

/** 某项指标占用最多的几个程序（占用为 0 的不列出） */
export function topProcesses(processes: ProcessGroup[], metric: Metric, limit = 8) {
  const value = METRIC_VALUE[metric]
  return processes
    .filter((group) => value(group) > 0)
    .sort((a, b) => value(b) - value(a))
    .slice(0, limit)
    .map(describeProcess)
}

/** 交给模型分析的摘要 */
export function summarizeSnapshot(snapshot: SystemSnapshot) {
  const { cpu, memory, gpus, disks, network, battery, processes } = snapshot
  return {
    issues: findIssues(snapshot),
    system: {
      os: snapshot.os,
      uptime: formatDuration(snapshot.uptimeSeconds),
      processCount: snapshot.processCount,
      sampleSeconds: Math.round(snapshot.sampleSeconds * 10) / 10,
    },
    cpu: {
      name: cpu.name,
      cores: cpu.physicalCores ? `${cpu.physicalCores} 核 ${cpu.logicalCores} 线程` : `${cpu.logicalCores} 线程`,
      usage: percent(cpu.usage),
      frequency: `${(cpu.frequencyMhz / 1000).toFixed(1)} GHz`,
    },
    memory: {
      used: `${formatBytes(memory.used)} / ${formatBytes(memory.total)}（${percent(ratio(memory.used, memory.total))}）`,
      available: formatBytes(memory.available),
      swap: memory.swapTotal ? `${formatBytes(memory.swapUsed)} / ${formatBytes(memory.swapTotal)}` : '无',
    },
    gpus: gpus.map((gpu) => ({
      name: gpu.name,
      usage: gpu.usage === null ? '未知' : percent(gpu.usage),
      vram: gpu.dedicatedUsed === null
        ? `共 ${formatBytes(gpu.dedicatedTotal)}，用量未知`
        : `${formatBytes(gpu.dedicatedUsed)} / ${formatBytes(gpu.dedicatedTotal)}`,
      ...(gpu.sharedUsed ? { sharedMemory: formatBytes(gpu.sharedUsed) } : {}),
    })),
    disks: disks.map((disk) => ({ mount: disk.mount, free: `${formatBytes(disk.available)} / ${formatBytes(disk.total)}` })),
    network: network.slice(0, 3).map((item) => ({ name: item.name, download: formatRate(item.receivedPerSec), upload: formatRate(item.sentPerSec) })),
    battery: battery
      ? {
          percent: battery.percent === null ? '未知' : `${battery.percent}%`,
          power: battery.pluggedIn ? (battery.charging ? '插电，充电中' : '插电') : '使用电池',
          ...(battery.remainingSeconds ? { remaining: formatDuration(battery.remainingSeconds) } : {}),
          ...(battery.saver ? { saver: true } : {}),
        }
      : '没有电池（台式机）',
    topProcesses: {
      cpu: topProcesses(processes, 'cpu'),
      memory: topProcesses(processes, 'memory'),
      gpuMemory: topProcesses(processes, 'gpuMemory', 6),
      gpuUsage: topProcesses(processes, 'gpuUsage', 5),
      disk: topProcesses(processes, 'disk', 5),
    },
  }
}
