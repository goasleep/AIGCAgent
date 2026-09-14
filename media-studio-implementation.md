# OpenCode 桌面端 → AIGC 生图/生视频工作台：详细改造实施文档

> 版本：v1.0 · 2026-09-12
> 前置阅读：`media-studio-architecture.md`（架构决策与范围，本文档是其落地细化）
> 适用分支：`dev`

---

## 0. 阅读指引

- 第 1–3 章：前置准备（ffmpeg 获取、API 密钥、合规）
- 第 4 章：P0 实施细节（MCP server 全量脚手架 + 配置）
- 第 5 章：P1 实施细节（内核内置工具 + MediaProvider + 存储 + UI 视频渲染）
- 第 6 章：P2 实施细节（桌面端打包分发 + 完整 UI）
- 第 7 章：配置样例全集
- 第 8 章：注意事项与坑清单（**动手前必读**）
- 第 9 章：测试策略
- 第 10 章：交付 Checklist

---

## 1. 前置准备

### 1.1 ffmpeg 二进制获取

P0 阶段先用系统 ffmpeg（`brew install ffmpeg` / `winget install ffmpeg`）验证链路；P2 再随包分发。

随包分发时的获取渠道（按优先级）：

| 平台 | 来源 | 许可形态 | 备注 |
|---|---|---|---|
| macOS (arm64/x64) | 自编译（CI）或 evermeet.cx | 需确认 LGPL | 自编译可控性最高，推荐 |
| Windows (x64) | gyan.dev `ffmpeg-release-essentials` 或自编译 | essentials 为 LGPL | 不要用 `full` 变体（含 GPL 组件） |
| Linux (x64) | johnvansickle.com static builds 或自编译 | 需确认 | 注意 glibc 版本下限 |

自编译参考参数（LGPL 合规 + 体积可控）：

```bash
./configure \
  --disable-gpl --disable-nonfree --disable-debug \
  --enable-libopenh264 \
  --enable-videotoolbox \   # macOS；Windows 换 --enable-mediafoundation，Linux 换 --enable-vaapi
  --disable-doc --disable-programs --enable-ffmpeg --enable-ffprobe \
  --disable-everything \
  --enable-decoder=h264,hevc,vp8,vp9,av1,aac,mp3,opus,png,mjpeg,webp \
  --enable-encoder=libopenh264,aac,png,mjpeg,libwebp \
  --enable-demuxer=mov,mp4,matroska,webm,image2,gif,mp3,wav \
  --enable-muxer=mp4,webm,image2,gif,ipod,wav \
  --enable-protocol=file,http,https,pipe \
  --enable-filter=scale,crop,trim,concat,overlay,drawtext,fps,format,split,amix,aresample
```

> ⚠️ `--disable-everything` 白名单方式编译可以把单平台二进制压到 25–40MB（完整构建 70–90MB）。filter/demuxer 清单按模板白名单（§4.4）实际需要增删。

**合规动作（ADR-4）**：
- 安装包内附带 ffmpeg `LICENSE` 文本与「源码获取说明」（LGPL §6 要求）
- 若启用 `--enable-libopenh264`，附带 Cisco 的 `LICENSE`（bsd-2 + 专利授权说明）
- 不启用 `--enable-gpl`（x264/x265）、不启用 `--enable-nonfree`（fdk-aac）

### 1.2 生成模型 API 准备

| 模型 | 提供方 | 获取 | 调用形态 |
|---|---|---|---|
| gpt-image-2 | OpenAI | platform.openai.com API key | Images API，支持 `background: true` 异步 |
| Seedance 2.0 | 火山引擎 Ark | console.volcengine.com 开通 + API key | 任务制：POST 创建任务 → GET 轮询 |

P0 阶段用环境变量传密钥（见 §7）；P1 阶段接入 opencode 的 auth/login 体系（`src/provider/auth.ts` 同款存储）。

### 1.3 开发环境

