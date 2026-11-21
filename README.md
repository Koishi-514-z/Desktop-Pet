# Desktop Pet

一个基于 Live2D 的 AI 桌宠。角色由大语言模型驱动对话，回复会被实时合成语音朗读出来，并根据情绪切换表情与动作，同时用口型同步让模型"开口说话"。

> 当前为 Web 应用形态（Vue 3 + Vite），在浏览器中运行。

## 功能

- **Live2D 渲染**：基于 `pixi.js` + `pixi-live2d-display`（Cubism 4），支持待机动作、眨眼、呼吸、物理摆动，透明背景。
- **交互**：视线跟随鼠标（空闲时自动扫视）、拖拽移动、滚轮缩放、点击命中区域触发动作。
- **AI 对话**：流式输出，多会话管理（新建 / 切换 / 删除），会话记录保存在本地。
- **语音合成**：回复按句切分后逐句合成并按顺序播放，播放音量可调。
- **情绪表达**：模型在回复中输出情绪标签（如 `<happy>`），前端据此随机播放带有对应标签的表情或动作。
- **口型同步**：实时分析播放音频的音量，驱动模型嘴部开合。
- **人物设定**：可自定义角色的名字、性格、背景故事与说话风格，并在多个人设之间切换。
- **可配置**：所有设置均可在应用内的设置面板修改，并持久化到 `localStorage`。

## 快速开始

环境要求：Node.js `^20.19.0` 或 `>=22.12.0`，推荐使用 [pnpm](https://pnpm.io/)。

```sh
pnpm install
pnpm dev
```

启动后在浏览器中打开终端输出的地址，然后：

1. 点击右下角的 ⚙️ 打开设置面板，在 **Provider** 页填写 LLM 与 TTS 服务的 API Key，并选择要使用的模型（及声线）。
2. 点击 💬 打开对话面板，开始聊天。

> 页面通过 CDN 加载 Live2D Cubism Core（见 [index.html](index.html)），首次运行需要能访问 `cubism.live2d.com`。

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

## 工作流程

```
用户输入
  → ChatStore（LLM 流式输出）
  → 文本处理队列：解析 <情绪> 标签，按句末标点切分句子
  → 语音合成队列：逐句调用 TTS
  → 播放队列：按原始顺序播放音频 / 切换表情与动作
  → Live2D 模型：口型同步 + 表情动作
```

## 项目结构

```
src/
├── components/
│   ├── Stage.vue            # 串联对话、语音合成与播放队列
│   ├── Live2dModel.vue      # Live2D 渲染与交互
│   ├── InteractiveArea.vue  # 对话面板
│   ├── SettingBox.vue       # 设置面板
│   └── settings/            # 各设置页（Provider / Live2D / 人物设定 / 场景）
├── composables/
│   ├── queues.ts            # 文本处理、语音合成、音频播放队列
│   └── animation.ts         # 视线跟随
├── stores/                  # Pinia 状态（chat / speech / audio / live2d / persona / providers / scene）
├── utils/                   # 网络请求、队列、数学工具等
└── pages/HomePage.vue
```

## 常用命令

| 命令 | 说明 |
| --- | --- |
| `pnpm dev` | 启动开发服务器 |
| `pnpm build` | 类型检查并构建生产版本 |
| `pnpm preview` | 预览构建产物 |
| `pnpm type-check` | 使用 `vue-tsc` 进行类型检查 |
| `pnpm lint` | 运行 oxlint 与 ESLint（自动修复） |
| `pnpm format` | 使用 Prettier 格式化 `src/` |
| `pnpm test:unit` | 运行 Vitest 单元测试 |
| `pnpm test:e2e` | 运行 Playwright 端到端测试（首次需执行 `npx playwright install`） |

## 注意事项

- API Key 等设置仅保存在浏览器的 `localStorage` 中，并由浏览器直接请求各服务商接口。
- 仓库内置的 ATRI 模型及语音素材版权归原作者所有，仅供学习交流使用。
