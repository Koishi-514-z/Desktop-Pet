# Desktop Pet

一个基于 Live2D 的 AI 桌宠。角色由大语言模型驱动对话，回复会被实时合成语音朗读出来，并根据情绪切换表情与动作，同时用口型同步让模型"开口说话"。

> 前端基于 Vue 3 + Vite，通过 [Tauri 2](https://tauri.app/) 以桌面应用形式运行；开发调试时也可以直接在浏览器中打开。

## 功能

- **Live2D 渲染**：基于 `pixi.js` + `pixi-live2d-display`（Cubism 4），支持待机动作、眨眼、呼吸、物理摆动，透明背景。
- **交互**：视线跟随鼠标（空闲时自动扫视）、拖拽移动、滚轮缩放、点击命中区域触发动作。
- **AI 对话**：流式输出，多会话管理（新建 / 切换 / 删除），会话记录保存在本地。
- **语音合成**：回复按句切分后逐句合成并按顺序播放，播放音量可调。
- **情绪表达**：模型在回复中输出情绪标签（如 `<happy>`），前端据此随机播放带有对应标签的表情或动作。
- **口型同步**：实时分析播放音频的音量，驱动模型嘴部开合。
- **Agent（技能 + 工具调用）**：先由 LLM 识别用户意图，需要时调用技能中的工具完成请求，再以角色口吻润色结果；内置日期时间、提醒、天气、划词助手、图片理解五个技能，提醒到时桌宠会主动开口。
- **划词**：在任意应用中选中文字后按下快捷键，即可翻译、解释、总结、润色或分析代码。
- **图片理解**：发送图片或截图，即可解释图片内容、提取或翻译图中文字、分析报错。
- **人物设定**：可自定义角色的名字、性格、背景故事与说话风格，并在多个人设之间切换。
- **桌面窗口**：无边框、透明背景、始终置顶，不占用任务栏；透明区域鼠标穿透，不影响操作其他应用；通过托盘图标控制。
- **可配置**：所有设置均可在应用内的设置面板修改，并持久化到 `localStorage`。

## 快速开始

环境要求：

- Node.js `^20.19.0` 或 `>=22.12.0`，推荐使用 [pnpm](https://pnpm.io/)
- 以桌面应用运行时还需要 [Rust](https://www.rust-lang.org/tools/install)（`1.90` 及以上）以及 Tauri 的[系统依赖](https://tauri.app/start/prerequisites/)（Windows 上为 WebView2，Windows 10/11 通常已自带）

```sh
pnpm install
```

**以桌面应用运行**（会自动启动 Vite 开发服务器，首次运行需要编译 Rust 依赖，耗时较长）：

```sh
pnpm exec tauri dev
```

**在浏览器中运行**（仅前端，不含鼠标穿透、托盘等桌面功能）：

```sh
pnpm dev
```

启动后：

1. 点击右下角的 ⚙️ 打开设置面板，在 **Provider** 页填写 LLM 与 TTS 服务的 API Key，并选择要使用的模型（及声线）。
2. 点击 💬 打开对话面板，开始聊天。

> 页面通过 CDN 加载 Live2D Cubism Core（见 [index.html](index.html)），首次运行需要能访问 `cubism.live2d.com`。

## 桌面窗口

桌宠窗口铺满当前显示器的工作区（不遮挡任务栏），背景完全透明，看起来就像模型直接站在桌面上。

- **鼠标穿透**：鼠标位于透明区域时，点击会落到下方的其他应用上；只有位于模型的不透明像素或设置 / 对话面板上时，才由桌宠响应。按住鼠标拖拽期间不会切换为穿透。
- **全局视线跟随**：模型的视线会跟随整个桌面上的鼠标，而不仅限于窗口内。
- **托盘图标**：窗口不在任务栏显示，通过托盘图标操作。左键单击显示 / 隐藏桌宠，右键菜单提供：
  - 显示 / 隐藏
  - 始终置顶（开关）
  - 重置窗口位置
  - 退出
- 打包后的版本会屏蔽 WebView 自带的右键菜单，开发模式下保留以便调试。

> 实现方式：开启穿透后网页收不到鼠标事件，因此前端（[desktop.ts](src/composables/desktop.ts)）会定时轮询全局鼠标坐标，结合 `elementFromPoint` 与 Live2D 画布的像素采样判断当前位置是否需要响应，再调用 `setIgnoreCursorEvents` 切换穿透状态。需要参与这一判断的透明容器以 `data-passthrough` 属性标记。

## 支持的服务

| 类别 | 协议 | 预置 Provider | 说明 |
| --- | --- | --- | --- |
| LLM | `openai` | OpenAI、DeepSeek | 任何 OpenAI 兼容接口都可以通过自定义 Base URL 接入 |
| LLM | `anthropic` | Claude | |
| LLM | `google` | Gemini | |
| TTS | `openai` | OpenAI TTS | |
| TTS | `elevenlabs` / `lmnt` / `hume` / `deepgram` | — | 使用官方固定地址，只需填写 API Key |
| TTS | `index-tts` | IndexTTS | 本地部署，API Key 可选，支持上传自定义音色 |

### 接入本地 IndexTTS

IndexTTS Provider 默认地址为 `http://localhost:8000/v1`，服务端需要提供以下接口：

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` | `/models` | 校验连接、获取模型列表（`{ data: [{ id }] }`） |
| `POST` | `/audio/speech` | OpenAI 兼容的语音合成接口，输出 wav |
| `GET` | `/audio/voices` | 获取音色列表（`{ voices: [{ id, name }] }`） |
| `POST` | `/audio/voices` | 上传音色参考音频（`multipart/form-data`：`name`、`file`、`overwrite`） |
| `DELETE` | `/audio/voices/:id` | 删除音色 |

## 添加 Live2D 模型

1. 将模型文件放到 `public/assets/live2d/models/<模型名>/` 下。
2. 在设置面板的 **Live2D 模型** 页添加模型，填写 `.model3.json` 的路径（如 `/assets/live2d/models/<模型名>/model.model3.json`）。

要让模型响应情绪，需要在 `.model3.json` 的动作与表情条目上添加自定义的 `Tags` 字段：

```json
{
  "File": "Motions_hair_0.json",
  "Tags": ["happy", "love", "shy", "smug"]
}
```

可用的情绪标签：`neutral`、`happy`、`excited`、`love`、`shy`、`smug`、`surprised`、`confused`、`sad`、`angry`、`cry`、`sleepy`。另外，带有 `thinking` 标签的表情会在等待模型回复时播放。

## Agent

每条用户消息会经过三个阶段（[src/agent/](src/agent/)）：

1. **意图识别**（[router.ts](src/agent/router.ts)）：LLM 只看到各技能的名称、描述与示例，输出 `{"skills": [...], "reason": "..."}`。不需要技能（闲聊）时直接进入第 3 步；识别失败也会退化为普通对话。
2. **工具执行**（[executor.ts](src/agent/executor.ts)）：只把被选中技能的使用说明和工具交给 LLM，由它自主调用工具（最多 6 轮），并客观总结执行结果。工具抛出的错误、参数校验失败都会被记录下来，而不是中断流程。
3. **角色润色**（[chat.ts](src/stores/chat.ts)）：执行记录被附加到人设提示词之后，由 LLM 以角色的口吻、带情绪标签流式回复，后续照常进入语音合成与表情动作流程。

三个阶段使用同一个 LLM Provider。启用 Agent 后每条消息会多一次意图识别请求，可以在设置面板的 **技能** 页关闭 Agent 或单独禁用某个技能。

意图已经明确时（如点击划词 / 截图工具栏上的按钮），会通过 `directCall` 跳过前两个阶段的 LLM，直接调用对应的工具，再由角色润色。

| 技能 | 工具 | 说明 |
| --- | --- | --- |
| 日期时间 `datetime` | `get_current_time`、`days_between`、`shift_date` | 当前时间、日期间隔、日期推算 |
| 提醒 `reminder` | `create_reminder`、`list_reminders`、`cancel_reminder` | 提醒持久化在本地，到时桌宠主动提醒；应用关闭期间错过的提醒会在下次启动时补发 |
| 天气 `weather` | `get_weather` | 使用 [Open-Meteo](https://open-meteo.com/) 免费接口，无需 API Key |
| 划词助手 `selection` | `translate_text`、`explain_text`、`summarize_text`、`polish_text`、`analyze_code` | 处理划词选中或直接发来的文字，结果以卡片形式完整展示，见下文「划词」 |
| 图片理解 `image` | `describe_image`、`extract_image_text`、`translate_image`、`analyze_error` | 解释图片、看图答疑、提取 / 翻译图中文字、分析报错截图，见下文「图片理解」 |

### 划词

在任意应用中选中文字，按下划词快捷键（默认 `Ctrl + Alt + Q`，可在设置面板的 **技能** 页修改），鼠标旁会弹出工具栏：

- **翻译 / 解释 / 总结 / 润色 / 代码**：打开对话面板并直接执行，完整结果显示在卡片中（可一键复制），桌宠只用一两句话点评，不会把全文朗读一遍。选中的内容像代码时会突出「代码」按钮。
- **提问**：把选中的文字附加到输入框上方，由你输入具体问题。
- 之后可以继续追问，如「再翻译成日语」「第二点展开说说」，工具会从对话中找回最近一次划词的原文。

实现方式（[capture.rs](src-tauri/src/capture.rs)）：快捷键触发后等待修饰键松开，备份剪贴板，模拟一次 `Ctrl + C`（macOS 为 `Cmd + C`），读取新的剪贴板文字后再恢复原有内容。注意：

- 剪贴板只能恢复文本和图片，原有的文件、富文本等其他格式会丢失；Windows 的剪贴板历史（`Win + V`）中会留下划词的内容。
- 不建议只用 `Alt` 作修饰键：部分应用在松开 `Alt` 时会激活菜单栏，导致复制失败。
- 管理员权限运行的程序不接受普通程序模拟的按键，无法从中划词。macOS 需要在系统设置中授予辅助功能权限。
- 选中的是图片（如浏览器中的图片）时，复制到的图片会交给「图片理解」技能处理。

### 图片理解

发送图片的方式：

- **截图快捷键**（默认 `Ctrl + Alt + W`）：调起系统截图工具框选屏幕区域，鼠标旁会弹出工具栏，可以直接 **解释 / 提取文字 / 翻译 / 分析报错**，或点击 **提问** 把截图附加到输入框。
- 在对话面板中 **粘贴**（如 `Win + Shift + S` 截图后直接 `Ctrl + V`）、**拖入** 图片文件，或点击输入框左侧的按钮选择图片、截图。一条消息最多 4 张图片，可以只发图片不写文字。

处理方式：

- 图片本身不会发给对话模型，消息中只带有 `【附图：图片 id】` 标记；图片理解技能的工具根据标记读取图片，交给 **识图模型** 处理，结果以卡片形式展示，再由角色点评。因此对话模型不支持图片也没关系。
- 识图模型默认跟随对话模型。对话模型不支持图片输入时（如 DeepSeek），在设置面板的 **技能** 页为图片理解单独指定一个支持视觉的模型（如 GPT-4o、Claude、Gemini）。
- 之后可以继续追问，如「第二步具体怎么做」「把图里的文字翻译成日语」，工具默认处理最近一次发送的图片。
- 图片保存在 IndexedDB 中（`localStorage` 容量太小），删除会话或清空对话时一并删除。尺寸过大（最长边超过 2048 像素或超过 2MB）的图片会被缩小并转为 JPEG。
- 截图在 Windows 上使用系统自带的「截图工具」（`ms-screenclip:`），需要开启截图工具的「自动复制到剪贴板」（默认开启）；macOS 使用 `screencapture`；其他系统暂不支持截图，可以直接粘贴图片。

### 新增技能

在 [src/agent/skills/](src/agent/skills/) 下实现一个 `Skill`，并在 [skills/index.ts](src/agent/skills/index.ts) 中注册：

```ts
import { tool } from 'ai'
import { z } from 'zod'

export const mySkill: Skill = {
  id: 'my_skill',                       // 意图识别阶段输出的 id
  name: '我的技能',                      // 界面展示名
  description: '这个技能能处理哪些请求',    // 意图识别依据，越具体越好
  examples: ['用户可能会怎么说'],
  instructions: '技能被激活后，告诉 LLM 如何使用这些工具',
  tools: {
    do_something: tool({
      description: '工具的作用',
      inputSchema: z.object({ text: z.string().describe('参数说明') }),
      execute: async ({ text }) => ({ result: text }), // 抛出的错误会被记录并告知 LLM
    }),
  },
}
```

工具名在所有技能之间需唯一。另外：

- **在工具中调用 LLM**：`getSkillContext(options)`（`execute` 的第二个参数）可以拿到当前使用的模型 `model` 与识图模型 `visionModel`，参考 [selection.ts](src/agent/skills/selection.ts)、[image.ts](src/agent/skills/image.ts)。
- **结果卡片**：返回值中带上 `display: { title, content, format? }`，结果会以卡片形式完整展示在回复下方，角色只需简短点评，适合译文、总结这类需要原样呈现的长文本。
- **直接调用**：`useChatStore().sendMessage(文字, { directCall: { skillId, toolName, input } })` 跳过意图识别直接执行工具，可同时用 `quote` 附带一段引用文字。
- **主动说话**：需要让桌宠主动开口时（如定时任务完成），调用 `useChatStore().speakProactively('事件描述')`。

## 工作流程

```
用户输入
  → ChatStore
  → Agent：意图识别 → 工具执行（需要技能时）
  → LLM 以角色口吻流式输出
  → 文本处理队列：解析 <情绪> 标签，按句末标点切分句子
  → 语音合成队列：逐句调用 TTS
  → 播放队列：按原始顺序播放音频 / 切换表情与动作
  → Live2D 模型：口型同步 + 表情动作
```

## 项目结构

```
src-tauri/                   # Tauri 桌面端
├── src/lib.rs               # 窗口定位、托盘图标与菜单
├── src/capture.rs           # 划词与截图：全局快捷键、模拟复制读取选中内容、调起系统截图工具
├── tauri.conf.json          # 窗口配置（无边框、透明、置顶等）
└── capabilities/            # 前端可调用的窗口权限
src/
├── components/
│   ├── Stage.vue            # 串联对话、语音合成与播放队列
│   ├── Live2dModel.vue      # Live2D 渲染与交互
│   ├── InteractiveArea.vue  # 对话面板
│   ├── CaptureToolbar.vue   # 划词 / 截图后弹出的工具栏
│   ├── SettingBox.vue       # 设置面板
│   └── settings/            # 各设置页（Provider / Live2D / 人物设定 / 场景 / 技能）
├── agent/                   # Agent：意图识别、工具执行与各技能
│   └── skills/              # 内置技能（日期时间 / 提醒 / 天气 / 划词助手 / 图片理解）
├── composables/
│   ├── queues.ts            # 文本处理、语音合成、音频播放队列
│   ├── animation.ts         # 视线跟随
│   └── desktop.ts           # 桌面窗口：鼠标穿透与全局鼠标坐标
├── stores/                  # Pinia 状态（chat / agent / capture / reminders / speech / audio / live2d / persona / providers / scene）
├── utils/                   # 网络请求、队列、数学工具等
└── pages/HomePage.vue
```

## 常用命令

| 命令 | 说明 |
| --- | --- |
| `pnpm exec tauri dev` | 以桌面应用形式启动开发版本 |
| `pnpm exec tauri build` | 构建桌面应用安装包 |
| `pnpm dev` | 启动前端开发服务器（浏览器中运行） |
| `pnpm build` | 类型检查并构建前端生产版本 |
| `pnpm preview` | 预览构建产物 |
| `pnpm type-check` | 使用 `vue-tsc` 进行类型检查 |
| `pnpm lint` | 运行 oxlint 与 ESLint（自动修复） |
| `pnpm format` | 使用 Prettier 格式化 `src/` |
| `pnpm test:unit` | 运行 Vitest 单元测试 |
| `pnpm test:e2e` | 运行 Playwright 端到端测试（首次需执行 `npx playwright install`） |

## 注意事项

- API Key 等设置仅保存在本地（WebView / 浏览器的 `localStorage`，对话中的图片保存在 IndexedDB）中，并由前端直接请求各服务商接口。桌面应用与浏览器中的设置互不相通。
- 打包前需要将 [tauri.conf.json](src-tauri/tauri.conf.json) 中的 `identifier` 改为唯一的值（默认的 `com.tauri.dev` 无法用于打包）。修改后 WebView 的数据目录随之改变，之前保存的设置需要重新填写。
- 目前窗口只覆盖一块显示器。
- 仓库内置的 ATRI 模型及语音素材版权归原作者所有，仅供学习交流使用。