- Bun（仓库工具链即 Bun，`bun.lock` 在根目录）
- 本仓库 `packages/opencode` 可独立 `bun dev` 起 server 用于联调
- 一台装有系统 ffmpeg 的机器（P0 验证用）

---

## 2. 总体实施路线（与架构文档一致）

```
P0 (1–2 周)  opencode-media-mcp：独立 stdio MCP server，挂 opencode.json 即用
P1 (3–4 周)  内置工具 + MediaProvider 落内核 + media_asset 表 + 视频渲染 + /media 端点
P2 (3–4 周)  ffmpeg 随包分发 + 媒体库 UI + 生成面板 + creator agent 默认体验
```

---

## 3. 产物目录与命名约定（P0–P2 通用）

```
<project>/.opencode/media/
  <yyyy-mm>/                    # 按月分目录
    <asset_id>.<ext>            # 产物本体
  tmp/                          # ffmpeg 中间产物，任务结束即清
```

- `asset_id`：复用仓库 `src/id` 的 ID 生成（`Identifier.ascending` 风格），保证按时间排序
- 所有媒体工具的**路径输入一律为项目相对路径**，禁止绝对路径出项目根（§8.2 安全约束）
- ffmpeg 中间产物必须落 `tmp/`，禁止写系统 `/tmp`（跨项目污染 + 权限问题）

---

## 4. P0 实施：`opencode-media-mcp`

### 4.1 仓库结构

```
opencode-media-mcp/
  package.json
  tsconfig.json
  src/
    index.ts            # stdio server 入口（@modelcontextprotocol/sdk）
    ffmpeg.ts           # FFmpegRunner：探测、执行、超时、取消
    templates.ts        # ffmpeg 命令模板白名单
    generate.ts         # 生成模型调用（openai / ark）
    store.ts            # 产物落盘 + 简易元数据 json（P0 无数据库）
    paths.ts            # 项目根解析与路径校验
  test/
    templates.test.ts
    paths.test.ts
```

`package.json` 关键依赖：

```json
{
  "name": "opencode-media-mcp",
  "type": "module",
  "bin": { "opencode-media-mcp": "./dist/index.js" },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.x",
    "zod": "^3.x"
  }
}
```

> 用 `bun build --target node` 或 tsc 产出 `dist/`；不要求与主仓库同一依赖体系，独立发版。

### 4.2 暴露的 4 个工具（MCP schema）

| 工具 | 参数 | 返回 |
|---|---|---|
| `media_probe` | `path` | ffprobe JSON：时长、分辨率、码率、流信息 |
| `media_process` | `template`、`inputs`、`output`、`params` | 产物路径 + ffmpeg stderr 尾部摘要 |
| `media_generate_image` | `prompt`、`size?`、`quality?`、`model?`、`reference?` | 产物路径 +  revised prompt + 成本估算 |
| `media_generate_video` | `prompt`、`duration?`、`ratio?`、`model?`、`first_frame?` | 产物路径 + 任务耗时 |

返回内容用 MCP 的 `content: [{type:"text", text: <json>}]`，**不要**用 MCP image content 回传 base64（原因见 §8.1）；路径返回给 agent，agent 可在回复中引用。

### 4.3 FFmpegRunner 关键实现点

```ts
// src/ffmpeg.ts（示意，非完整代码）
export async function runFfmpeg(args: string[], opts: { timeoutMs: number; cwd: string; signal?: AbortSignal }) {
  const bin = process.env.OPENCODE_MEDIA_FFMPEG ?? "ffmpeg"
  const proc = spawn(bin, ["-hide_banner", "-y", ...args], { cwd: opts.cwd, signal: opts.signal })
  const stderr = await collectTail(proc.stderr, 8_192)   // 只留尾部 8KB，防 OOM
  const code = await exitCode(proc, opts.timeoutMs)       // 超时 SIGKILL
  if (code !== 0) throw new FfmpegError(code, stderr)
  return { stderr }
}
```

