import { Effect, Schema } from "effect"

export class MediaProviderError extends Schema.TaggedErrorClass<MediaProviderError>()("Media.ProviderError", {
  detail: Schema.String,
}) {
  override get message() {
    return this.detail
  }
}

export interface ImageRequest {
  prompt: string
  size: "1024x1024" | "1536x1024" | "1024x1536" | "auto"
  quality: "low" | "medium" | "high"
  /** Optional source image and mask as data URLs for image editing. */
  image?: string
  mask?: string
}

export interface VideoRequest {
  prompt: string
  duration: number
  ratio: "16:9" | "9:16" | "1:1"
  /** 首帧参考图（data URL 或 http(s) URL），用于选段重生成时与前段画面衔接 */
  first_frame?: string
  /** 尾帧参考图（data URL 或 http(s) URL），用于与后段画面衔接；仅部分 provider 支持 */
  last_frame?: string
}

export type JobStatus =
  | { state: "queued" | "running"; progress?: number }
  | { state: "succeeded"; url: string }
  | { state: "failed"; error: string }

/**
 * 媒体生成 provider 抽象（ADR-3）：与 LLM Provider 完全分离。
 * 统一「任务制」语义——图片也建模为 job，拿到临时 URL 后由 MediaLibrary 下载落盘。
 */
export interface MediaProvider {
  readonly id: string
  readonly submitImage: (req: ImageRequest) => Effect.Effect<{ jobId: string }, MediaProviderError>
  readonly submitVideo: (req: VideoRequest) => Effect.Effect<{ jobId: string }, MediaProviderError>
  readonly poll: (jobId: string) => Effect.Effect<JobStatus, MediaProviderError>
  readonly cancel: (jobId: string) => Effect.Effect<void, MediaProviderError>
}

// gpt-image 系官方单价（1024x1024，美元/张），仅作成本估算，随官方定价调整
const IMAGE_COST_USD: Record<string, number> = {
  "low:1024x1024": 0.02,
  "medium:1024x1024": 0.066,
  "high:1024x1024": 0.12,
}

export function estimateImageCost(req: ImageRequest): number | null {
  return IMAGE_COST_USD[`${req.quality}:${req.size}`] ?? null
}

const jsonHeaders = (key: string) => ({ "content-type": "application/json", authorization: `Bearer ${key}` })

function imageJobUrl(jobId: string): string {
  return jobId.startsWith("inline:") ? `data:image/png;base64,${jobId.slice("inline:".length)}` : jobId
}

/** fetch/解析失败统一映射为 MediaProviderError，保持 Interface 错误类型封闭 */
function tryFetch<A>(fn: () => Promise<A>): Effect.Effect<A, MediaProviderError> {
  return Effect.tryPromise({
    try: fn,
    catch: (error) => new MediaProviderError({ detail: error instanceof Error ? error.message : String(error) }),
  })
}

function requireKey(key: string | undefined, source: string): Effect.Effect<string, MediaProviderError> {
  if (!key) return Effect.fail(new MediaProviderError({ detail: `缺少 API 密钥（${source}）` }))
  return Effect.succeed(key)
}

async function awaitText(res: Response): Promise<string> {
  try {
    return await res.text()
  } catch {
    return ""
  }
}

export interface OpenAIOptions {
  /** 图片生成专用密钥；不读取对话推理链路的 OPENAI_API_KEY */
  apiKey?: string
  /** OpenAI-compatible base URL；缺省 https://api.openai.com/v1 */
  baseUrl?: string
}

export function providerBaseURL(value: string | undefined, fallback: string) {
  return (value?.trim() || fallback).replace(/\/+$/, "")
}

