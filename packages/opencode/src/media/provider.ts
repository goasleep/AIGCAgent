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

/** fetch/解析失败统一映射为 MediaProviderError，保持 Interface 错误类型封闭 */
function tryFetch<A>(fn: () => Promise<A>): Effect.Effect<A, MediaProviderError> {
  return Effect.tryPromise({
    try: fn,
    catch: (error) =>
      new MediaProviderError({ detail: error instanceof Error ? error.message : String(error) }),
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
  /** 缺省时从 OPENAI_API_KEY 环境变量读取 */
  apiKey?: string
}

export function openai(opts: OpenAIOptions = {}): MediaProvider {
  return {
    id: "gpt-image-2",
    submitImage: (req) =>
      Effect.gen(function* () {
        const key = yield* requireKey(opts.apiKey ?? process.env.OPENAI_API_KEY, "config media.openai_api_key 或 OPENAI_API_KEY")
        const body = {
          model: "gpt-image-2",
          prompt: req.prompt,
          size: req.size === "auto" ? undefined : req.size,
          quality: req.quality,
          response_format: "b64_json",
        }
        const res = yield* tryFetch(() =>
          fetch("https://api.openai.com/v1/images/generations", {
            method: "POST",
            headers: jsonHeaders(key),
            body: JSON.stringify(body),
          }),
        )
        if (!res.ok) {
          const text = yield* Effect.promise(() => awaitText(res))
          return yield* new MediaProviderError({ detail: `OpenAI images API ${res.status}: ${text.slice(0, 500)}` })
        }
        const data = (yield* tryFetch(() => res.json())) as {
          data?: Array<{ b64_json?: string }>
        }
        // 图片用同步内联语义：b64 直接内联为 data URL 交给 Library 落盘
        const b64 = data.data?.[0]?.b64_json
        if (!b64) return yield* new MediaProviderError({ detail: "OpenAI 响应缺少 b64_json" })
        return { jobId: `inline:${b64}` }
      }),
    submitVideo: () => Effect.fail(new MediaProviderError({ detail: "gpt-image-2 不支持视频生成" })),
    poll: (jobId) => Effect.succeed({ state: "succeeded", url: jobId }),
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
  const arkBase = () => opts.baseUrl ?? process.env.ARK_BASE_URL ?? "https://ark.cn-beijing.volces.com/api/v3"
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
          req.first_frame
            ? { type: "image_url", image_url: { url: req.first_frame, role: "first_frame" } }
            : undefined,
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
        const res = yield* tryFetch(() =>
          fetch(taskUrl(jobId), { method: "DELETE", headers: jsonHeaders(key) }),
        )
        if (!res.ok && res.status !== 404) {
          const text = yield* Effect.promise(() => awaitText(res))
          return yield* new MediaProviderError({ detail: `Ark 取消任务 ${res.status}: ${text.slice(0, 500)}` })
        }
      }),
  }
}

export interface ProviderAuth {
  openai?: OpenAIOptions
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
    (opts.baseUrl ?? process.env.DASHSCOPE_BASE_URL ?? "https://dashscope.aliyuncs.com/api/v1").replace(/\/+$/, "")
  const model = () => opts.model ?? "wan3.0-video"
  const keyOf = () => requireKey(opts.apiKey ?? process.env.DASHSCOPE_API_KEY, "config media.dashscope_api_key 或 DASHSCOPE_API_KEY")
  return {
    id: model(),
    submitImage: () => Effect.fail(new MediaProviderError({ detail: `${model()} 不支持图片生成` })),
    submitVideo: (req) =>
      Effect.gen(function* () {
        const key = yield* keyOf()
        if (req.first_frame || req.last_frame) {
          return yield* new MediaProviderError({ detail: `${model()} 暂不支持首尾帧参考图，请改用 seedance 或 MiniMax` })
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
  const base = () => (opts.baseUrl ?? process.env.MINIMAX_BASE_URL ?? "https://api.minimax.io").replace(/\/+$/, "")
  const model = () => opts.model ?? "MiniMax-H3"
  const keyOf = () => requireKey(opts.apiKey ?? process.env.MINIMAX_API_KEY, "config media.minimax_api_key 或 MINIMAX_API_KEY")
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
        const res = yield* tryFetch(() => fetch(`${base()}/v2/query/video_generation/${jobId}`, { headers: jsonHeaders(key) }))
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
): Effect.Effect<MediaProvider, MediaProviderError> {
  if (!model || model === "gpt-image-2") return Effect.succeed(openai(auth.openai))
  if (model.startsWith("seedance")) return Effect.succeed(ark({ ...auth.ark, model }))
  if (model.startsWith("wan")) return Effect.succeed(dashscope({ ...auth.dashscope, model }))
  if (/^(minimax|hailuo)/i.test(model)) return Effect.succeed(minimax({ ...auth.minimax, model }))
  return Effect.fail(
    new MediaProviderError({
      detail: `不支持的媒体模型「${model}」（支持：gpt-image-2 生图；seedance* 走方舟；wan* 走 DashScope；MiniMax-H3/hailuo* 走 MiniMax）`,
    }),
  )
}

/** 轮询直到终态：5s 起步指数退避至 15s，总长上限 15min；远端失败不重试（审核拒绝直接透传） */
export function pollUntilDone(
  provider: MediaProvider,
  jobId: string,
  onTick?: (status: JobStatus) => Effect.Effect<void>,
) {
  return Effect.gen(function* () {
    const deadline = Date.now() + 15 * 60 * 1000
    let intervalMs = 5_000
    for (;;) {
      yield* Effect.sleep(intervalMs)
      intervalMs = Math.min(Math.round(intervalMs * 1.5), 15_000)
      const status = yield* provider.poll(jobId)
      if (onTick) yield* onTick(status)
      if (status.state === "succeeded") return status
      if (status.state === "failed") return yield* new MediaProviderError({ detail: status.error })
      if (Date.now() > deadline) {
        return yield* new MediaProviderError({
          detail: `轮询超时 15min（job_id=${jobId}，任务可能仍在跑，可凭 job_id 对账）`,
        })
      }
    }
  })
}

export * as MediaProvider from "./provider"