要点：
- `-hide_banner` 减噪；`-y` 由 runner 统一加，模板里不写
- stderr 只保留尾部窗口（ffmpeg 进度刷屏，全量收集会撑爆内存）
- 默认超时：图片模板 60s，视频模板 10min，可通过 `params.timeout_ms` 覆盖但设硬上限 30min
- **并发限制**：进程内信号量，最多 2 个 ffmpeg 并发（视频转码吃满 CPU，更多并发只会更慢）
- 取消：MCP 请求 abort → `AbortSignal` → kill 进程树（Windows 下 `taskkill /T`，注意 ffmpeg 在 Windows 是 exe 无子进程问题）

### 4.4 模板白名单（P0 最小集）

| template | 说明 | 参数 |
|---|---|---|
| `transcode` | 转码/改封装 | `codec?(h264/vp9)`、`crf?(默认 23)`、`preset?(默认 medium)` |
| `trim` | 截取片段 | `start`(秒或 hh:mm:ss)、`duration` 或 `end` |
| `concat` | 多段拼接（同编码走 concat demuxer 无损） | `inputs`(数组，2–20 个) |
| `extract_frames` | 抽帧 | `fps?` 或 `timestamps?[]`、`format?(png/jpg)` |
| `watermark` | 叠加水印图 | `overlay_path`、`position`(九宫格)、`opacity?` |
| `make_gif` | 视频转 GIF | `fps?(默认 12)`、`width?(默认 480)` |
| `resize_image` | 图片缩放/格式转换 | `width?/height?`、`format?` |
| `thumbnail` | 视频封面帧 | `at?(秒，默认 1)` |

模板实现是**参数 → 固定 argv 数组的纯函数**，全部参数经 zod 校验后再拼 argv，例如：

```ts
trim: (p) => ["-i", in0, "-ss", String(p.start), "-t", String(p.duration), "-c", "copy", out]
// 注意：-c copy 的 trim 可能落在非关键帧，P0 接受；精确剪辑模板用重编码版本 trim_exact
```

> ⚠️ **永不接受自由命令行**。`media_process` 的 schema 里没有 `args: string` 这种逃生门——这是防止 prompt injection 让 agent 执行 `ffmpeg -i http://evil...` 或读项目外文件的关键（架构文档 ADR-2 安全要点）。

### 4.5 生成模型调用

**gpt-image-2（OpenAI）**：

```ts
// P0 同步调用即可（图片一般 <60s）；P1 换 background 模式
const res = await openai.images.generate({
  model: "gpt-image-2",
  prompt,
  size: params.size ?? "1024x1024",
  quality: params.quality ?? "high",
})
// 返回 b64 → 写文件 → 返回路径
```

**Seedance 2.0（火山方舟）任务制**：

```ts
// 1) 创建任务
const task = await ark.post("/contents/generations/tasks", {
  model: "seedance-2-0",
  content: [{ type: "text", text: prompt + ` --ratio ${ratio} --duration ${duration}` }],
})
// 2) 轮询 GET /contents/generations/tasks/{id}，间隔 5s，上限 15min
// 3) succeeded → 取 video_url → 下载落盘
```

> 注意 Ark 的视频 URL 是**临时签名 URL（约 24h 过期）**，必须在任务成功后立即下载落盘，不能只存 URL。这一点 P0/P1 都适用。

### 4.6 挂载与 creator agent 配置（详见 §7 完整样例）

`opencode.json` 挂载（格式已核对 `src/mcp/index.ts`）：

```json
{
  "mcp": {
    "media": {
      "type": "local",
      "command": ["node", "/abs/path/opencode-media-mcp/dist/index.js"],
      "enabled": true,
      "environment": {
        "OPENAI_API_KEY": "{env:OPENAI_API_KEY}",
        "ARK_API_KEY": "{env:ARK_API_KEY}"
      }
    }
  }
}
```

