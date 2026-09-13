import { Effect, Schema } from "effect"
import path from "path"
import { mkdir, readdir, rm, writeFile } from "fs/promises"
import * as Tool from "./tool"
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
  type ProviderAuth,
  type VideoRequest,
} from "@/media/provider"
import { mediaTmpDir, resolveInside } from "@/media/paths"
import { templates, type TemplateContext } from "@/media/templates"

const HARD_TIMEOUT_MS = 30 * 60 * 1000
const DEFAULT_KIND_TIMEOUT = { image: 60_000, video: 600_000 } as const

/** 与 server /media/content 路由一致：query 形式，directory 用于项目归属校验 */
export function contentUrl(directory: string, id: string): string {
  return `/media/content?directory=${encodeURIComponent(directory)}&id=${encodeURIComponent(id)}`
}

function baseName(p: string): string {
  return p.split("/").pop() ?? p
}

type ProcessMetadata = { template: string; frames: number | null; asset_id: string | null }
type GenerateImageMetadata = { asset_id: string; cost_usd_estimate: number | null }
type GenerateVideoMetadata = { asset_id: string; job_id: string | null }

function authFrom(media: Schema.Schema.Type<typeof ConfigMediaV1.Info> | undefined): ProviderAuth {
  return {
    openai: { apiKey: media?.openai_api_key },
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
    if (delay) await Bun.sleep(delay)
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

/** 读取项目内参考帧图片为 data URL，随生成请求一并提交给 provider */
function frameDataUrl(directory: string, rel: string) {
  return Effect.gen(function* () {
    const ext = path.extname(rel).toLowerCase()
    const mime = FRAME_MIME[ext]
    if (!mime) throw new Error(`参考帧仅支持 png/jpg: ${rel}`)
    const file = resolveInside(directory, rel)
    const bytes = yield* Effect.tryPromise(() => Bun.file(file).arrayBuffer())
    return `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`
  })
}

const ProbeParameters = Schema.Struct({
  path: Schema.String.annotate({ description: "Project-relative media file path" }),
})

const ProcessParameters = Schema.Struct({
  template: Schema.String.annotate({
    description: "Template name: transcode/trim/trim_exact/concat/extract_frames/watermark/make_gif/resize_image/thumbnail",
  }),
  inputs: Schema.Array(Schema.String).annotate({ description: "Project-relative input paths (1–20)" }),
  output: Schema.String.annotate({ description: "Project-relative output path" }),
  params: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)).annotate({
    description: "Template-specific parameters (see template descriptions); may include timeout_ms",
  }),
})

const GenerateImageParameters = Schema.Struct({
  prompt: Schema.String.annotate({ description: "Image prompt" }),
  size: Schema.optional(Schema.Literals(["1024x1024", "1536x1024", "1024x1536", "auto"])),
  quality: Schema.optional(Schema.Literals(["low", "medium", "high"])),
  model: Schema.optional(Schema.String).annotate({ description: "Defaults to gpt-image-2" }),
})

const GenerateVideoParameters = Schema.Struct({
  prompt: Schema.String.annotate({ description: "Video prompt" }),
  duration: Schema.optional(Schema.Number).annotate({ description: "Seconds, 1–12. Default 5" }),
  ratio: Schema.optional(Schema.Literals(["16:9", "9:16", "1:1"])),
  first_frame: Schema.optional(Schema.String).annotate({
    description: "Project-relative image path (png/jpg) guiding the opening frame, for continuity with preceding footage",
  }),
  last_frame: Schema.optional(Schema.String).annotate({
    description: "Project-relative image path (png/jpg) guiding the closing frame, for continuity with following footage",
  }),
  model: Schema.optional(Schema.String).annotate({ description: "Defaults to seedance-2-0" }),
})