export function openai(opts: OpenAIOptions = {}): MediaProvider {
  const base = () =>
    providerBaseURL(opts.baseUrl, "https://api.openai.com/v1").replace(/\/images\/(generations|edits)$/, "")
  const dataUrlBlob = (value: string, fallbackMime: string) => {
    const match = /^data:([^;,]+)?;base64,(.+)$/s.exec(value)
    if (!match) return undefined
    return new Blob([Buffer.from(match[2], "base64")], { type: match[1] ?? fallbackMime })
  }
  return {
    id: "gpt-image-2",
    submitImage: (req) =>
      Effect.gen(function* () {
        const key = yield* requireKey(opts.apiKey, "config media.openai_api_key")
        const editing = req.image !== undefined
        if (!editing && req.mask !== undefined) {
          return yield* new MediaProviderError({ detail: "图片编辑必须同时提供 image 和 mask" })
        }
        const body = editing ? new FormData() : undefined
        if (body) {
          const source = req.image
          if (!source) return yield* new MediaProviderError({ detail: "图片编辑必须提供 image" })
          const image = dataUrlBlob(source, "image/png")
          if (!image) return yield* new MediaProviderError({ detail: "图片编辑的 image 必须是有效的 data URL" })
          body.set("model", "gpt-image-2")
          body.set("prompt", req.prompt)
          body.set("size", req.size === "auto" ? "1024x1024" : req.size)
          body.set("quality", req.quality)
          body.set("image", image, "input.png")
          if (req.mask !== undefined) {
            const mask = dataUrlBlob(req.mask, "image/png")
            if (!mask) return yield* new MediaProviderError({ detail: "图片编辑的 mask 必须是有效的 data URL" })
            body.set("mask", mask, "mask.png")
          }
        }
        const res = yield* tryFetch(() =>
          fetch(`${base()}/images/${editing ? "edits" : "generations"}`, {
            method: "POST",
            headers: editing ? { authorization: `Bearer ${key}` } : jsonHeaders(key),
            body:
              body ??
              JSON.stringify({
                model: "gpt-image-2",
                prompt: req.prompt,
                size: req.size === "auto" ? undefined : req.size,
                quality: req.quality,
              }),
          }),
        )
        if (!res.ok) {
          const text = yield* Effect.promise(() => awaitText(res))
          return yield* new MediaProviderError({ detail: `OpenAI images API ${res.status}: ${text.slice(0, 500)}` })
        }
        const data = (yield* tryFetch(() => res.json())) as {
          data?: Array<{ b64_json?: string; url?: string }>
        }
        // 图片用同步内联语义：b64 直接内联为 data URL 交给 Library 落盘
        const b64 = data.data?.[0]?.b64_json
        if (b64) return { jobId: `inline:${b64}` }
        const url = data.data?.[0]?.url
        if (url) return { jobId: url }
        return yield* new MediaProviderError({ detail: "OpenAI 响应缺少 b64_json 或图片 URL" })
      }),
    submitVideo: () => Effect.fail(new MediaProviderError({ detail: "gpt-image-2 不支持视频生成" })),
    poll: (jobId) => Effect.succeed({ state: "succeeded", url: imageJobUrl(jobId) }),
    cancel: () => Effect.void,
  }
}

export interface AgnesOptions {
  /** 缺省时从 AGNES_API_KEY 环境变量读取 */
  apiKey?: string
  /** 缺省 https://apihub.agnes-ai.com/v1 */
  baseUrl?: string
  /** 图片缺省 agnes-image-2.1-flash，视频统一使用 agnes-video-v2.0 */
  model?: string
}

