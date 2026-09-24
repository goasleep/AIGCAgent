import { Effect, Schema } from "effect"
import path from "path"
import { mkdir, readdir, readFile, rm, writeFile } from "fs/promises"
import * as Tool from "./tool"
import { Identifier } from "@/id/id"
import { InstanceState } from "@/effect/instance-state"
import { BackgroundJob } from "@/background/job"
import { Config } from "@/config/config"
import { ConfigMediaV1 } from "@opencode-ai/core/v1/config/media"
import { MediaFFmpeg } from "@/media/ffmpeg"
import { MediaLibrary } from "@/media/library"
import {
  estimateImageCost,
  MediaProviderError,
  pollUntilDone,
  resolveProvider,
  type ImageRequest,
  type JobStatus,
  type ProviderAuth,
  type VideoRequest,
} from "@/media/provider"
import { mediaTmpDir, resolveInside } from "@/media/paths"
import type { InstanceContext } from "@/project/instance-context"
import { templates, type TemplateContext } from "@/media/templates"
import { MediaPreview } from "@/media/preview"

const HARD_TIMEOUT_MS = 30 * 60 * 1000
const DEFAULT_KIND_TIMEOUT = { image: 60_000, video: 600_000 } as const

function normalizeImageSize(value: string | undefined): ImageRequest["size"] {
  if (!value) return "1024x1024"
  if (value === "auto" || value === "1024x1024" || value === "1536x1024" || value === "1024x1536") return value
  const match = /^(\d+)\s*[x×:]\s*(\d+)$/i.exec(value.trim())
  if (!match) return "1024x1024"
  const width = Number(match[1])
  const height = Number(match[2])
  if (!width || !height) return "1024x1024"
  const ratio = width / height
  if (ratio > 1.2) return "1536x1024"
  if (ratio < 0.8) return "1024x1536"
  return "1024x1024"
}

/** 与 server /media/content 路由一致：query 形式，directory 用于项目归属校验 */
export function contentUrl(directory: string, id: string, filePath?: string): string {
  if (filePath) {
    return `/file/content?directory=${encodeURIComponent(directory)}&path=${encodeURIComponent(filePath)}&id=${encodeURIComponent(id)}`
  }
  return `/media/content?directory=${encodeURIComponent(directory)}&id=${encodeURIComponent(id)}`
}

function baseName(p: string): string {
  return p.split("/").pop() ?? p
}

type ProcessMetadata = { template: string; frames: number | null; asset_id: string | null }
type GenerateImageMetadata = { asset_id: string; cost_usd_estimate: number | null }
type GenerateVideoMetadata = { asset_id: string; job_id: string | null }

function schedulePreview(
  jobs: BackgroundJob.Interface,
  previews: MediaPreview.Interface,
  file: string,
  assetID: string,
) {
  return jobs.start({
    type: "media_preview",
    title: "Preparing media preview",
    metadata: { asset_id: assetID },
    run: previews.get(file).pipe(Effect.as("preview")),
  })
}

function authFrom(media: Schema.Schema.Type<typeof ConfigMediaV1.Info> | undefined): ProviderAuth {
  return {
    openai: { apiKey: media?.openai_api_key, baseUrl: media?.openai_base_url },
    agnes: { apiKey: media?.agnes_api_key, baseUrl: media?.agnes_base_url },
    ark: { apiKey: media?.ark_api_key, baseUrl: media?.ark_base_url },
    dashscope: { apiKey: media?.dashscope_api_key, baseUrl: media?.dashscope_base_url },
    minimax: { apiKey: media?.minimax_api_key, baseUrl: media?.minimax_base_url },
  }
}

/** 下载产物：网络/HTTP 错误重试 2 次（1s/2s 退避）；job_id 已入库，重试不会产生重复扣费 */
async function downloadTo(url: string, target: string): Promise<void> {
  const attempts = [0, 1_000, 2_000]
  let lastError: unknown
  for (const delay of attempts) {
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay))
    try {
      const res = await fetch(url)
      if (!res.ok) throw new Error(`下载产物 ${res.status}`)
      await writeFile(target, Buffer.from(await res.arrayBuffer()))
      return
    } catch (error) {
      lastError = error
    }
  }
  throw lastError
}

const FRAME_MIME: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg" }
const REFERENCE_MIME = new Set(Object.values(FRAME_MIME))