挂载后工具以 `media_*` 前缀进入 ToolRegistry（经 `McpCatalog.toolName(name, tool.name)`，即 `media_media_probe` 形式——**注意 P0 工具命名会带 server 名前缀**，server 名起短一点，比如叫 `media`，工具就是 `media_media_probe`；如果嫌难看，server 名起 `m`，工具 `m_media_probe`。P1 内置后无前缀问题。）

### 4.7 P0 验收标准

1. `opencode` 会话中：「把 input.mp4 前 10 秒剪出来」→ agent 调 `media_process(trim)` → 产物出现在 `.opencode/media/`
2. 「生成一张赛博朋克风格的封面图 1024x1024」→ gpt-image-2 出图落盘
3. 「用 Seedance 生成 5 秒 16:9 的海浪视频」→ 任务轮询完成、视频落盘、本地可播
4. 让 agent「读取 /etc/passwd 转成视频」→ 路径校验拒绝（安全用例）

---

## 5. P1 实施：内核产品化

### 5.1 新增模块 `packages/opencode/src/media/`

```
src/media/
  ffmpeg.ts      # FFmpegService（Effect Layer）：二进制解析（env → 随包 → PATH）、队列、取消
  templates.ts   # 从 P0 平移，改为 Effect Schema 校验
  provider.ts    # MediaProvider 接口 + 注册表
  providers/
    openai.ts    # gpt-image-2，background 模式
    ark.ts       # Seedance 2.0
  library.ts     # MediaLibrary：落盘 + media_asset 表读写
```

依赖方向遵守仓库约束：`media` 只依赖 `@opencode-ai/core`（Schema/数据库/Effect 设施）和本包内模块，**不依赖 server**；工具层（`src/tool/media_*`）依赖 media。

### 5.2 MediaProvider 接口（对齐 ADR-3）

```ts
export interface MediaProvider {
  readonly id: string
  readonly generateImage: (req: ImageRequest) => Effect.Effect<ImageJob, MediaError>
  readonly generateVideo: (req: VideoRequest) => Effect.Effect<VideoJob, MediaError>
  readonly poll: (job: Job) => Effect.Effect<JobStatus, MediaError>
}

type JobStatus =
  | { state: "queued" | "running"; progress?: number }
  | { state: "succeeded"; url: string }        // 统一语义：拿到临时 URL，由 Library 负责下载落盘
  | { state: "failed"; error: string }
```

- 图片也建模为 Job（gpt-image-2 `background: true` 返回任务句柄），统一轮询路径
- 密钥解析：复用 `src/provider/auth.ts` 的存储，新增 provider id `openai-images`（或复用 `openai`）、`volcengine-ark`
- 成本估算：每个 provider 实现 `estimateCost(req)`，结果写入 `media_asset.cost_usd_estimate`（注意字段名只是估算值，命名要诚实）

### 5.3 内置工具（`src/tool/`）

新增 4 个文件 + 对应 `.txt` 描述，在 `registry.ts` 注册（参照现有 `WebFetchTool` 的注册方式）：

```ts
export const MediaGenerateVideoTool = Tool.define("media_generate_video", async () => {
  const description = await Bun.file(new URL("./media_generate_video.txt", import.meta.url)).text()
  return {
    description,
    parameters: Schema.Struct({
      prompt: Schema.String,
      duration: Schema.optional(Schema.Number),   // 秒，1–12
      ratio: Schema.optional(Schema.Literal("16:9", "9:16", "1:1")),
      model: Schema.optional(Schema.String),
    }),
    execute: (args, ctx) => Effect.gen(function* () {
      yield* ctx.ask({ permission: "media_generate_video", patterns: [args.model ?? "default"], metadata: { duration: args.duration } })
      const job = yield* (yield* MediaProviders.Service).submit(args)
      const status = yield* BackgroundJob.track(job, pollEvery("5s", "15m"))
      const asset = yield* (yield* MediaLibrary.Service).ingest(status.url, { prompt: args.prompt, ... })
      return {
        title: `Generated video (${args.duration ?? 5}s)`,
        metadata: { asset_id: asset.id, cost: asset.cost_usd_estimate },
        output: `Video saved to ${asset.path}`,
        attachments: [{ type: "file", mime: "video/mp4", url: asset.serveUrl, filename: asset.filename }],
      }
    }),
  }
})
```

