# OpenCode 桌面端改造为「生图 / 生视频工作台」架构设计

> 状态：草案 v1 · 2026-09-12
> 范围：`packages/desktop`（Electron 壳）、`packages/opencode`（agent 内核）、`packages/app`（UI）

---

## 1. 需求摘要

### 功能需求
- F1 Agent 可通过工具调用本地 ffmpeg，对图片 / 视频做处理（转码、剪辑、拼接、抽帧、加水印等）
- F2 Agent 可调用外部生成模型（gpt-image-2、Seedance 2.0 等）生成图片 / 视频
- F3 生成与处理结果可在桌面端直接预览、管理（媒体库）
- F4 视频生成等长耗时任务异步执行，可轮询 / 回调，不阻塞会话

### 非功能需求
- N1 跨平台：macOS / Windows / Linux（ffmpeg 分发方案必须三平台可用）
- N2 处理性能：本地视频处理不能因 WASM 性能损耗不可用（4K 转码场景）
- N3 成本与安全：调用付费生成 API 必须走权限确认（复用现有 Permission 系统）
- N4 合规：ffmpeg 编解码器专利与 GPL/LGPL 许可边界清晰
- N5 不破坏现有编码 agent 能力（改造是「加」，不是「换」）

---

## 2. 现状盘点（改造空间判断依据）

| 层 | 现状 | 对本改造的意义 |
|---|---|---|
| 桌面壳 | `packages/desktop` Electron，`src/main/sidecar.ts` 以 utilityProcess 启动 opencode server | ffmpeg 二进制可随 electron-builder `extraResources` 分发；主进程可做硬件加速播放、原生文件对话框 |
| 工具系统 | `packages/opencode/src/tool/registry.ts` 合并内置工具 + 插件工具 + MCP 工具 | 新增媒体工具有三条成熟路径，零框架改动 |
| MCP | `packages/opencode/src/mcp` 是完整 MCP client（含 OAuth、catalog、工具缓存） | 直接挂一个本地 stdio MCP server 即可获得媒体工具，最快路径 |
| WASM 媒体处理 | `src/image/image.ts` 已用 photon WASM 做图片缩放 | 证明「内核跑 WASM 媒体库」可行，可扩展到缩略图、雪碧图等轻量处理 |
| 会话/附件 | 工具 `ExecuteResult` 支持 `attachments`（FilePart），结果可直接回流会话 | 生成的图片/视频可以作为附件出现在对话里 |
| 后台任务 | `src/background/job`（BackgroundJob） | 视频生成轮询的天然载体 |
| 模型层 | `src/provider` 面向 LLM chat completion（ai-sdk） | **不适合**承载媒体生成；需新建独立的 Media Provider 抽象 |
| 权限 | `src/permission` 细粒度规则 | 生成 API 调用（花钱）、ffmpeg 写文件都应挂权限 |

**结论：改造空间充足。内核（Session/Server/LLM Provider）基本不动，工作集中在「新增媒体能力层 + 桌面端打包 + UI」。**

---

## 3. 高层架构