export interface MediaRef {
  /** 绝对路径，ffmpeg / 参考图读取用 */
  path: string
  mime: string | null
  asset: MediaLibrary.Asset | undefined
}

/**
 * 解析素材引用：`med_` 开头按媒体库素材 id 解析（校验项目归属），其余按项目相对路径。
 * 让 agent 能直接引用 media_list 返回的素材 id，而不必先知道磁盘路径。
 */
function resolveMediaRef(instance: InstanceContext, library: MediaLibrary.Interface, ref: string) {
  return Effect.gen(function* () {
    if (!ref.startsWith("med_")) {
      return { path: resolveInside(instance.directory, ref), mime: null, asset: undefined }
    }
    const asset = yield* library.get(ref)
    if (!asset || asset.project_id !== instance.project.id) {
      throw new Error(`媒体库中不存在素材 ${ref}，可先用 media_list 查询；或改传项目相对路径`)
    }
    return { path: yield* library.absolute(instance.directory, asset), mime: asset.mime, asset }
  })
}

/** 读取参考帧图片为 data URL，随生成请求一并提交给 provider */
function frameDataUrl(ref: MediaRef) {
  return Effect.gen(function* () {
    const mime = ref.mime && REFERENCE_MIME.has(ref.mime) ? ref.mime : FRAME_MIME[path.extname(ref.path).toLowerCase()]
    if (!mime) throw new Error(`参考帧仅支持 png/jpg`)
    const bytes = yield* Effect.tryPromise(() =>
      readFile(ref.path).then((value) => value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength)),
    )
    return `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`
  })
}

const ProbeParameters = Schema.Struct({
  path: Schema.String.annotate({ description: "Project-relative media file path" }),
})

const ProcessParameters = Schema.Struct({
  template: Schema.String.annotate({
    description:
      "Template name: transcode/trim/trim_exact/concat/extract_frames/watermark/make_gif/resize_image/thumbnail",
  }),
  inputs: Schema.Array(Schema.String).annotate({
    description: "Input media as project-relative paths or media library asset ids (med_...) (1–20)",
  }),
  output: Schema.String.annotate({ description: "Project-relative output path" }),
  params: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)).annotate({
    description: "Template-specific parameters (see template descriptions); may include timeout_ms",
  }),
})

const GenerateImageParameters = Schema.Struct({
  prompt: Schema.String.annotate({ description: "Image prompt" }),
  image: Schema.optional(Schema.String).annotate({
    description:
      "Source image for editing: media library asset id (med_...) or project-relative path (png/jpg); omit for text-to-image generation",
  }),
  mask: Schema.optional(Schema.String).annotate({
    description:
      "Transparent mask (png) for editing selected areas: media library asset id (med_...) or project-relative path",
  }),
  size: Schema.optional(
    Schema.String.annotate({
      description: "Image size or aspect ratio. Supported output sizes are 1024x1024, 1536x1024, 1024x1536, and auto.",
    }),
  ),
  quality: Schema.optional(Schema.Literals(["low", "medium", "high"])),
  model: Schema.optional(Schema.String).annotate({
    description:
      "Media image model, independent from the conversation model. Use configured image_model, gpt-image-2, or agnes-image-*.",
  }),
})

const GenerateVideoParameters = Schema.Struct({
  prompt: Schema.String.annotate({ description: "Video prompt" }),
  duration: Schema.optional(Schema.Number).annotate({ description: "Seconds, 1–12. Default 5" }),
  ratio: Schema.optional(Schema.Literals(["16:9", "9:16", "1:1"])),
  first_frame: Schema.optional(Schema.String).annotate({
    description:
      "Image guiding the opening frame (media library asset id or project-relative png/jpg path), for continuity with preceding footage",
  }),
  last_frame: Schema.optional(Schema.String).annotate({
    description:
      "Image guiding the closing frame (media library asset id or project-relative png/jpg path), for continuity with following footage",
  }),
  model: Schema.optional(Schema.String).annotate({
    description:
      "Media video model, independent from the conversation model. Use configured video_model, seedance*, wan*, minimax/hailuo*, or agnes-video-v2.0.",
  }),
})