要点：
- `ctx.ask` 挂权限（规则键 `media_generate_video` 等，见 §7 权限样例）——P1 相比 P0 的核心增量
- 长任务交给 `src/background/job`，会话内显示进度；取消会话 → abort → 停止轮询（远端任务是否取消取决于 provider 能力，Ark 支持删除任务，OpenAI background 支持 cancel，都要实现 `cancel(job)`）
- `attachments` 回流会话（`ExecuteResult.attachments`，类型 `SessionV1.FilePart`），**url 用 server 地址而非 data URL**（§8.1）

### 5.4 存储：`media_asset` 表

`packages/core` 新增迁移（snake_case 列名，遵守 AGENTS.md Drizzle 规范）：

```ts
export const media_asset = sqliteTable("media_asset", {
  id: text().primaryKey(),
  project_id: text().notNull(),
  path: text().notNull(),              // 项目相对路径
  kind: text().notNull(),              // "image" | "video"
  mime: text().notNull(),
  bytes: integer().notNull(),
  width: integer(),
  height: integer(),
  duration_ms: integer(),
  source: text().notNull(),            // "generate" | "process"
  model: text(),                       // gpt-image-2 / seedance-2-0 / ffmpeg
  prompt: text(),
  params: text(),                      // JSON
  job_id: text(),                      // provider 任务 id（重试对账用）
  cost_usd_estimate: real(),
  created_at: integer().notNull(),
})
```

> ⚠️ 删除文件时先删表记录再删文件（失败可重试）；反过来先删文件会留孤儿记录。提供 `media_prune` 工具做孤儿双向清理。

### 5.5 Server 端点（`src/server`）

| 端点 | 说明 |
|---|---|
| `GET /media?kind=&cursor=` | 媒体库列表（分页，按 created_at 倒序） |
| `GET /media/:id` | 单条元数据 |
| `GET /media/:id/content` | **流式内容**：必须支持 HTTP Range（`<video>` 拖动进度条依赖 206 响应） |
| `DELETE /media/:id` | 删除（走权限） |

实现细节：
- content 端点用 `Bun.file(path).stream()` 或直接返回 file handle，手动解析 `Range: bytes=start-end` 头；漏掉 Range 支持是最常见 bug
- `Content-Type` 从 `media_asset.mime` 取，不要靠后缀猜
- 路径拼接后做 `resolve` + 前缀校验，防 `../` 穿越（即便 id 来自数据库也要防注入式 id）

### 5.6 UI 视频渲染（`packages/session-ui`）

- `message-file.ts` 的 kind 判断扩展：`video/*` → `"video"`
- `message-part.tsx` 新增分支：kind 为 video 时渲染 `<video controls preload="metadata" src={part.url}>`，样式对齐现有 image（圆角、hairline overlay）
- **不要** autoplay；列表里有多个视频时 preload="metadata" 避免一次性拉全量
- 图片沿用现有 `<img>` 路径，无需改动

### 5.7 P1 验收标准

1. 生成视频触发权限弹窗（ask），拒绝后 agent 收到结构化拒绝
2. 会话中生成视频 → 后台任务进度可见 → 完成后视频内联可播、可拖动进度条

### 5.8 媒体任务与成本统计 API

媒体生成仍由 `creator` Agent 编排；结构化 API 作为任务控制面，不替换现有会话入口：

