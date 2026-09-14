import { Effect, Layer, Schema } from "effect"
import { NodeFileSystem } from "@effect/platform-node"
import { HttpPlatform, HttpServerResponse } from "effect/unstable/http"
import { HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi"
import { Authorization } from "./middleware/authorization"
import { InstanceContextMiddleware } from "./middleware/instance-context"
import { WorkspaceRoutingMiddleware, WorkspaceRoutingQueryFields } from "./middleware/workspace-routing"
import { stat } from "fs/promises"
import { BackgroundJob } from "@/background/job"
import { type Info, type Kind } from "@opencode-ai/core/media/task"
import { MediaLibrary } from "@/media/library"
import { MediaPreview } from "@/media/preview"
import { InstanceState } from "@/effect/instance-state"
import { Project } from "@/project/project"

const query = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  directory: Schema.String,
  id: Schema.optional(Schema.String),
  kind: Schema.optional(Schema.Literals(["image", "video"])),
  cursor: Schema.optional(Schema.String),
  limit: Schema.optional(Schema.String),
  from: Schema.optional(Schema.String),
  to: Schema.optional(Schema.String),
  auth_token: Schema.optional(Schema.String),
  preview: Schema.optional(Schema.Literals(["thumbnail"])),
})

// Raw responses preserve file streaming and Range headers while the declared
// middleware supplies the same authentication and instance context as other APIs.
export const MediaApi = HttpApi.make("media").add(
  HttpApiGroup.make("media")
    .add(
      HttpApiEndpoint.get("list", "/media", { query, success: Schema.Unknown }),
      HttpApiEndpoint.get("stats", "/media/stats", { query, success: Schema.Unknown }),
      HttpApiEndpoint.get("tasks", "/media/tasks", { query, success: Schema.Unknown }),
      HttpApiEndpoint.get("task", "/media/task", { query, success: Schema.Unknown }),
      HttpApiEndpoint.delete("cancel", "/media/task", { query, success: Schema.Unknown }),
      HttpApiEndpoint.get("asset", "/media/asset", { query, success: Schema.Unknown }),
      HttpApiEndpoint.delete("remove", "/media/asset", { query, success: Schema.Unknown }),
      HttpApiEndpoint.get("content", "/media/content", { query, success: Schema.Uint8Array }),
    )
    .middleware(InstanceContextMiddleware)
    .middleware(WorkspaceRoutingMiddleware)
    .middleware(Authorization),
)

function badRequest(message: string) {
  return HttpServerResponse.text(message, { status: 400 })
}

function notFound() {
  return HttpServerResponse.text("not found", { status: 404 })
}

function serverError() {
  return HttpServerResponse.text("internal error", { status: 500 })
}

function taskKind(type: string): Kind | undefined {
  if (type === "media_generate_image") return "image"
  if (type === "media_generate_video") return "video"
  if (type === "media_process") return "process"
  return undefined
}

function taskInfo(info: BackgroundJob.Info): Info | undefined {
  const kind = taskKind(info.type)
  if (!kind) return undefined
  return {
    id: info.id,
    kind,
    status: info.status,
    ...(info.title ? { title: info.title } : {}),
    progress: typeof info.metadata?.progress === "number" ? info.metadata.progress : null,
    ...(typeof info.metadata?.provider_job_id === "string" ? { provider_job_id: info.metadata.provider_job_id } : {}),
    ...(typeof info.output === "string" && info.output.startsWith("med") ? { asset_id: info.output } : {}),
    started_at: info.started_at,
    ...(info.completed_at === undefined ? {} : { completed_at: info.completed_at }),
    ...(info.output === undefined ? {} : { output: info.output }),
    ...(info.error === undefined ? {} : { error: info.error }),
    ...(info.metadata ? { metadata: info.metadata } : {}),
  }
}

