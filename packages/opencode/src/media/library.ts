import { Context, Effect, Layer, Schema, Semaphore } from "effect"
import path from "path"
import { copyFile, mkdir, rename, rm, stat, writeFile } from "fs/promises"
import { createReadStream } from "fs"
import { createHash } from "crypto"
import { and, desc, eq, isNull, lt, or, sql } from "drizzle-orm"
import type { AnySQLiteColumn } from "drizzle-orm/sqlite-core"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { MediaAssetTable } from "@opencode-ai/core/media/sql"
import { ProjectV2 } from "@opencode-ai/core/project"
import { Identifier } from "@/id/id"
import { Project } from "@/project/project"
import { InstanceRef } from "@/effect/instance-ref"
import { MediaPreview } from "./preview"
import { mediaTmpDir, PathError } from "./paths"

export interface Asset {
  id: string
  project_id: string
  path: string
  kind: "image" | "video"
  mime: string
  bytes: number
  width: number | null
  height: number | null
  duration_ms: number | null
  source: "generate" | "process" | "upload"
  content_hash?: string | null
  model: string | null
  prompt: string | null
  params: Record<string, unknown> | null
  job_id: string | null
  cost_usd_estimate: number | null
  time_created: number
  time_updated: number
}

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("MediaLibrary.NotFoundError", {
  id: Schema.String,
}) {
  override get message() {
    return `媒体产物不存在: ${this.id}`
  }
}

export type IngestSource = { type: "file"; path: string } | { type: "dataUrl"; url: string }

export interface IngestInput {
  /** 项目目录（worktree），产物落在其 .opencode/media/ 下 */
  directory: string
  source: IngestSource
  kind: "image" | "video"
  source_kind: "generate" | "process" | "upload"
  model?: string
  prompt?: string
  params?: Record<string, unknown>
  job_id?: string
  cost_usd_estimate?: number | null
  width?: number | null
  height?: number | null
  duration_ms?: number | null
}

export interface ListInput {
  directory: string
  kind?: "image" | "video"
  source?: Asset["source"]
  /** 不区分大小写的子串匹配，作用于 prompt / model / params（含上传时的原始文件名） */
  query?: string
  /** 上一页最后一项的 id（按 time_created 倒序翻页） */
  cursor?: string
  limit?: number
}

export interface StatsInput {
  directory: string
  from?: number
  to?: number
}

export interface StatsBucket {
  count: number
  bytes: number
  cost_usd_estimate: number
}

export interface Stats {
  count: number
  bytes: number
  cost_usd_estimate: number
  by_kind: { image: StatsBucket; video: StatsBucket }
  by_model: Array<{ model: string; count: number; cost_usd_estimate: number }>
  by_day: Array<{ day: string; count: number; cost_usd_estimate: number }>
}

export function aggregateStats(rows: readonly Asset[]): Stats {
  const empty = (): StatsBucket => ({ count: 0, bytes: 0, cost_usd_estimate: 0 })
  const by_kind = { image: empty(), video: empty() }
  const models = new Map<string, { count: number; cost_usd_estimate: number }>()
  const days = new Map<string, { count: number; cost_usd_estimate: number }>()
  rows.forEach((row) => {
    const bucket = by_kind[row.kind]
    bucket.count += 1
    bucket.bytes += row.bytes
    bucket.cost_usd_estimate += row.cost_usd_estimate ?? 0
    if (row.model) {
      const current = models.get(row.model) ?? { count: 0, cost_usd_estimate: 0 }
      models.set(row.model, {
        count: current.count + 1,
        cost_usd_estimate: current.cost_usd_estimate + (row.cost_usd_estimate ?? 0),
      })
    }
    const day = new Date(row.time_created).toISOString().slice(0, 10)
    const current = days.get(day) ?? { count: 0, cost_usd_estimate: 0 }
    days.set(day, {
      count: current.count + 1,
      cost_usd_estimate: current.cost_usd_estimate + (row.cost_usd_estimate ?? 0),
    })
  })
  return {
    count: rows.length,
    bytes: rows.reduce((total, row) => total + row.bytes, 0),
    cost_usd_estimate: rows.reduce((total, row) => total + (row.cost_usd_estimate ?? 0), 0),
    by_kind,
    by_model: Array.from(models, ([model, value]) => ({ model, ...value })).sort(
      (a, b) => b.cost_usd_estimate - a.cost_usd_estimate,
    ),
    by_day: Array.from(days, ([day, value]) => ({ day, ...value })).sort((a, b) => a.day.localeCompare(b.day)),
  }
}

// 数据库错误统一暴露为 unknown（上层工具 orDie，HTTP 层走错误中间件）
export interface Interface {
  readonly ingest: (input: IngestInput) => Effect.Effect<Asset, unknown>
  readonly list: (input: ListInput) => Effect.Effect<{ items: Asset[]; next?: string }, unknown>
  readonly stats: (input: StatsInput) => Effect.Effect<Stats, unknown>
  readonly get: (id: string) => Effect.Effect<Asset | undefined, unknown>
  /** 先删表记录再删磁盘文件：记录先删可重试，反过来会留孤儿 */
  readonly remove: (id: string) => Effect.Effect<void, unknown>
  /** 项目目录 + 库内相对路径 → 绝对路径（含越界校验，供 /media/:id/content 使用） */
  readonly absolute: (directory: string, asset: Asset) => Effect.Effect<string, PathError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Media/Library") {}

const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mkv": "video/x-matroska",
  ".mov": "video/quicktime",
}