| 方法 | 路径 | 作用 |
|---|---|---|
| `GET` | `/media/tasks` | 列出当前项目实例中的媒体任务 |
| `GET` | `/media/task?id=<id>` | 查询单个媒体任务状态 |
| `DELETE` | `/media/task?id=<id>` | 取消运行中的媒体任务 |
| `GET` | `/media/stats` | 返回素材数量、磁盘占用、累计预估费用及按类型/模型/日期分组统计 |

所有请求继续使用 `directory` 查询参数完成项目路由和权限校验。任务状态统一为
`queued`、`running`、`completed`、`error`、`cancelled`，共享类型定义位于
`@opencode-ai/core/media/task`；当前进程内任务由 `BackgroundJob` 提供，重启恢复仍属于后续持久化工作。
3. 杀掉 server 进程再启动：`media_asset` 记录与磁盘文件一致，无孤儿
4. Ark 临时 URL 过期后重新打开会话：视频仍可播（证明落盘而非存 URL）

---

## 6. P2 实施：桌面端完整交付

### 6.1 ffmpeg 随包分发（`packages/desktop`）

1. **下载脚本** `packages/desktop/scripts/fetch-ffmpeg.ts`：按平台从 §1.1 渠道拉取、SHA256 校验（校验值硬编码在脚本里，防止供应链篡改）、解压到 `resources/ffmpeg/<platform>/`
2. **electron-builder 配置**：

```ts
// electron-builder.config.ts 追加
extraResources: [
  { from: `resources/ffmpeg/${platformDir}`, to: "ffmpeg", filter: ["ffmpeg*", "ffprobe*", "LICENSE*"] },
],
```

3. **运行时路径解析**（优先级）：`OPENCODE_MEDIA_FFMPEG` env → `process.resourcesPath/ffmpeg/ffmpeg` → PATH
   - 注意：打包后 ffmpeg 在 `resourcesPath`，**不在 asar 内**（二进制不能进 asar）
   - sidecar 启动时把解析结果通过 env 传给 opencode server（`src/main/sidecar.ts` 的 `prepareSidecarEnv` 是挂载点）
4. **macOS 签名/公证**：ffmpeg/ffprobe 也必须进签名清单（electron-builder 的 `asarUnpack` + `extraResources` 内二进制默认会被签，但要确认 entitlements 兼容）；公证失败最常见的报错就是未签名的辅助二进制
5. **Windows**：ffmpeg.exe + ffprobe.exe 放 `resources/ffmpeg/`，NSIS 安装器体积 +~35MB

### 6.2 媒体库视图与生成面板（`packages/app`）

- 新路由 `/media`：网格布局（图片缩略图 + 视频 hover 预览），筛选（kind/来源/日期），多选删除
- 生成面板：prompt 输入 + 参数（尺寸/比例/时长/模型）+ 成本预估显示 + 「发送到会话」按钮（把产物作为附件引用进对话）
- 会话内：视频 part 内联播放（P1 已完成）；图片点击放大（现有）
- creator agent 设为默认 agent；UI 隐藏 git/diff/IDE 入口（架构文档 §5.5 清单）
  - **已实现（内置化，无需用户配置）**：`creator` 为 `packages/opencode/src/agent/agent.ts` 内置 primary agent（`prompt/creator.txt`，白名单：media_* + read/glob/grep/list/webfetch/websearch/question），未配置 `default_agent` 时即为默认。`build` 设为 `hidden: true`（切换器不可见，`get("build")`/CLI 仍可用，用户可配置 `agent.build.hidden = false` 恢复）；`plan` **保留可见**——复杂视频创作可切到 plan agent 做分镜/脚本规划（edit 仅限 `.opencode/plans/*.md`），`plan_exit` 已从硬编码跳 build 改为**跳回进入 plan 前的执行 agent**（消息历史回溯，兜底 creator）。creator 被 disable 时回退链：plan（下一个可见 primary）。UI 隐藏点：项目菜单 workspaces 开关项（`layout.tsx` + `sidebar-project.tsx`）、预览面板 workspaces 分支、会话侧栏 Review/diff 页签（`session-side-panel.tsx` 的 `reviewTab` 恒 false），均只隐藏不删码；app 侧 `resolveAgent` 回退从 build 改为 creator

