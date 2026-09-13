import { Effect } from "effect"
import { HttpRouter, HttpServerResponse } from "effect/unstable/http"
import { stat } from "fs/promises"
import { MediaLibrary, type Asset } from "@/media/library"
import { Project } from "@/project/project"

/**
 * /media 媒体库 REST 端点（raw router 而非 HttpApi：content 端点需要
 * HTTP Range/206 语义，HttpApi schema 表达不了）。
 *
 * 全部端点带 directory 查询参数（项目目录，与 file API 的 workspace routing 一致），
 * 并校验 asset.project_id 归属，防止跨项目读取。
 */
function badRequest(message: string) {
  return HttpServerResponse.text(message, { status: 400 })
}

function notFound() {
  return HttpServerResponse.text("not found", { status: 404 })
}

function serverError() {
  return HttpServerResponse.text("internal error", { status: 500 })
}

export const mediaRoute = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const library = yield* MediaLibrary.Service
    const projects = yield* Project.Service

    /** 取资产并校验归属当前 directory 对应的项目 */
    const owned = (directory: string, id: string) =>
      Effect.gen(function* () {
        const asset = yield* library.get(id)
        if (!asset) return undefined
        const { project } = yield* projects.fromDirectory(directory)
        return asset.project_id === project.id ? asset : undefined
      })

    // 库操作错误统一兜底 500（错误类型刻意声明为 unknown）
    const guard = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(Effect.catch(() => Effect.succeed(serverError() as A)))

    router.add("GET", "/media", (request) =>
      guard(
        Effect.gen(function* () {
          const url = new URL(request.url)
          const directory = url.searchParams.get("directory")
          if (!directory) return badRequest("missing directory")
          const kind = url.searchParams.get("kind")
          const cursor = url.searchParams.get("cursor")
          const limit = url.searchParams.get("limit")
          const result = yield* library.list({
            directory: decodeURIComponent(directory),
            ...(kind === "image" || kind === "video" ? { kind } : {}),
            ...(cursor ? { cursor } : {}),
            ...(limit ? { limit: Number(limit) } : {}),
          })
          return HttpServerResponse.jsonUnsafe({ items: result.items, ...(result.next ? { next: result.next } : {}) })
        }),
      ),
    )

    router.add("GET", "/media/asset", (request) =>
      guard(
        Effect.gen(function* () {
          const url = new URL(request.url)
          const directory = url.searchParams.get("directory")
          const id = url.searchParams.get("id")
          if (!directory || !id) return badRequest("missing directory or id")
          const asset = yield* owned(decodeURIComponent(directory), id)
          if (!asset) return notFound()
          return HttpServerResponse.jsonUnsafe(asset)
        }),
      ),
    )

    router.add("DELETE", "/media/asset", (request) =>
      guard(
        Effect.gen(function* () {
          const url = new URL(request.url)
          const directory = url.searchParams.get("directory")
          const id = url.searchParams.get("id")
          if (!directory || !id) return badRequest("missing directory or id")
          const asset = yield* owned(decodeURIComponent(directory), id)
          if (!asset) return notFound()
          yield* library.remove(id)
          return HttpServerResponse.text("", { status: 204 })
        }),
      ),
    )

    // 流式内容端点：必须支持 HTTP Range（<video> 拖动进度条依赖 206 响应）
    router.add("GET", "/media/content", (request) =>
      guard(
        Effect.gen(function* () {
          const url = new URL(request.url)
          const directory = url.searchParams.get("directory")
          const id = url.searchParams.get("id")
          if (!directory || !id) return badRequest("missing directory or id")
          const asset = yield* owned(decodeURIComponent(directory), id)
          if (!asset) return notFound()
          const abs = yield* library.absolute(decodeURIComponent(directory), asset)
          const info = yield* Effect.tryPromise(() => stat(abs)).pipe(Effect.catch(() => Effect.succeed(undefined)))
          if (!info) return notFound()
          const size = info.size
          const headers = { "content-type": asset.mime, "accept-ranges": "bytes" }
          const range = request.headers["range"]
          if (!range) return yield* HttpServerResponse.file(abs, { headers })

          const match = /^bytes=(\d*)-(\d*)$/.exec(range)
          if (!match || (!match[1] && !match[2])) {
            return HttpServerResponse.text("invalid range", { status: 416, headers: { ...headers, "content-range": `bytes */${size}` } })
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
            return HttpServerResponse.text("range not satisfiable", { status: 416, headers: { ...headers, "content-range": `bytes */${size}` } })
          }
          return yield* HttpServerResponse.file(abs, {
            status: 206,
            headers: { ...headers, "content-range": `bytes ${start}-${end}/${size}` },
            offset: start,
            bytesToRead: end - start + 1,
          })
        }),
      ),
    )
  }),
)