function monthDir(directory: string, now = new Date()): string {
  const yyyy = now.getFullYear()
  const mm = String(now.getMonth() + 1).padStart(2, "0")
  return path.join(directory, ".opencode", "media", `${yyyy}-${mm}`)
}

function dataUrlBytes(url: string): { mime: string; buffer: Buffer } {
  const match = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(url)
  if (!match || !match[2]) throw new Error("仅支持 base64 data URL")
  return { mime: match[1]!, buffer: Buffer.from(match[3]!, "base64") }
}

async function sourceBytes(url: string): Promise<{ mime: string; buffer: Buffer }> {
  if (url.startsWith("data:")) return dataUrlBytes(url)
  const parsed = new URL(url)
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("媒体 URL 仅支持 http(s) 或 base64 data URL")
  }
  const response = await fetch(url)
  if (!response.ok) throw new Error(`下载媒体产物失败: ${response.status}`)
  const mime = response.headers.get("content-type")?.split(";", 1)[0]?.trim()
  if (!mime) throw new Error("媒体产物响应缺少 Content-Type")
  return { mime, buffer: Buffer.from(await response.arrayBuffer()) }
}

async function contentHash(file: string) {
  const hash = createHash("sha256")
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest("hex")
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const projects = yield* Project.Service
    const uploads = Semaphore.makeUnsafe(1)

    const projectFor = Effect.fn("Media.Library.projectFor")(function* (directory: string) {
      const instance = yield* InstanceRef
      if (instance?.directory === directory) return instance.project
      return (yield* projects.fromDirectory(directory)).project
    })

    const ingest = Effect.fn("Media.Library.ingest")(function* (input: IngestInput) {
      const project = yield* projectFor(input.directory)
      const id = Identifier.ascending("media")

      let ext: string
      let mime: string
      let staging: string
      const source = input.source
      if (source.type === "file") {
        ext = path.extname(source.path).toLowerCase()
        mime = MIME_BY_EXT[ext]!
        if (!mime) return yield* Effect.fail(new Error(`不支持的产物扩展名: ${ext}`))
        staging = source.path
      } else {
        const parsed = yield* Effect.tryPromise(() => sourceBytes(source.url))
        mime = parsed.mime
        ext = `.${mime.split("/")[1] ?? "bin"}`.replace("jpeg", "jpg")
        if (!MIME_BY_EXT[ext]) return yield* Effect.fail(new Error(`不支持的产物 MIME: ${mime}`))
        staging = path.join(mediaTmpDir(input.directory), `${id}${ext}`)
        yield* Effect.tryPromise(() => mkdir(mediaTmpDir(input.directory), { recursive: true }))
        yield* Effect.tryPromise(() => writeFile(staging, parsed.buffer))
      }
      if (!mime.startsWith(`${input.kind}/`)) {
        return yield* Effect.fail(new Error(`产物 MIME ${mime} 与 kind=${input.kind} 不符`))
      }

      const hash = yield* Effect.tryPromise(() => contentHash(staging))
      const bytes = (yield* Effect.tryPromise(() => stat(staging))).size
      const candidates =
        input.source_kind === "upload"
          ? yield* db
              .select()
              .from(MediaAssetTable)
              .where(
                and(
                  eq(MediaAssetTable.project_id, project.id),
                  eq(MediaAssetTable.bytes, bytes),
                  eq(MediaAssetTable.mime, mime),
                  or(eq(MediaAssetTable.content_hash, hash), isNull(MediaAssetTable.content_hash)),
                ),
              )
              .all()
          : []
      for (const candidate of candidates) {
        const file = path.resolve(input.directory, candidate.path)
        const existing = yield* Effect.tryPromise(async () => {
          if (!(await Bun.file(file).exists())) return undefined
          return candidate.content_hash ?? (await contentHash(file))
        }).pipe(Effect.catch(() => Effect.succeed(undefined)))
        // Assets created before the hash column was introduced are reconciled lazily.
        if (!candidate.content_hash && existing) {
          yield* db
            .update(MediaAssetTable)
            .set({ content_hash: existing })
            .where(eq(MediaAssetTable.id, candidate.id))
            .run()
        }
        if (existing !== hash) continue
        if (staging.startsWith(`${mediaTmpDir(input.directory)}${path.sep}`)) {
          yield* Effect.tryPromise(() => rm(staging, { force: true })).pipe(Effect.ignore)
        }
        return { ...candidate, content_hash: existing } as Asset
      }

      const dir = monthDir(input.directory)
      yield* Effect.tryPromise(() => mkdir(dir, { recursive: true }))
      const target = path.join(dir, `${id}${ext}`)
      yield* Effect.tryPromise(async () => {
        try {
          await rename(staging, target)
        } catch {
          await copyFile(staging, target)
        }
      })
      const row = {
        id,
        project_id: project.id,
        path: path.relative(input.directory, target),
        kind: input.kind,
        mime,
        bytes,
        width: input.width ?? null,
        height: input.height ?? null,
        duration_ms: input.duration_ms ?? null,
        source: input.source_kind,
        content_hash: hash,
        model: input.model ?? null,
        prompt: input.prompt ?? null,
        params: input.params ?? null,
        job_id: input.job_id ?? null,
        cost_usd_estimate: input.cost_usd_estimate ?? null,
        time_created: Date.now(),
        time_updated: Date.now(),
      }
      yield* db
        .insert(MediaAssetTable)
        .values(row)
        .run()
        .pipe(Effect.onError(() => Effect.tryPromise(() => rm(target, { force: true })).pipe(Effect.ignore)))
      return row as Asset
    })

    const list = Effect.fn("Media.Library.list")(function* (input: ListInput) {
      const project = yield* projectFor(input.directory)
      const limit = Number.isInteger(input.limit) ? Math.max(1, Math.min(input.limit!, 200)) : 50
      const conditions = [eq(MediaAssetTable.project_id, project.id)]
      if (input.kind) conditions.push(eq(MediaAssetTable.kind, input.kind))
      if (input.source) conditions.push(eq(MediaAssetTable.source, input.source))
      if (input.query?.trim()) {
        // SQLite like 对 ASCII 不区分大小写；escape 防止 prompt 里的 %/_ 被当通配符
        const pattern = `%${input.query.trim().replace(/[\\%_]/g, "\\$&")}%`
        const match = (column: AnySQLiteColumn) => sql`${column} like ${pattern} escape '\\'`
        conditions.push(or(match(MediaAssetTable.prompt), match(MediaAssetTable.model), match(MediaAssetTable.params))!)
      }
      if (input.cursor) {
        const cursorRow = yield* db.select().from(MediaAssetTable).where(eq(MediaAssetTable.id, input.cursor)).get()
        if (cursorRow?.project_id === project.id) {
          conditions.push(
            or(
              lt(MediaAssetTable.time_created, cursorRow.time_created),
              and(eq(MediaAssetTable.time_created, cursorRow.time_created), lt(MediaAssetTable.id, cursorRow.id)),
            )!,
          )
        }
      }
      const rows = yield* db
        .select()
        .from(MediaAssetTable)
        .where(and(...conditions))
        .orderBy(desc(MediaAssetTable.time_created), desc(MediaAssetTable.id))
        .limit(limit + 1)
        .all()
      const items = rows.slice(0, limit) as Asset[]
      const next = rows.length > limit ? items[items.length - 1]?.id : undefined
      return { items, ...(next ? { next } : {}) }
    })

    const stats = Effect.fn("Media.Library.stats")(function* (input: StatsInput) {
      const project = yield* projectFor(input.directory)
      const rows = (yield* db
        .select()
        .from(MediaAssetTable)
        .where(eq(MediaAssetTable.project_id, project.id))
        .all()).filter(
        (row) =>
          (input.from === undefined || row.time_created >= input.from) &&
          (input.to === undefined || row.time_created < input.to),
      ) as Asset[]
      return aggregateStats(rows)
    })

    const get = Effect.fn("Media.Library.get")(function* (id: string) {
      const row = yield* db.select().from(MediaAssetTable).where(eq(MediaAssetTable.id, id)).get()
      return row as Asset | undefined
    })

    const remove = Effect.fn("Media.Library.remove")(function* (id: string) {
      const row = yield* db.select().from(MediaAssetTable).where(eq(MediaAssetTable.id, id)).get()
      if (!row) return yield* new NotFoundError({ id })
      // 先删记录再删文件：记录没了文件还在可重试清理；反过来会留孤儿记录
      yield* db.delete(MediaAssetTable).where(eq(MediaAssetTable.id, id)).run()
      const project = yield* projects.get(ProjectV2.ID.make(row.project_id))
      if (project) {
        const file = path.resolve(project.worktree, row.path)
        yield* Effect.tryPromise(() => rm(file, { force: true })).pipe(Effect.ignore)
        yield* Effect.tryPromise(() => rm(MediaPreview.directory(file), { recursive: true, force: true })).pipe(
          Effect.ignore,
        )
      }
    })

    const absolute = Effect.fn("Media.Library.absolute")(function* (directory: string, asset: Asset) {
      const resolved = path.resolve(directory, asset.path)
      const rel = path.relative(directory, resolved)
      if (rel.startsWith("..") || path.isAbsolute(rel)) {
        return yield* new PathError({ detail: `媒体产物路径越界: ${asset.path}` })
      }
      return resolved
    })

    return Service.of({
      ingest: (input) => uploads.withPermits(1)(ingest(input)),
      list,
      stats,
      get,
      remove,
      absolute,
    })
  }),
)

export const node = LayerNode.make({ service: Service, layer, deps: [Database.node, Project.node] })

export * as MediaLibrary from "./library"