export const mediaHandlers = HttpApiBuilder.group(MediaApi, "media", (handlers) =>
  Effect.gen(function* () {
    const library = yield* MediaLibrary.Service
    const previews = yield* MediaPreview.Service
    const projects = yield* Project.Service
    const jobs = yield* BackgroundJob.Service
    const files = yield* HttpPlatform.HttpPlatform

    /** 取资产并校验归属当前 directory 对应的项目 */
    const owned = (directory: string, id: string) =>
      Effect.gen(function* () {
        const asset = yield* library.get(id)
        if (!asset) return undefined
        const instance = yield* InstanceState.context
        // Workspace routing can select a different instance than the query directory.
        const project =
          instance.directory === directory ? instance.project : (yield* projects.fromDirectory(directory)).project
        return asset.project_id === project.id ? asset : undefined
      })

    // 库操作错误统一兜底 500（错误类型刻意声明为 unknown）
    const guard = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.catch((error) => Effect.logError("media request failed", error).pipe(Effect.as(serverError() as A))),
      )

    return (
      handlers
        .handleRaw("list", ({ request }) =>
          guard(
            Effect.gen(function* () {
              const url = new URL(request.url, "http://localhost")
              const directory = url.searchParams.get("directory")
              if (!directory) return badRequest("missing directory")
              const kind = url.searchParams.get("kind")
              const cursor = url.searchParams.get("cursor")
              const limit = url.searchParams.get("limit")
              if (kind && kind !== "image" && kind !== "video") return badRequest("invalid kind")
              if (limit !== null && (!Number.isInteger(Number(limit)) || Number(limit) < 1 || Number(limit) > 200)) {
                return badRequest("limit must be an integer from 1 to 200")
              }
              const result = yield* library.list({
                directory,
                ...(kind === "image" || kind === "video" ? { kind } : {}),
                ...(cursor ? { cursor } : {}),
                ...(limit ? { limit: Number(limit) } : {}),
              })
              return HttpServerResponse.jsonUnsafe({
                items: result.items,
                ...(result.next ? { next: result.next } : {}),
              })
            }),
          ),
        )
        .handleRaw("stats", ({ request }) =>
          guard(
            Effect.gen(function* () {
              const url = new URL(request.url, "http://localhost")
              const directory = url.searchParams.get("directory")
              if (!directory) return badRequest("missing directory")
              const from = url.searchParams.get("from")
              const to = url.searchParams.get("to")
              const result = yield* library.stats({
                directory,
                ...(from && Number.isFinite(Number(from)) ? { from: Number(from) } : {}),
                ...(to && Number.isFinite(Number(to)) ? { to: Number(to) } : {}),
              })
              return HttpServerResponse.jsonUnsafe(result)
            }),
          ),
        )
        .handleRaw("tasks", ({ request }) =>
          guard(
            Effect.gen(function* () {
              const directory = new URL(request.url, "http://localhost").searchParams.get("directory")
              if (!directory) return badRequest("missing directory")
              const tasks = (yield* jobs.list())
                .filter((item) => item.type.startsWith("media_"))
                .flatMap((item) => {
                  const task = taskInfo(item)
                  return task ? [task] : []
                })
              return HttpServerResponse.jsonUnsafe({ items: tasks })
            }),
          ),
        )
        .handleRaw("task", ({ request }) =>
          guard(
            Effect.gen(function* () {
              const url = new URL(request.url, "http://localhost")
              const directory = url.searchParams.get("directory")
              if (!directory) return badRequest("missing directory")
              const id = url.searchParams.get("id")
              if (!id) return badRequest("missing id")
              const info = yield* jobs.get(id)
              const task = info ? taskInfo(info) : undefined
              if (!task) return notFound()
              return HttpServerResponse.jsonUnsafe(task)
            }),
          ),
        )
        .handleRaw("cancel", ({ request }) =>
          guard(
            Effect.gen(function* () {
              const url = new URL(request.url, "http://localhost")
              const directory = url.searchParams.get("directory")
              if (!directory) return badRequest("missing directory")
              const id = url.searchParams.get("id")
              if (!id) return badRequest("missing id")
              const info = yield* jobs.get(id)
              if (!info || !taskInfo(info)) return notFound()
              const cancelled = yield* jobs.cancel(id)
              const task = cancelled ? taskInfo(cancelled) : undefined
              if (!task) return notFound()
              return HttpServerResponse.jsonUnsafe(task)
            }),
          ),
        )
        .handleRaw("asset", ({ request }) =>
          guard(
            Effect.gen(function* () {
              const url = new URL(request.url, "http://localhost")
              const directory = url.searchParams.get("directory")
              const id = url.searchParams.get("id")
              if (!directory || !id) return badRequest("missing directory or id")
              const asset = yield* owned(directory, id)
              if (!asset) return notFound()
              return HttpServerResponse.jsonUnsafe(asset)
            }),
          ),
        )
        .handleRaw("remove", ({ request }) =>
          guard(
            Effect.gen(function* () {
              const url = new URL(request.url, "http://localhost")
              const directory = url.searchParams.get("directory")
              const id = url.searchParams.get("id")
              if (!directory || !id) return badRequest("missing directory or id")
              const asset = yield* owned(directory, id)
              if (!asset) return notFound()
              yield* library.remove(id)
              return HttpServerResponse.text("", { status: 204 })
            }),
          ),
        )

        // 流式内容端点：必须支持 HTTP Range（<video> 拖动进度条依赖 206 响应）
        .handleRaw("content", ({ request }) =>
          guard(
            Effect.gen(function* () {
              const url = new URL(request.url, "http://localhost")
              const directory = url.searchParams.get("directory")
              const id = url.searchParams.get("id")
              if (!directory || !id) return badRequest("missing directory or id")
              const asset = yield* owned(directory, id)
              if (!asset) return notFound()
              const abs = yield* library.absolute(directory, asset)
              const preview = url.searchParams.get("preview")
              if (preview !== null && preview !== "thumbnail") return badRequest("invalid preview")
              const file = preview ? yield* previews.get(abs).pipe(Effect.catch(() => Effect.succeed(undefined))) : abs
              if (!file) return HttpServerResponse.text("preview unavailable", { status: 503 })
              const info = yield* Effect.tryPromise(() => stat(file)).pipe(
                Effect.catch(() => Effect.succeed(undefined)),
              )
              if (!info) return notFound()
              const size = info.size
              const headers = {
                "content-type": preview ? "image/jpeg" : asset.mime,
                "accept-ranges": "bytes",
                "cache-control": "private, max-age=3600",
              }
              const response = yield* files.fileResponse(file, { headers })
              const etag = response.headers.etag
              if (
                request.headers["if-none-match"]
                  ?.split(",")
                  .some(
                    (value) => value.trim() === "*" || value.trim().replace(/^W\//, "") === etag?.replace(/^W\//, ""),
                  )
              ) {
                return HttpServerResponse.empty({ status: 304, headers: response.headers })
              }
              const range = request.headers["range"]
              if (!range) return response

              const match = /^bytes=(\d*)-(\d*)$/.exec(range)
              if (!match || (!match[1] && !match[2])) {
                return HttpServerResponse.text("invalid range", {
                  status: 416,
                  headers: { ...headers, "content-range": `bytes */${size}` },
                })
              }
              let start: number
              let end: number
              if (match[1]) {
                start = Number(match[1])
                end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1
              } else {
                start = Math.max(size - Number(match[2]), 0)
                end = size - 1
              }
              if (start >= size || start > end) {
                return HttpServerResponse.text("range not satisfiable", {
                  status: 416,
                  headers: { ...headers, "content-range": `bytes */${size}` },
                })
              }
              return yield* files.fileResponse(file, {
                status: 206,
                headers: { ...headers, "content-range": `bytes ${start}-${end}/${size}` },
                offset: start,
                bytesToRead: end - start + 1,
              })
            }),
          ),
        )
    )
  }),
).pipe(
  // The web-handler fallback supplies a no-op filesystem. Media files require
  // the real filesystem with a portable stream body (also works in Web handlers).
  Layer.provide(Layer.fresh(HttpPlatform.layer.pipe(Layer.provide(NodeFileSystem.layer)))),
)