### 6.3 P2 验收标准

1. 全新机器（无系统 ffmpeg）安装 dmg/exe 后，转码模板可用
2. macOS 公证通过；Windows SmartScreen 无警告（有签名证书前提下）
3. 媒体库与会话数据一致（同一张 `media_asset` 表）

---

## 7. 配置样例全集（`opencode.json`）

```json
{
  "$schema": "https://opencode.ai/config.json",

  "mcp": {
    "media": {
      "type": "local",
      "command": ["node", "/abs/path/opencode-media-mcp/dist/index.js"],
      "enabled": true,
      "environment": {
        "OPENAI_API_KEY": "{env:OPENAI_API_KEY}",
        "ARK_API_KEY": "{env:ARK_API_KEY}"
      }
    }
  },

  "agent": {
    "creator": {
      "description": "AIGC 创作 agent：只暴露媒体与文件读取工具",
      "mode": "primary",
      "prompt": "{file:./prompts/creator.txt}",
      "tools": {
        "media_*": true,
        "read": true,
        "glob": true,
        "grep": true,
        "webfetch": true,
        "websearch": true,
        "write": false,
        "edit": false,
        "shell": false,
        "apply_patch": false,
        "lsp": false,
        "skill": false,
        "task": false,
        "todowrite": false,
        "question": true
      },
      "permission": {
        "media_generate_image": "ask",
        "media_generate_video": "ask",
        "media_process": "allow",
        "media_probe": "allow"
      }
    }
  }
}
```

说明：
- `tools` 的 glob 形式（`media_*`）按仓库现有 config 合并逻辑生效（`config.ts` 中 `result.tools` 转 allow/deny 规则）；确切支持的工具 id 以 `ToolRegistry.ids()` 为准
- `write` 关掉后 agent 无法写文件；如需「生成脚本保存到项目」场景，改为允许并在 permission 里限定路径模式
- 密钥**不写明文**，一律 `{env:...}` 引用

---

## 8. 注意事项与坑清单（动手前必读）

### 8.1 媒体不要走 base64 通道
- 现有附件链路是 data URL，5MB 上限（`src/image/image.ts` 的 `MAX_BASE64_BYTES`）；视频必然超限
- 一律「落盘 + URL 引用」，URL 指向 `/media/:id/content`；MCP 返回也只给路径，不给 base64

### 8.2 路径沙箱
- 所有媒体工具输入路径：项目相对路径 → `path.resolve(projectRoot, input)` → 必须以 projectRoot 为前缀，否则拒绝
- 复用 `external-directory` 权限机制处理「用户显式授权读项目外素材」的场景
- Windows 注意盘符与分隔符；CJK 路径在 ffmpeg argv 下无碍（spawn 不走 shell），但走 shell 字符串拼接就会炸——**只用 spawn 数组形式**

### 8.3 ffmpeg 调用的细节
- `-ss` 放在 `-i` 之前是快Seek（关键帧精度），之后是精确Seek（慢）；trim 模板默认快Seek + `-c copy`，需要帧精确时单独模板 `trim_exact`
- concat demuxer 要求输入同编码同参数；不同源先各自 transcode 再 concat（模板内部两步）
- stderr 是进度输出通道，不是错误通道；判失败看退出码，不看 stderr 内容
- 并发上限 2；队列满时返回明确错误而不是无限排队

### 8.4 生成 API 的细节
- Ark 视频 URL 约 24h 过期：任务成功后**立即下载**，落盘失败要把 job_id 记下来支持重试下载（不要重新生成，会重复扣费）
- gpt-image-2 的 `quality`/`size` 直接影响价格，权限确认弹窗的 metadata 里显示成本估算
- 轮询间隔 5s 起步、指数退避到 15s，总上限 15min；超时任务标记 `failed` 但保留 job_id 供人工对账
- 生成失败重试策略：网络错误可重试 2 次；内容审核（moderation）拒绝**不重试**，直接把拒绝原因透传给 agent