```
┌─────────────────────────── Electron Desktop ───────────────────────────┐
│  Renderer (packages/app, SolidJS)                                      │
│   ├─ 会话 UI（现有）          ├─ 媒体库视图（新）   ├─ 生成面板（新）     │
│   └─ 预览播放器 / 轻编辑（新）                                          │
│                                                                        │
│  Main Process                                                          │
│   ├─ sidecar: opencode server（现有）                                   │
│   └─ resources/ffmpeg/<platform>/ （新，electron-builder extraResources）│
└─────────────────────────────────┬──────────────────────────────────────┘
                                  │ HTTP (loopback)
┌─────────────────────────────────▼──────────────────────────────────────┐
│  opencode server (packages/opencode)                                   │
│                                                                        │
│  ToolRegistry（现有三路合并）                                           │
│   ├─ builtin: media_probe / media_process / media_generate_*（新，P1） │
│   ├─ plugin tools（现有机制）                                           │
│   └─ MCP tools ──► opencode-media-mcp（新，P0 先行验证）               │
│                     └─ 内部同样调 FFmpegService + MediaProvider        │
│                                                                        │
│  新增模块：                                                            │
│   ├─ media/ffmpeg.ts     FFmpegService：解析二进制路径、执行、队列      │
│   ├─ media/provider.ts   MediaProvider 抽象（image/video，异步 job）   │
│   │    ├─ openai (gpt-image-2)                                        │
│   │    └─ volcengine-ark (Seedance 2.0)                               │
│   ├─ media/library.ts    产物落盘 + 元数据索引（复用 storage/database） │
│   └─ background/job（现有）：视频生成轮询                               │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 4. 关键决策（ADR）

### ADR-1：ffmpeg 执行方式 —— 仅原生二进制，不引入 WASM 方案

**选项**

| 方案 | 优点 | 缺点 |
|---|---|---|
| A. ffmpeg.wasm（@ffmpeg/core）纯 WASM | 零安装、跨平台一致、沙箱安全 | 视频处理慢 5–10×；内存上限 ~2–4GB；4K 长视频基本不可用；core 体积 ~30MB |
| B. 随包分发原生 ffmpeg 二进制 | 全速、可硬件加速（videotoolbox/nvenc）、无内存天花板 | 每平台 +60–90MB 安装包；需处理平台分发与许可 |
| C. 依赖用户系统 ffmpeg | 安装包最小 | 版本不可控、安装摩擦、企业环境常缺失 |

**决策：仅 B（桌面端）+ C 回退（CLI/服务器形态）。WASM 方案整体移除**（2026-09-12 修订：视频场景 WASM 性能不可接受，双路径维护成本不值得）。
- 桌面端通过 electron-builder `extraResources` 按平台分发原生 ffmpeg/ffprobe（GPL-free 的 LGPL 构建，见 ADR-4）。
- CLI/服务器形态回退到系统 PATH 中的 ffmpeg；两者都不可用时媒体工具直接报错并给出安装指引。
- 图片轻处理（缩放/缩略图）继续用现有 photon WASM（`src/image/image.ts`），不属于本决策范围。

**理由**：N2（性能）是硬约束；「零安装」诉求由随包分发解决，无需 WASM 承担。

### ADR-2：工具接入路径 —— 两阶段：先 MCP，后内置

**选项**

| 方案 | 优点 | 缺点 |
|---|---|---|
| A. 本地 stdio MCP server 暴露媒体工具 | 零内核改动（MCP client 已就绪）；独立仓库迭代快；用户可自行替换 | 权限粒度粗；进度事件/附件回流 UX 受限 |
| B. 内核内置工具（`src/tool/media_*.ts`） | 原生权限、进度、`attachments` 回流、错误结构化 | 需进内核、走发版 |

**决策：两阶段。**
- **P0（验证期，1–2 周）**：做 `opencode-media-mcp`（TypeScript，stdio），暴露 `media_generate_image`、`media_generate_video`、`media_process`（ffmpeg 命令模板化执行）、`media_probe`。用户在 `opencode.json` 的 `mcp` 段挂载即可用。**ffmpeg 执行与 MediaProvider 抽成独立 npm 包**，MCP server 只是壳。
- **P1（产品化）**：把同一套核心包接入内核内置工具（`media_probe` / `media_process` / `media_generate_image` / `media_generate_video`），获得权限规则（如 `media_generate_video: ask`）、后台任务进度、附件回流会话。MCP server 保留给高级用户。

**安全要点**：`media_process` 不接受任意 ffmpeg 命令行，只接受「模板 + 参数」白名单（transcode/trim/concat/extract_frames/watermark/gif 等），避免变成 shell 后门。

### ADR-3：媒体生成模型 —— 独立 MediaProvider 抽象，不进 LLM Provider

**决策**：新建 `src/media/provider.ts`，接口与 LLM `provider.ts` 完全分离：

```ts
interface MediaProvider {
  id: string
  generateImage(req: ImageRequest): Promise<ImageResult>          // 同步返回
  generateVideo(req: VideoRequest): Promise<VideoJob>             // 异步 job
  pollVideo(job: VideoJob): Promise<VideoJobStatus>               // 轮询
}
```

- `gpt-image-2`：OpenAI Images API（同步/后台模式均支持，首选 `background: true` 统一异步模型）。
- `Seedance 2.0`：火山引擎 Ark 内容生成 API，任务制（create → poll），密钥走 `provider` 同款 auth 配置。
- 抽象要点：统一「任务制」语义（图片也建模为可即时完成的 job），统一产物回调落盘到 MediaLibrary，统一计费元数据（resolution/duration → cost 估算）写入 metadata。
- 新增模型（fal、Replicate、可灵、Vidu）只加一个 provider 文件。

**理由**：媒体生成不是 chat completion，塞进 ai-sdk 模型层会污染 LLM 抽象（transform、streaming、tool-call 语义全都不匹配）；独立抽象也便于 P1 阶段挂权限与配额。

### ADR-4：ffmpeg 许可与编解码器合规

- 分发 **LGPL 构建**（`--enable-gpl` 关闭、不含 x264/x265/fdk-aac），规避 GPL 传染性；H.264 编码输出默认用 `libopenh264`（Cisco 承担专利费）或平台硬编（macOS VideoToolbox / Windows MediaFoundation）。
- 解码 H.264/HEVC 在桌面播放由 OS/播放器承担，不构成我们的分发。
- 安装包内附带 ffmpeg `LICENSE` 与源码获取说明（LGPL 合规要求）。

### ADR-5：产物存储 —— 项目级媒体库

- 产物落盘 `<project>/.opencode/media/<yyyy-mm>/<id>.<ext>`，元数据（prompt、模型、参数、来源 job、成本）存入现有 SQLite（新增 `media_asset` 表，snake_case 字段，走 effect-drizzle-sqlite 迁移）。
- 工具执行结果通过 `attachments`（FilePart）回流会话，UI 端媒体库视图读同一张表，两端天然一致。
- 清理策略：保留期可配（默认永久），提供 `media_prune` 工具。

---

## 4.5 聊天窗口富媒体渲染现状（2026-09-12 补充查证）

| 类型 | 现状 | 需要的改造 |
|---|---|---|
| 图片 | **已支持**。`packages/session-ui` 的 `message-part.tsx` 会把 `image/*` 的 FilePart 内联渲染为 `<img>`；`message-file.ts` 将 image 与普通 file 分流 | 无需改动，生成图片通过工具 `attachments` 回流即可直接显示 |
| 视频 | **不支持**。消息区无任何 `<video>` 渲染路径，视频 FilePart 落入通用 file 分支，只显示文件 chip | P1 新增：`session-ui` 增加视频 part 渲染（`<video controls>`）；server 新增 `/media/:id/content` 流式端点，UI 以 URL 拉流而非 base64 |
| 传输通道 | 附件主要走 data URL（base64），图片可用，几十 MB 视频不可行 | 同上：媒体产物一律「落盘 + URL 引用」，不进 base64 通道 |

---

## 5. 改造范围（按包）

| 包 | 改动 | 量级 |
|---|---|---|
| `packages/opencode/src/media/`（新） | FFmpegService、MediaProvider 抽象 + openai/ark 两个实现、MediaLibrary、ffmpeg 模板白名单 | **新增 ~1500 行** |
| `packages/opencode/src/tool/` | P1 新增 `media_probe.ts` / `media_process.ts` / `media_generate_image.ts` / `media_generate_video.ts` + `.txt` 描述 + registry 注册 | 新增 ~600 行 |
| `packages/opencode/src/config` | `media` 配置段（ffmpeg 路径覆盖、默认模型、产物目录、清理策略） | 小 |
| `packages/opencode/src/permission` | 新增 `media_generate_*`、`media_process` 权限类别 | 小 |
| `packages/core`（schema/database） | `media_asset` 表迁移 | 小 |
| `packages/desktop` | electron-builder `extraResources` 按平台打包 ffmpeg；安装器体积脚本；主进程新增「在系统播放器打开」等 IPC | 中 |
| `packages/app` | 媒体库视图（网格/筛选/删除）、生成参数面板、会话内富媒体附件渲染（视频 player）、后台任务进度条 | **中-大（主要 UI 工作）** |
| `packages/opencode/src/server` | 新增 `/media` REST 端点（列表/读取/删除 + `/media/:id/content` 流式内容端点），供 UI 使用 | 小 |
| `packages/session-ui` | 新增视频 part 渲染（`<video controls>`，URL 拉流）；图片沿用现有 `<img>` 路径 | 小 |
| 新仓库/包 `opencode-media-mcp` | P0 验证用 stdio MCP server（复用上述核心逻辑） | 新增 ~400 行 |
| **不动** | session 核心、LLM provider、TUI（P0/P1 阶段保持只读文本输出即可）、sdk | — |

---

## 5.5 Code Agent 特性裁剪（AIGC 适配，2026-09-12 补充）

**总原则：代码不删，产品层裁剪。** 工具可见性本来就按 agent 配置，新建 `creator` agent 用工具白名单即可；硬删代码会永久失去 merge 上游的能力。

| 档位 | 特性 | 处理方式 |
|---|---|---|
| 隐藏（`creator` agent 白名单不放） | `lsp`、`apply_patch`、`edit`、`write`（或限定 media 目录）、`skill`、`task`、plan 模式、todo | 纯配置，零代码改动 |
| 保留但改造 | `shell` 收窄或隐藏（由 `media_process` 模板替代）；`read`/`glob`/`grep` 保留（读素材目录）；`webfetch`/`websearch` 保留（找参考、查提示词） | 小改 |
| UI 入口隐藏 | git worktree/snapshot 面板、IDE/ACP 集成、diff 视图、命令面板 code 命令、`dialog-connect-provider` 代码向引导 | 只动 `packages/app` 路由/菜单 |
| 真正可删（永久分叉后） | `src/lsp`、`src/ide`、`src/acp`、`src/snapshot`、TUI 包整体 | 至少稳定一个版本后再动刀 |

**反向结论**：权限系统（生成 API 计费 ask）与后台任务系统（视频轮询）是 AIGC 最痛的两块基础设施，code agent 底子里现成，务必保留。

---

## 6. 分阶段计划

| 阶段 | 目标 | 内容 | 预估 |
|---|---|---|---|
| **P0 验证** | agent 能生图/生视频/跑 ffmpeg | `opencode-media-mcp`（MCP 挂载）+ 独立媒体核心包 + 系统 ffmpeg | 1–2 周 |
| **P1 产品化** | 权限、异步、落盘、UI 媒体库 | 内置工具 4 个 + MediaProvider 落内核 + `media_asset` 表 + 媒体库视图 + 后台轮询 | 3–4 周 |
| **P2 体验** | 桌面端完整交付 | ffmpeg 随包分发（三平台 CI）+ 生成面板 + 轻编辑（trim/拼接向导）+ 成本统计 | 3–4 周 |

---

## 7. 风险与缓解

| 风险 | 等级 | 缓解 |
|---|---|---|
| ffmpeg 专利/许可合规 | 高 | ADR-4：LGPL 构建 + libopenh264 + 平台硬编；发布前法务过一遍 |
| 安装包膨胀（每平台 +60–90MB） | 中 | 提供「核心版 / 媒体版」两个构建变体；或首启按需下载（带哈希校验） |
| 视频生成 API 异步语义漂移（Ark/OpenAI 轮询接口变动） | 中 | MediaProvider 把轮询封装在 provider 内；加契约测试 + http-recorder 录制回放 |
| `media_process` 被诱导执行危险命令 | 高 | 模板白名单，拒绝自由命令行；路径限制在项目目录内（复用 external-directory 权限） |
| 生成 API 费用失控 | 中 | 权限默认 `ask`；每次调用 metadata 记录成本估算；可选日配额 |

---

## 8. 开放问题（定稿前需确认）

1. 是否需要「模板/工作流」层（如「口播视频流水线：脚本→分镜→批量生图→TTS→合成」）？这会决定 P2 是否引入 preset 系统。
2. TUI 端要不要做媒体能力（ASCII 预览/仅落盘）？建议暂不做。
3. 生成内容是否需要内置水印/溯源元数据（C2PA）？若有合规诉求，P1 的 MediaLibrary 落盘时一并写入。