export const MediaProbeTool = Tool.define(
  "media_probe",
  Effect.gen(function* () {
    const ffmpeg = yield* MediaFFmpeg.Service
    const description = yield* Effect.promise(() => readFile(new URL("./media_probe.txt", import.meta.url), "utf8"))
    return {
      description,
      parameters: ProbeParameters,
      execute: (params: Schema.Schema.Type<typeof ProbeParameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          const file = resolveInside(instance.directory, params.path)
          yield* ctx.ask({
            permission: "media_probe",
            patterns: [params.path],
            always: [params.path],
            metadata: { path: params.path },
          })
          const info = yield* ffmpeg.probe(file)
          return { title: `Probe ${baseName(params.path)}`, output: JSON.stringify(info, null, 2), metadata: {} }
        }).pipe(Effect.orDie),
    }
  }),
)

export const MediaProcessTool = Tool.define(
  "media_process",
  Effect.gen(function* () {
    const ffmpeg = yield* MediaFFmpeg.Service
    const library = yield* MediaLibrary.Service
    const previews = yield* MediaPreview.Service
    const jobs = yield* BackgroundJob.Service
    const description = yield* Effect.promise(() => readFile(new URL("./media_process.txt", import.meta.url), "utf8"))
    return {
      description,
      parameters: ProcessParameters,
      execute: (
        params: Schema.Schema.Type<typeof ProcessParameters>,
        ctx: Tool.Context,
      ): Effect.Effect<Tool.ExecuteResult<ProcessMetadata>, never, never> =>
        Effect.gen(function* () {
          const template = templates[params.template]
          if (!template) {
            throw new Error(`Unknown template: ${params.template} (available: ${Object.keys(templates).join("/")})`)
          }
          const ext = path.extname(params.output).toLowerCase()
          if (!template.outputExts.includes(ext)) {
            throw new Error(
              `Template ${params.template} requires output extension ${template.outputExts.join("/")}, got ${ext || "(none)"}`,
            )
          }

          const instance = yield* InstanceState.context
          yield* ctx.ask({
            permission: "media_process",
            patterns: [params.output],
            always: [params.output],
            metadata: { template: params.template, inputs: params.inputs },
          })

          const { timeout_ms, ...tplParams } = params.params ?? {}
          const timeoutMs = Math.min(Number(timeout_ms ?? DEFAULT_KIND_TIMEOUT[template.kind]), HARD_TIMEOUT_MS)
          if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("Invalid timeout_ms")

          const resolvedInputs = yield* Effect.forEach(params.inputs, (ref) => resolveMediaRef(instance, library, ref))
          const inputs = resolvedInputs.map((ref) => ref.path)
          const output = resolveInside(instance.directory, params.output)
          const tmpDir = mediaTmpDir(instance.directory)
          yield* Effect.tryPromise(() => mkdir(tmpDir, { recursive: true }))
          yield* Effect.tryPromise(() => mkdir(path.dirname(output), { recursive: true }))

          const tmplCtx: TemplateContext = {
            inputs,
            output,
            tmpDir,
            resolve: (p) => resolveInside(instance.directory, p),
          }
          const { args, auxFiles } = template.build(tmplCtx, tplParams)
          for (const aux of auxFiles ?? []) {
            yield* Effect.tryPromise(() => writeFile(aux.path, aux.content))
          }

          yield* ffmpeg
            .run(args, { timeoutMs })
            .pipe(
              Effect.onExit(() =>
                Effect.tryPromise(() => Promise.all((auxFiles ?? []).map((aux) => rm(aux.path, { force: true })))).pipe(
                  Effect.ignore,
                ),
              ),
            )

          if (output.includes("%")) {
            // 多帧产物不搬入媒体库，原位置返回清单
            const produced = (yield* Effect.tryPromise(() => readdir(path.dirname(output))))
              .filter((f) => f.startsWith(path.basename(output).split("%")[0] ?? ""))
              .sort()
            return {
              title: `Extracted ${produced.length} frames`,
              output: produced
                .map((f) => path.relative(instance.directory, path.join(path.dirname(output), f)))
                .join("\n"),
              metadata: { template: params.template, frames: produced.length, asset_id: null },
            }
          }

          const probed = yield* ffmpeg.probe(output).pipe(Effect.option)
          const videoStream =
            probed._tag === "Some" ? probed.value.streams.find((s) => s.codec_type === "video") : undefined
          const asset = yield* library.ingest({
            directory: instance.directory,
            source: { type: "file", path: output },
            kind: template.kind,
            source_kind: "process",
            model: "ffmpeg",
            params: { template: params.template, ...tplParams },
            width: videoStream?.width ?? null,
            height: videoStream?.height ?? null,
            duration_ms:
              probed._tag === "Some" && probed.value.format.duration
                ? Math.round(Number(probed.value.format.duration) * 1000)
                : null,
          })
          yield* schedulePreview(jobs, previews, yield* library.absolute(instance.directory, asset), asset.id)
          return {
            title: `Processed ${baseName(params.output)}`,
            output: `Saved to ${asset.path}`,
            metadata: { template: params.template, frames: null, asset_id: asset.id },
            attachments: [
              {
                type: "file" as const,
                mime: asset.mime,
                url: contentUrl(instance.directory, asset.id),
                filename: baseName(asset.path),
              },
            ],
          }
        }).pipe(Effect.orDie),
    }
  }),
)