### 8.5 权限与费用
- `media_generate_*` 默认 `ask`；企业批量场景可改 `allow` 但配日配额（P2 做配额计数，按 `media_asset.cost_usd_estimate` 当日求和）
- ffmpeg 本地处理不收 API 费，但吃 CPU，仍建议 `media_process` 在长任务时挂后台任务显示进度

### 8.6 Electron 特有
- ffmpeg 不能进 asar；extraResources 路径在打包前后不同（`process.resourcesPath` vs `resources/`），用统一的解析函数处理
- sidecar 是无头 Node 环境（utilityProcess），**不要**依赖 Electron API；ffmpeg 路径由 main 进程解析后经 env 传入
- Windows 上 kill ffmpeg 进程树要用 `taskkill /pid <pid> /T /F`，`process.kill` 只杀父进程

### 8.7 会话与取消
- 会话 abort → 停止轮询 + 尝试 provider 端取消 + 删除 tmp 中间产物；**不删**已完成的产物（用户可能还要）
- 重试语义：同一 prompt 重发是新生成（生成模型无幂等键），工具描述里写清楚，避免 agent 自动重试导致重复扣费

### 8.8 合规
- ffmpeg LGPL：随附 LICENSE + 源码获取说明；静态链接时允许用户替换（提供「自定义 ffmpeg 路径」配置项即满足）
- libopenh264：随附 Cisco LICENSE
- 生成内容如面向中国大陆用户，P2 评估 C2PA/显式标识（架构文档开放问题 #3）

---

## 9. 测试策略

| 层 | 方法 | 覆盖点 |
|---|---|---|
| 模板纯函数 | 单元测试（bun test） | 每个模板的 argv 生成、参数校验拒绝非法输入 |
| 路径沙箱 | 单元测试 | `../`、绝对路径、Windows 盘符、CJK 路径 |
| ffmpeg 执行 | 集成测试（需本机 ffmpeg） | trim/transcode/gif 产物用 ffprobe 断言时长/分辨率 |
| 生成 provider | 契约测试 + `packages/http-recorder` 录制回放 | Ark 轮询状态机、OpenAI background 模式、URL 过期重下载 |
| 工具层 | 走真实 ToolRegistry（仓库惯例：不 mock） | 权限 ask/deny、附件回流、取消传播 |
| E2E | `packages/app/e2e` | P0 三条验收用例（§4.7） |

> 遵守仓库规则：测试从包目录运行（`packages/opencode`），不能从仓库根跑；typecheck 用 `bun typecheck`。

---

## 10. 交付 Checklist

**P0**
- [ ] `opencode-media-mcp` 四工具可用（probe/process/generate_image/generate_video）
- [ ] 模板白名单 ≥ 8 个，全部有 argv 单元测试
- [ ] 路径沙箱拒绝越界（含安全用例测试）
- [ ] `opencode.json` 挂载样例文档化
- [ ] creator agent 配置样例

**P1**
- [ ] 4 个内置工具注册进 ToolRegistry + `.txt` 描述
- [ ] `media_asset` 表迁移 + MediaLibrary 读写
- [ ] `/media` REST 端点（含 Range 流式）
- [ ] session-ui 视频 part 渲染
- [ ] 权限规则 + 后台任务进度
- [ ] Ark URL 过期重下载路径

**P2**
- [x] 三平台 ffmpeg 拉取脚本 + SHA256 校验
- [x] electron-builder extraResources + macOS 公证通过
- [x] 媒体库视图 + 生成面板
- [x] creator agent 默认化 + code 向 UI 入口隐藏
- [ ] 成本统计与（可选）日配额
