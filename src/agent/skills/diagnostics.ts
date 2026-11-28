import type { Skill } from '@/agent/types'
import { tool } from 'ai'
import { z } from 'zod'
import { getSkillContext } from '@/agent/context'
import { describeProcess, getSystemSnapshot, summarizeSnapshot } from '@/utils/diagnostics'

export const DIAGNOSTICS_SKILL_ID = 'diagnostics'

export const diagnosticsSkill: Skill = {
  id: DIAGNOSTICS_SKILL_ID,
  name: '系统诊断',
  description: '查看用户电脑的 CPU、GPU、内存、显存、磁盘、网络、电池与进程的实时状态，分析电脑卡顿、发热、风扇响、耗电快、内存或显存占用高等问题的原因，回答哪个程序占用了资源。只读取状态，不会结束程序或修改设置。',
  examples: [
    '为什么我的电脑突然变得这么卡？',
    '哪个进程占用了这么多显存？',
    '内存怎么用了这么多',
    '风扇怎么一直在转',
    '现在 CPU 占用多少',
    '电脑为什么这么耗电',
  ],
  instructions: `- 用 check_system 获取当前状态：约 1 秒内的 CPU、GPU、内存、显存、磁盘、网络、电池，以及各项资源占用最多的程序（同名进程已合并，如几十个 chrome 进程算作一个）。issues 中是按阈值找出的明显异常，优先分析。
- 根据用户的问题找出瓶颈（CPU、内存、显存、磁盘读写、磁盘空间、网络、电池与省电模式），点名占用最多的程序，结合常识推断原因。例如：浏览器标签页多占内存；动态壁纸、游戏、视频软件占显存；杀毒软件（MsMpEng）扫描、系统更新、搜索索引（SearchIndexer）在后台大量读写磁盘；内存不够时虚拟内存频繁读写导致卡顿；省电模式或低电量限制了性能；很久没有重启。
- 这是一次采样：用户说的卡顿可能已经过去了。状态正常时如实说明，建议下次卡的时候再问一次；需要确认是不是持续占用时，可以隔几秒再调用一次 check_system 对比。
- 用户问到某个程序（如「Chrome 用了多少内存」）时，用 find_processes 查看它的详细情况。
- 不能结束进程或修改系统设置：需要时告诉用户可以怎么做（如关掉哪个程序、在任务管理器中结束、关闭开机自启、清理磁盘），说明可能的影响（如未保存的内容会丢失）。
- 用口语说结论，挑重点：最主要的原因、是哪个程序、建议怎么办；数字只说关键的几个，不要把所有数据念一遍。`,
  tools: {
    check_system: tool({
      description: '采样约 1 秒，获取 CPU、GPU、内存、显存、磁盘、网络、电池的状态，以及各项资源占用最多的程序，并标出明显的异常',
      inputSchema: z.object({}),
      execute: async (_input, options) => {
        getSkillContext(options).setStatus?.('正在检查系统状态…')
        return summarizeSnapshot(await getSystemSnapshot())
      },
    }),

    find_processes: tool({
      description: '按名称查找正在运行的程序，返回它们的 CPU、内存、显存、磁盘读写与进程 id（同名进程已合并）',
      inputSchema: z.object({
        query: z.string().min(1).describe('程序名称中的文字，如「chrome」「WeChat」「Code」；不区分大小写'),
      }),
      execute: async ({ query }, options) => {
        getSkillContext(options).setStatus?.(`正在查找「${query}」…`)
        const { processes } = await getSystemSnapshot()
        const q = query.trim().toLowerCase()
        const matched = processes
          .filter((group) => group.name.toLowerCase().includes(q))
          .sort((a, b) => b.memory - a.memory)
          .slice(0, 10)
          .map(describeProcess)
        return matched.length
          ? { processes: matched }
          : { processes: [], message: `没有找到名称中包含「${query}」的程序，它可能没有在运行，或者进程名与软件名不同（如微信是 WeChat / Weixin）` }
      },
    }),
  },
}