export const MediaGenerateImageTool = Tool.define(
  "media_generate_image",
  Effect.gen(function* () {
    const library = yield* MediaLibrary.Service
    const previews = yield* MediaPreview.Service
    const jobs = yield* BackgroundJob.Service
    const config = yield* Config.Service
    const description = yield* Effect.promise(() =>
      readFile(new URL("./media_generate_image.txt", import.meta.url), "utf8"),
    )
    return {
      description,
      parameters: GenerateImageParameters,
      execute: (
        params: Schema.Schema.Type<typeof GenerateImageParameters>,
        ctx: Tool.Context,
      ): Effect.Effect<Tool.ExecuteResult<GenerateImageMetadata>, never, never> =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          const directory = instance.directory
          const image = params.image ? yield* resolveMediaRef(instance, library, params.image) : undefined
          const mask = params.mask ? yield* resolveMediaRef(instance, library, params.mask) : undefined
          const req: ImageRequest = {
            prompt: params.prompt,
            size: normalizeImageSize(params.size),
            quality: params.quality ?? "high",
            ...(image ? { image: yield* frameDataUrl(image) } : {}),
            ...(mask ? { mask: yield* frameDataUrl(mask) } : {}),
          }
          const media = (yield* config.get()).media
          const requestedModel = params.model ?? media?.image_model
          const imageModel = requestedModel?.startsWith("agnes-video") ? "agnes-image-2.1-flash" : requestedModel
          const provider = yield* resolveProvider(imageModel, authFrom(media))
          yield* ctx.ask({
            permission: "media_generate_image",
            patterns: [provider.id],
            always: [provider.id],
            metadata: {
              prompt: params.prompt,
              size: req.size,
              quality: req.quality,
              image: params.image,
              mask: params.mask,
              cost_usd_estimate: estimateImageCost(req),
            },
          })

          const { jobId } = yield* provider.submitImage(req)
          // openai 为内联同步语义：jobId 即 data URL 载体
          const status = yield* pollUntilDone(provider, jobId)
          if (status.state !== "succeeded") {
            return yield* new MediaProviderError({ detail: "image job did not succeed" })
          }
          const asset = yield* library.ingest({
            directory,
            source: { type: "dataUrl", url: status.url },
            kind: "image",
            source_kind: "generate",
            model: provider.id,
            prompt: params.prompt,
            params: { size: req.size, quality: req.quality },
            cost_usd_estimate: estimateImageCost(req),
          })
          yield* schedulePreview(jobs, previews, yield* library.absolute(directory, asset), asset.id)
          return {
            title: `Generated image (${req.size}, ${req.quality})`,
            output: `Saved to ${asset.path}`,
            metadata: { asset_id: asset.id, cost_usd_estimate: asset.cost_usd_estimate },
            attachments: [
              {
                type: "file" as const,
                mime: asset.mime,
                url: contentUrl(directory, asset.id, asset.path),
                filename: baseName(asset.path),
              },
            ],
          }
        }).pipe(Effect.orDie),
    }
  }),
)