/** Agnes 图片生成兼容 OpenAI Images API，但默认返回远程 URL。 */
export function agnes(opts: AgnesOptions = {}): MediaProvider {
  const base = () =>
    providerBaseURL(opts.baseUrl, process.env.AGNES_BASE_URL?.trim() || "https://apihub.agnes-ai.com/v1")
  const model = () => {
    if (opts.model?.startsWith("agnes-video")) return "agnes-video-v2.0"
    if (opts.model === "agnes-image" || opts.model === "agnes-image-2.0" || opts.model === "agnes-image-2.0-flash") {
      return "agnes-image-2.1-flash"
    }
    return opts.model ?? "agnes-image-2.1-flash"
  }
  const isVideo = () => model() === "agnes-video-v2.0"
  const videoRoot = () => base().replace(/\/v1$/, "")
  return {
    id: model(),
    submitImage: (req) =>
      Effect.gen(function* () {
        if (isVideo()) return yield* new MediaProviderError({ detail: `${model()} 不支持图片生成` })
        if (req.image || req.mask) return yield* new MediaProviderError({ detail: "Agnes 当前不支持图片编辑" })
        const key = yield* requireKey(
          opts.apiKey ?? process.env.AGNES_API_KEY,
          "config media.agnes_api_key 或 AGNES_API_KEY",
        )
        const res = yield* tryFetch(() =>
          fetch(`${base()}/images/generations`, {
            method: "POST",
            headers: jsonHeaders(key),
            body: JSON.stringify({
              model: model(),
              prompt: req.prompt,
              n: 1,
              size: req.size === "auto" ? "1024x1024" : req.size,
            }),
          }),
        )
        if (!res.ok) {
          const text = yield* Effect.promise(() => awaitText(res))
          return yield* new MediaProviderError({ detail: `Agnes images API ${res.status}: ${text.slice(0, 500)}` })
        }
        const data = (yield* tryFetch(() => res.json())) as {
          data?: Array<{ url?: string; b64_json?: string }>
        }
        const image = data.data?.[0]
        if (image?.url) return { jobId: image.url }
        if (image?.b64_json) return { jobId: `inline:${image.b64_json}` }
        return yield* new MediaProviderError({ detail: "Agnes 响应缺少图片 URL" })
      }),
    submitVideo: (req) =>
      Effect.gen(function* () {
        if (!isVideo()) return yield* new MediaProviderError({ detail: `${model()} 不支持视频生成` })
        const key = yield* requireKey(
          opts.apiKey ?? process.env.AGNES_API_KEY,
          "config media.agnes_api_key 或 AGNES_API_KEY",
        )
        const dimensions =
          req.ratio === "9:16"
            ? { width: 768, height: 1365 }
            : req.ratio === "1:1"
              ? { width: 1024, height: 1024 }
              : { width: 1152, height: 648 }
        const numFrames = 8 * Math.max(1, Math.round((req.duration * 24 - 1) / 8)) + 1
        if ([req.first_frame, req.last_frame].some((value) => value && !/^https?:\/\//.test(value))) {
          return yield* new MediaProviderError({
            detail:
              "Agnes 视频参考帧需要 HTTP(S) 图片地址；当前接口不支持本地或 base64 参考帧，请选择支持参考帧的媒体模型。",
          })
        }
        const images = [req.first_frame, req.last_frame].filter(
          (value): value is string => typeof value === "string" && /^https?:\/\//.test(value),
        )
        const res = yield* tryFetch(() =>
          fetch(`${base()}/videos`, {
            method: "POST",
            headers: jsonHeaders(key),
            body: JSON.stringify({
              model: model(),
              prompt: req.prompt,
              ...dimensions,
              num_frames: numFrames,
              frame_rate: 24,
              ...(images.length === 1
                ? { image: images[0] }
                : images.length > 1
                  ? { extra_body: { image: images } }
                  : {}),
            }),
          }),
        )
        if (!res.ok) {
          const text = yield* Effect.promise(() => awaitText(res))
          return yield* new MediaProviderError({ detail: `Agnes videos API ${res.status}: ${text.slice(0, 500)}` })
        }
        const body = (yield* tryFetch(() => res.json())) as { video_id?: string; task_id?: string; id?: string }
        const jobId = body.video_id ?? body.task_id ?? body.id
        if (!jobId) return yield* new MediaProviderError({ detail: "Agnes 响应缺少 video_id" })
        return { jobId }
      }),
    poll: (jobId) =>
      Effect.gen(function* () {
        if (!isVideo()) return { state: "succeeded" as const, url: imageJobUrl(jobId) }
        const key = yield* requireKey(
          opts.apiKey ?? process.env.AGNES_API_KEY,
          "config media.agnes_api_key 或 AGNES_API_KEY",
        )
        const query = new URLSearchParams({ video_id: jobId, model_name: model() })
        const res = yield* tryFetch(() => fetch(`${videoRoot()}/agnesapi?${query}`, { headers: jsonHeaders(key) }))
        if (!res.ok) {
          const text = yield* Effect.promise(() => awaitText(res))
          return yield* new MediaProviderError({ detail: `Agnes 视频轮询 ${res.status}: ${text.slice(0, 500)}` })
        }
        const body = (yield* tryFetch(() => res.json())) as {
          status?: string
          progress?: number
          url?: string
          video_url?: string
          error?: string | { message?: string }
        }
        if (body.status === "completed" || body.status === "succeeded") {
          const url = body.url ?? body.video_url
          if (!url) return yield* new MediaProviderError({ detail: "Agnes 视频任务成功但缺少 URL" })
          return { state: "succeeded" as const, url }
        }
        if (body.status === "failed" || body.status === "cancelled") {
          return {
            state: "failed" as const,
            error: typeof body.error === "string" ? body.error : (body.error?.message ?? body.status),
          }
        }
        return { state: "running" as const, progress: body.progress }
      }),
    cancel: () => Effect.void,
  }
}

export interface ArkOptions {
  /** 缺省时从 ARK_API_KEY 环境变量读取 */
  apiKey?: string
  /** 缺省时从 ARK_BASE_URL 环境变量读取 */
  baseUrl?: string
  /** 模型名，缺省 seedance-2-0 */
  model?: string
}

export function ark(opts: ArkOptions = {}): MediaProvider {
  const arkBase = () =>
    providerBaseURL(opts.baseUrl, process.env.ARK_BASE_URL?.trim() || "https://ark.cn-beijing.volces.com/api/v3")
  const model = () => opts.model ?? "seedance-2-0"
  const taskUrl = (jobId: string) => `${arkBase()}/contents/generations/tasks/${jobId}`
  return {
    id: model(),
    submitImage: () => Effect.fail(new MediaProviderError({ detail: `${model()} 不支持图片生成` })),
    submitVideo: (req) =>
      Effect.gen(function* () {
        const key = yield* requireKey(opts.apiKey ?? process.env.ARK_API_KEY, "config media.ark_api_key 或 ARK_API_KEY")
        // seedance 首尾帧：image_url.role 标记 first_frame / last_frame，URL 与 base64 data URL 均可
        const frames = [
          req.first_frame ? { type: "image_url", image_url: { url: req.first_frame, role: "first_frame" } } : undefined,
          req.last_frame ? { type: "image_url", image_url: { url: req.last_frame, role: "last_frame" } } : undefined,
        ].filter((item) => item !== undefined)
        const res = yield* tryFetch(() =>
          fetch(`${arkBase()}/contents/generations/tasks`, {
            method: "POST",
            headers: jsonHeaders(key),
            body: JSON.stringify({
              model: model(),
              content: [
                { type: "text", text: `${req.prompt} --ratio ${req.ratio} --duration ${req.duration}` },
                ...frames,
              ],
            }),
          }),
        )
        if (!res.ok) {
          const text = yield* Effect.promise(() => awaitText(res))
          return yield* new MediaProviderError({ detail: `Ark 创建任务 ${res.status}: ${text.slice(0, 500)}` })
        }
        const body = (yield* tryFetch(() => res.json())) as { id?: string }
        if (!body.id) return yield* new MediaProviderError({ detail: "Ark 响应缺少任务 id" })
        return { jobId: body.id }
      }),
    poll: (jobId) =>
      Effect.gen(function* () {
        const key = yield* requireKey(opts.apiKey ?? process.env.ARK_API_KEY, "config media.ark_api_key 或 ARK_API_KEY")
        const res = yield* tryFetch(() => fetch(taskUrl(jobId), { headers: jsonHeaders(key) }))
        if (!res.ok) {
          const text = yield* Effect.promise(() => awaitText(res))
          return yield* new MediaProviderError({ detail: `Ark 轮询 ${res.status}: ${text.slice(0, 500)}` })
        }
        const body = (yield* tryFetch(() => res.json())) as {
          status?: string
          content?: { video_url?: string }
          error?: { message?: string }
        }
        const state = body.status ?? "queued"
        if (state === "succeeded") {
          const url = body.content?.video_url
          if (!url) return yield* new MediaProviderError({ detail: "Ark 任务成功但缺少 video_url" })
          return { state: "succeeded" as const, url }
        }
        if (state === "failed" || state === "cancelled") {
          return { state: "failed" as const, error: body.error?.message ?? state }
        }
        return { state: "queued" as const }
      }),
    cancel: (jobId) =>
      Effect.gen(function* () {
        const key = yield* requireKey(opts.apiKey ?? process.env.ARK_API_KEY, "config media.ark_api_key 或 ARK_API_KEY")
        const res = yield* tryFetch(() => fetch(taskUrl(jobId), { method: "DELETE", headers: jsonHeaders(key) }))
        if (!res.ok && res.status !== 404) {
          const text = yield* Effect.promise(() => awaitText(res))
          return yield* new MediaProviderError({ detail: `Ark 取消任务 ${res.status}: ${text.slice(0, 500)}` })
        }
      }),
  }
}

export interface ProviderAuth {
  openai?: OpenAIOptions
  agnes?: AgnesOptions
  ark?: ArkOptions
  dashscope?: DashScopeOptions
  minimax?: MiniMaxOptions
}

export interface DashScopeOptions {
  /** 缺省时从 DASHSCOPE_API_KEY 环境变量读取 */
  apiKey?: string
  /** 缺省 https://dashscope.aliyuncs.com/api/v1；Wan3 部分账号需用业务空间域名 https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/api/v1 */
  baseUrl?: string
  /** 模型名，缺省 wan3.0-video */
  model?: string
}

/** 阿里百炼 DashScope 异步任务制（万相 Wan 系）。Wan3 接入点见 ADR/文档；取消接口未公开，cancel 为 no-op。 */
export function dashscope(opts: DashScopeOptions = {}): MediaProvider {
  const base = () =>
    providerBaseURL(opts.baseUrl, process.env.DASHSCOPE_BASE_URL?.trim() || "https://dashscope.aliyuncs.com/api/v1")
  const model = () => opts.model ?? "wan3.0-video"
  const keyOf = () =>
    requireKey(opts.apiKey ?? process.env.DASHSCOPE_API_KEY, "config media.dashscope_api_key 或 DASHSCOPE_API_KEY")
  return {
    id: model(),
    submitImage: () => Effect.fail(new MediaProviderError({ detail: `${model()} 不支持图片生成` })),
    submitVideo: (req) =>
      Effect.gen(function* () {
        const key = yield* keyOf()
        if (req.first_frame || req.last_frame) {
          return yield* new MediaProviderError({
            detail: `${model()} 暂不支持首尾帧参考图，请改用 seedance 或 MiniMax`,
          })
        }
        const res = yield* tryFetch(() =>
          fetch(`${base()}/services/aigc/video-generation/video-synthesis`, {
            method: "POST",
            headers: { ...jsonHeaders(key), "X-DashScope-Async": "enable" },
            body: JSON.stringify({
              model: model(),
              input: { prompt: req.prompt },
              parameters: { resolution: "720P", ratio: req.ratio, duration: req.duration, watermark: false },
            }),
          }),
        )
        if (!res.ok) {
          const text = yield* Effect.promise(() => awaitText(res))
          return yield* new MediaProviderError({ detail: `DashScope 创建任务 ${res.status}: ${text.slice(0, 500)}` })
        }
        const body = (yield* tryFetch(() => res.json())) as { output?: { task_id?: string }; task_id?: string }
        const taskId = body.output?.task_id ?? body.task_id
        if (!taskId) return yield* new MediaProviderError({ detail: "DashScope 响应缺少 task_id" })
        return { jobId: taskId }
      }),
    poll: (jobId) =>
      Effect.gen(function* () {
        const key = yield* keyOf()
        const res = yield* tryFetch(() => fetch(`${base()}/tasks/${jobId}`, { headers: jsonHeaders(key) }))
        if (!res.ok) {
          const text = yield* Effect.promise(() => awaitText(res))
          return yield* new MediaProviderError({ detail: `DashScope 轮询 ${res.status}: ${text.slice(0, 500)}` })
        }
        const body = (yield* tryFetch(() => res.json())) as {
          output?: { task_status?: string; video_url?: string; message?: string }
        }
        const status = body.output?.task_status ?? "PENDING"
        if (status === "SUCCEEDED") {
          const url = body.output?.video_url
          if (!url) return yield* new MediaProviderError({ detail: "DashScope 任务成功但缺少 video_url" })
          return { state: "succeeded" as const, url }
        }
        if (status === "FAILED" || status === "CANCELED") {
          return { state: "failed" as const, error: body.output?.message ?? status }
        }
        return { state: "queued" as const }
      }),
    cancel: () => Effect.void,
  }
}

export interface MiniMaxOptions {
  /** 缺省时从 MINIMAX_API_KEY 环境变量读取 */
  apiKey?: string
  /** 不含版本后缀，缺省 https://api.minimax.io；国内：https://api.minimax.cn */
  baseUrl?: string
  /** 模型名，缺省 MiniMax-H3（V2 接口） */
  model?: string
}

/** MiniMax Hailuo 视频 V2 任务制（H3 系，4–15s，768P/2K）。取消接口未公开，cancel 为 no-op。 */
export function minimax(opts: MiniMaxOptions = {}): MediaProvider {
  const base = () => providerBaseURL(opts.baseUrl, process.env.MINIMAX_BASE_URL?.trim() || "https://api.minimax.io")
  const model = () => opts.model ?? "MiniMax-H3"
  const keyOf = () =>
    requireKey(opts.apiKey ?? process.env.MINIMAX_API_KEY, "config media.minimax_api_key 或 MINIMAX_API_KEY")
  return {
    id: model(),
    submitImage: () => Effect.fail(new MediaProviderError({ detail: `${model()} 不支持图片生成` })),
    submitVideo: (req) =>
      Effect.gen(function* () {
        const key = yield* keyOf()
        if (req.last_frame) {
          return yield* new MediaProviderError({ detail: `${model()} 仅支持首帧参考图，不支持尾帧` })
        }
        // H3 时长合法区间 [4,15]，超出直接钳制，避免参数错误整单失败
        const duration = Math.min(Math.max(Math.round(req.duration), 4), 15)
        const res = yield* tryFetch(() =>
          fetch(`${base()}/v2/video_generation`, {
            method: "POST",
            headers: jsonHeaders(key),
            body: JSON.stringify({
              model: model(),
              content: [{ type: "text", text: req.prompt }],
              ...(req.first_frame ? { first_frame_image: req.first_frame } : {}),
              resolution: "768P",
              duration,
              ratio: req.ratio,
            }),
          }),
        )
        if (!res.ok) {
          const text = yield* Effect.promise(() => awaitText(res))
          return yield* new MediaProviderError({ detail: `MiniMax 创建任务 ${res.status}: ${text.slice(0, 500)}` })
        }
        const body = (yield* tryFetch(() => res.json())) as { task_id?: string }
        if (!body.task_id) return yield* new MediaProviderError({ detail: "MiniMax 响应缺少 task_id" })
        return { jobId: body.task_id }
      }),
    poll: (jobId) =>
      Effect.gen(function* () {
        const key = yield* keyOf()
        const res = yield* tryFetch(() =>
          fetch(`${base()}/v2/query/video_generation/${jobId}`, { headers: jsonHeaders(key) }),
        )
        if (!res.ok) {
          const text = yield* Effect.promise(() => awaitText(res))
          return yield* new MediaProviderError({ detail: `MiniMax 轮询 ${res.status}: ${text.slice(0, 500)}` })
        }
        const body = (yield* tryFetch(() => res.json())) as {
          task?: { status?: string; content?: { url?: string }; error?: string }
        }
        const status = body.task?.status ?? "queued"
        if (status === "succeeded") {
          const url = body.task?.content?.url
          if (!url) return yield* new MediaProviderError({ detail: "MiniMax 任务成功但缺少 content.url" })
          return { state: "succeeded" as const, url }
        }
        if (status === "failed" || status === "cancelled") {
          return { state: "failed" as const, error: body.task?.error ?? status }
        }
        return { state: "queued" as const }
      }),
    cancel: () => Effect.void,
  }
}

export function resolveProvider(
  model: string | undefined,
  auth: ProviderAuth = {},
  kind: "image" | "video" = "image",
): Effect.Effect<MediaProvider, MediaProviderError> {
  if (!model) {
    if (auth.agnes?.apiKey) return Effect.succeed(agnes(auth.agnes))
    return Effect.succeed(openai(auth.openai))
  }
  if (model === "gpt-image-2") {
    return Effect.succeed(openai(auth.openai))
  }
  if (model === "agnes")
    return Effect.succeed(
      agnes({ ...auth.agnes, model: kind === "video" ? "agnes-video-v2.0" : "agnes-image-2.1-flash" }),
    )
  if (model.startsWith("agnes-image")) return Effect.succeed(agnes({ ...auth.agnes, model }))
  if (model.startsWith("agnes-video")) return Effect.succeed(agnes({ ...auth.agnes, model }))
  if (model.startsWith("seedance")) {
    if (!auth.ark?.apiKey && auth.agnes?.apiKey)
      return Effect.succeed(agnes({ ...auth.agnes, model: "agnes-video-v2.0" }))
    return Effect.succeed(ark({ ...auth.ark, model }))
  }
  if (model.startsWith("wan")) return Effect.succeed(dashscope({ ...auth.dashscope, model }))
  if (model.toLowerCase() === "h3") return Effect.succeed(minimax({ ...auth.minimax, model: "MiniMax-H3" }))
  if (/^(minimax|hailuo)/i.test(model)) return Effect.succeed(minimax({ ...auth.minimax, model }))
  return Effect.fail(
    new MediaProviderError({
      detail: `不支持的媒体模型「${model}」（支持：gpt-image-2/agnes-image* 生图；seedance* 走方舟；agnes-video* 视频；wan* 走 DashScope；MiniMax-H3/hailuo* 走 MiniMax）`,
    }),
  )
}

/** 立即检查终态；未完成时从 5s 指数退避至 15s，总长上限 15min。 */
export function pollUntilDone(
  provider: MediaProvider,
  jobId: string,
  onTick?: (status: JobStatus) => Effect.Effect<void>,
) {
  return Effect.gen(function* () {
    const deadline = Date.now() + 15 * 60 * 1000
    let intervalMs = 5_000
    for (;;) {
      const status = yield* provider.poll(jobId)
      if (onTick) yield* onTick(status)
      if (status.state === "succeeded") return status
      if (status.state === "failed") return yield* new MediaProviderError({ detail: status.error })
      if (Date.now() > deadline) {
        return yield* new MediaProviderError({
          detail: `轮询超时 15min（job_id=${jobId}，任务可能仍在跑，可凭 job_id 对账）`,
        })
      }
      yield* Effect.sleep(intervalMs)
      intervalMs = Math.min(Math.round(intervalMs * 1.5), 15_000)
    }
  })
}

export * as MediaProvider from "./provider"