export const MediaProbeTool = Tool.define(
  "media_probe",
  Effect.gen(function* () {
    const ffmpeg = yield* MediaFFmpeg.Service
    const description = yield* Effect.promise(() =>
      Bun.file(new URL("./media_probe.txt", import.meta.url)).text(),
    )
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
    const description = yield* Effect.promise(() =>
      Bun.file(new URL("./media_process.txt", import.meta.url)).text(),
    )
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
            throw new Error(`Template ${params.template} requires output extension ${template.outputExts.join("/")}, got ${ext || "(none)"}`)
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

          const inputs = params.inputs.map((p) => resolveInside(instance.directory, p))
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

          yield* ffmpeg.run(args, { timeoutMs }).pipe(
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
              output: produced.map((f) => path.relative(instance.directory, path.join(path.dirname(output), f))).join("\n"),
              metadata: { template: params.template, frames: produced.length, asset_id: null },
            }
          }

          const probed = yield* ffmpeg.probe(output).pipe(Effect.option)
          const videoStream = probed._tag === "Some" ? probed.value.streams.find((s) => s.codec_type === "video") : undefined
          const asset = yield* library.ingest({
            directory: instance.directory,
            source: { type: "file", path: output },
            kind: template.kind,
            source_kind: "process",
            model: "ffmpeg",
            params: { template: params.template, ...tplParams },
            width: videoStream?.width ?? null,
            height: videoStream?.height ?? null,
            duration_ms: probed._tag === "Some" && probed.value.format.duration ? Math.round(Number(probed.value.format.duration) * 1000) : null,
          })
          return {
            title: `Processed ${baseName(params.output)}`,
            output: `Saved to ${asset.path}`,
            metadata: { template: params.template, frames: null, asset_id: asset.id },
            attachments: [
              { type: "file" as const, mime: asset.mime, url: contentUrl(instance.directory, asset.id), filename: baseName(asset.path) },
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
    const config = yield* Config.Service
    const description = yield* Effect.promise(() =>
      Bun.file(new URL("./media_generate_image.txt", import.meta.url)).text(),
    )
    return {
      description,
      parameters: GenerateImageParameters,
      execute: (
        params: Schema.Schema.Type<typeof GenerateImageParameters>,
        ctx: Tool.Context,
      ): Effect.Effect<Tool.ExecuteResult<GenerateImageMetadata>, never, never> =>
        Effect.gen(function* () {
          const req: ImageRequest = {
            prompt: params.prompt,
            size: params.size ?? "1024x1024",
            quality: params.quality ?? "high",
          }
          const media = (yield* config.get()).media
          const provider = yield* resolveProvider(params.model ?? media?.image_model, authFrom(media))
          yield* ctx.ask({
            permission: "media_generate_image",
            patterns: [provider.id],
            always: [provider.id],
            metadata: { ...req, cost_usd_estimate: estimateImageCost(req) },
          })

          const { jobId } = yield* provider.submitImage(req)
          // openai 为内联同步语义：jobId 即 data URL 载体
          const status = yield* pollUntilDone(provider, jobId)
          if (status.state !== "succeeded") {
            return yield* new MediaProviderError({ detail: "image job did not succeed" })
          }
          const directory = (yield* InstanceState.context).directory
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
          return {
            title: `Generated image (${req.size}, ${req.quality})`,
            output: `Saved to ${asset.path}`,
            metadata: { asset_id: asset.id, cost_usd_estimate: asset.cost_usd_estimate },
            attachments: [
              { type: "file" as const, mime: asset.mime, url: contentUrl(directory, asset.id), filename: baseName(asset.path) },
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
    const config = yield* Config.Service
    const description = yield* Effect.promise(() =>
      Bun.file(new URL("./media_generate_video.txt", import.meta.url)).text(),
    )
    return {
      description,
      parameters: GenerateVideoParameters,
      execute: (
        params: Schema.Schema.Type<typeof GenerateVideoParameters>,
        ctx: Tool.Context,
      ): Effect.Effect<Tool.ExecuteResult<GenerateVideoMetadata>, never, never> =>
        Effect.gen(function* () {
          const directory = (yield* InstanceState.context).directory
          const req: VideoRequest = {
            prompt: params.prompt,
            duration: params.duration ?? 5,
            ratio: params.ratio ?? "16:9",
            ...(params.first_frame ? { first_frame: yield* frameDataUrl(directory, params.first_frame) } : {}),
            ...(params.last_frame ? { last_frame: yield* frameDataUrl(directory, params.last_frame) } : {}),
          }
          const media = (yield* config.get()).media
          const provider = yield* resolveProvider(
            params.model ?? media?.video_model ?? "seedance-2-0",
            authFrom(media),
          )
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
          const job = yield* jobs.start({
            type: "media_generate_video",
            title: `Generating ${req.duration}s video (${provider.id})`,
            metadata: { prompt: params.prompt, duration: req.duration, ratio: req.ratio, model: provider.id },
            run: Effect.gen(function* () {
              const status = yield* pollUntilDone(provider, jobId)
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
              return asset.id
            }).pipe(Effect.onInterrupt(() => Effect.ignore(provider.cancel(jobId)))),
          })

          // 轮询等待后台任务终态；会话 abort 会打断等待，任务端 onInterrupt 负责取消远端
          const info = yield* Effect.gen(function* () {
            for (;;) {
              const result = yield* jobs.wait({ id: job.id, timeout: 30_000 })
              if (result.info) return result.info
              if (!result.timedOut) return yield* jobs.get(job.id)
            }
          })
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
              { type: "file" as const, mime: asset.mime, url: contentUrl(directory, asset.id), filename: baseName(asset.path) },
            ],
          }
        }).pipe(Effect.orDie),
    }
  }),
)