export const MediaGenerateVideoTool = Tool.define(
  "media_generate_video",
  Effect.gen(function* () {
    const library = yield* MediaLibrary.Service
    const jobs = yield* BackgroundJob.Service
    const previews = yield* MediaPreview.Service
    const config = yield* Config.Service
    const description = yield* Effect.promise(() =>
      readFile(new URL("./media_generate_video.txt", import.meta.url), "utf8"),
    )
    return {
      description,
      parameters: GenerateVideoParameters,
      execute: (
        params: Schema.Schema.Type<typeof GenerateVideoParameters>,
        ctx: Tool.Context,
      ): Effect.Effect<Tool.ExecuteResult<GenerateVideoMetadata>, never, never> =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          const directory = instance.directory
          const firstFrame = params.first_frame
            ? yield* resolveMediaRef(instance, library, params.first_frame)
            : undefined
          const lastFrame = params.last_frame ? yield* resolveMediaRef(instance, library, params.last_frame) : undefined
          const req: VideoRequest = {
            prompt: params.prompt,
            duration: params.duration ?? 5,
            ratio: params.ratio ?? "16:9",
            ...(firstFrame ? { first_frame: yield* frameDataUrl(firstFrame) } : {}),
            ...(lastFrame ? { last_frame: yield* frameDataUrl(lastFrame) } : {}),
          }
          const media = (yield* config.get()).media
          const requestedModel = params.model ?? media?.video_model ?? "seedance-2-0"
          const videoModel = requestedModel.startsWith("agnes-image") ? "agnes-video-v2.0" : requestedModel
          const provider = yield* resolveProvider(videoModel, authFrom(media), "video")
          yield* ctx.ask({
            permission: "media_generate_video",
            patterns: [provider.id],
            always: [provider.id],
            // 不把 base64 参考帧塞进权限元数据（可能有几 MB），只留可读参数
            metadata: {
              prompt: req.prompt,
              duration: req.duration,
              ratio: req.ratio,
              first_frame: params.first_frame,
              last_frame: params.last_frame,
            },
          })

          const { jobId } = yield* provider.submitVideo(req)
          // 预生成后台任务 id：run 内部要靠它回写进度元数据
          const taskId = Identifier.ascending("job")
          const job = yield* jobs.start({
            id: taskId,
            type: "media_generate_video",
            title: `Generating ${req.duration}s video (${provider.id})`,
            metadata: {
              prompt: params.prompt,
              duration: req.duration,
              ratio: req.ratio,
              model: provider.id,
              provider_job_id: jobId,
            },
            run: Effect.gen(function* () {
              const startedAt = Date.now()
              const status = yield* pollUntilDone(provider, jobId, (poll) =>
                jobs
                  .update({
                    id: taskId,
                    metadata: {
                      ...(poll.state === "queued" || poll.state === "running" ? { progress: poll.progress ?? null } : {}),
                      elapsed_ms: Date.now() - startedAt,
                    },
                  })
                  .pipe(Effect.asVoid),
              )
              if (status.state !== "succeeded") {
                return yield* new MediaProviderError({ detail: "video job did not succeed" })
              }
              // Ark 产物 URL 约 24h 过期：立即下载落盘
              const tmp = path.join(mediaTmpDir(directory), `gen-${Date.now()}.mp4`)
              yield* Effect.tryPromise(async () => {
                await mkdir(mediaTmpDir(directory), { recursive: true })
                await downloadTo(status.url, tmp)
              })
              const asset = yield* library.ingest({
                directory,
                source: { type: "file", path: tmp },
                kind: "video",
                source_kind: "generate",
                model: provider.id,
                prompt: params.prompt,
                params: { duration: req.duration, ratio: req.ratio },
                job_id: jobId,
              })
              yield* schedulePreview(jobs, previews, yield* library.absolute(directory, asset), asset.id)
              return asset.id
            }).pipe(Effect.onInterrupt(() => Effect.ignore(provider.cancel(jobId)))),
          })

          // Wait for a terminal result; cancelling the foreground wait also
          // cancels its background job and the provider request.
          const result = yield* jobs
            .wait({ id: job.id })
            .pipe(Effect.onInterrupt(() => jobs.cancel(job.id).pipe(Effect.asVoid)))
          const info = result.info
          if (!info || info.status === "error") {
            throw new Error(`Video generation failed: ${info?.error ?? "job lost"}`)
          }
          if (info.status === "cancelled") {
            throw new Error("Video generation cancelled")
          }
          const asset = yield* library.get(info.output ?? "")
          if (!asset) throw new Error("Video asset missing after generation")
          return {
            title: `Generated video (${req.duration}s, ${req.ratio})`,
            output: `Saved to ${asset.path}`,
            metadata: { asset_id: asset.id, job_id: asset.job_id },
            attachments: [
              {
                type: "file" as const,
                mime: asset.mime,
                url: contentUrl(directory, asset.id),
                filename: baseName(asset.path),
              },
            ],
          }
        }).pipe(Effect.orDie),
    }
  }),
)

type ListMetadata = { count: number; next_cursor: string | null }

function summarize(asset: MediaLibrary.Asset) {
  return {
    id: asset.id,
    path: asset.path,
    kind: asset.kind,
    mime: asset.mime,
    bytes: asset.bytes,
    ...(asset.width !== null ? { width: asset.width, height: asset.height } : {}),
    ...(asset.duration_ms !== null ? { duration_ms: asset.duration_ms } : {}),
    source: asset.source,
    ...(asset.model ? { model: asset.model } : {}),
    ...(asset.prompt
      ? { prompt: asset.prompt.length > 120 ? `${asset.prompt.slice(0, 117)}...` : asset.prompt }
      : {}),
    created: new Date(asset.time_created).toISOString(),
  }
}

const ListParameters = Schema.Struct({
  query: Schema.optional(Schema.String).annotate({
    description:
      "Case-insensitive substring matched against prompt, model, and original filename (for uploads); omit to list everything",
  }),
  kind: Schema.optional(Schema.Literals(["image", "video"])).annotate({ description: "Filter by media kind" }),
  source: Schema.optional(Schema.Literals(["generate", "process", "upload"])).annotate({
    description: "Filter by how the asset entered the library",
  }),
  limit: Schema.optional(Schema.Number).annotate({ description: "1–100 items per page, default 20" }),
  cursor: Schema.optional(Schema.String).annotate({ description: "Pass next_cursor from the previous page" }),
})

export const MediaListTool = Tool.define(
  "media_list",
  Effect.gen(function* () {
    const library = yield* MediaLibrary.Service
    const description = yield* Effect.promise(() => readFile(new URL("./media_list.txt", import.meta.url), "utf8"))
    return {
      description,
      parameters: ListParameters,
      execute: (
        params: Schema.Schema.Type<typeof ListParameters>,
      ): Effect.Effect<Tool.ExecuteResult<ListMetadata>, never, never> =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          const result = yield* library.list({
            directory: instance.directory,
            ...(params.kind ? { kind: params.kind } : {}),
            ...(params.source ? { source: params.source } : {}),
            ...(params.query ? { query: params.query } : {}),
            ...(params.cursor ? { cursor: params.cursor } : {}),
            ...(params.limit ? { limit: params.limit } : {}),
          })
          const items = result.items.map(summarize)
          return {
            title: `Listed media (${items.length})`,
            output: JSON.stringify({
              count: items.length,
              ...(result.next ? { next_cursor: result.next } : { next_cursor: null }),
              items,
            }),
            metadata: { count: items.length, next_cursor: result.next ?? null },
          }
        }).pipe(Effect.orDie),
    }
  }),
)

const GetParameters = Schema.Struct({
  id: Schema.String.annotate({ description: "Media asset id (med_...)" }),
})

export const MediaGetTool = Tool.define(
  "media_get",
  Effect.gen(function* () {
    const library = yield* MediaLibrary.Service
    const description = yield* Effect.promise(() => readFile(new URL("./media_get.txt", import.meta.url), "utf8"))
    return {
      description,
      parameters: GetParameters,
      execute: (
        params: Schema.Schema.Type<typeof GetParameters>,
      ): Effect.Effect<Tool.ExecuteResult<{ asset_id: string }>, never, never> =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          const asset = yield* library.get(params.id)
          if (!asset || asset.project_id !== instance.project.id) {
            throw new Error(`媒体库中不存在素材 ${params.id}，可先用 media_list 查询`)
          }
          return {
            title: `Media ${asset.kind} ${baseName(asset.path)}`,
            output: JSON.stringify({
              ...summarize(asset),
              prompt: asset.prompt,
              params: asset.params,
              content_url: contentUrl(instance.directory, asset.id),
            }),
            metadata: { asset_id: asset.id },
          }
        }).pipe(Effect.orDie),
    }
  }),
)
