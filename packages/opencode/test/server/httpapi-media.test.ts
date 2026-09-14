import { NodeHttpServer, NodeServices } from "@effect/platform-node"
import { expect } from "bun:test"
import { Config, ConfigProvider, Context, Effect, Layer } from "effect"
import { HttpClient, HttpRouter, HttpServer } from "effect/unstable/http"
import { Socket } from "effect/unstable/socket"
import { AppNodeBuilderV1 } from "../../src/effect/app-node-builder-v1"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { MediaAssetTable } from "@opencode-ai/core/media/sql"
import { eq } from "drizzle-orm"
import { MediaLibrary } from "../../src/media/library"
import { MediaFFmpeg } from "../../src/media/ffmpeg"
import { MediaPreview } from "../../src/media/preview"
import path from "node:path"
import { access } from "node:fs/promises"
import { BackgroundJob } from "../../src/background/job"
import { InstanceStore } from "../../src/project/instance-store"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { resetDatabase } from "../fixture/db"
import { tmpdirScoped } from "../fixture/fixture"
import { testEffect, testEffectShared } from "../lib/effect"

const state = Layer.effectDiscard(
  Effect.gen(function* () {
    yield* Effect.promise(() => resetDatabase())
    yield* Effect.addFinalizer(() => Effect.promise(() => resetDatabase()))
  }),
)

// Exercise the production route tree over a real socket, including middleware
// and relative Node request URLs. A web Request alone misses this regression.
const routes: Layer.Layer<never, Config.ConfigError, HttpServer.HttpServer> = HttpRouter.serve(HttpApiApp.routes, {
  disableListenLog: true,
  disableLogger: true,
})
const server = routes.pipe(
  Layer.provide(Socket.layerWebSocketConstructorGlobal),
  Layer.provideMerge(NodeHttpServer.layerTest),
  Layer.provideMerge(NodeServices.layer),
)
const services = AppNodeBuilderV1.build(
  LayerNode.group([
    MediaLibrary.node,
    MediaPreview.node,
    MediaFFmpeg.node,
    BackgroundJob.node,
    InstanceStore.node,
    Database.node,
  ]),
)
const it = testEffect(Layer.mergeAll(state, server, services))
const authenticated = testEffect(
  Layer.mergeAll(server, services).pipe(
    Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ OPENCODE_SERVER_PASSWORD: "media-test-secret" }))),
  ),
)

it.live("loads an empty project's library, stats and tasks as JSON", () =>
  Effect.gen(function* () {
    const directory = yield* tmpdirScoped({ git: true })
    for (const endpoint of ["/media", "/media/stats", "/media/tasks"]) {
      const response = yield* HttpClient.get(`${endpoint}?${new URLSearchParams({ directory })}`)
      expect(response.status).toBe(200)
      expect(response.headers["content-type"]).toContain("application/json")
      expect(yield* response.json).toMatchObject(endpoint === "/media/stats" ? { count: 0, bytes: 0 } : { items: [] })
    }
  }),
)

it.live("lists, filters, streams, seeks and deletes persisted assets without crossing projects", () =>
  Effect.gen(function* () {
    const directory = yield* tmpdirScoped({ git: true })
    const other = yield* tmpdirScoped({ git: true })
    const library = yield* MediaLibrary.Service
    const image = yield* library.ingest({
      directory,
      source: { type: "dataUrl", url: "data:image/png;base64,aW1hZ2U=" },
      kind: "image",
      source_kind: "generate",
    })
    const video = yield* library.ingest({
      directory,
      source: { type: "dataUrl", url: "data:video/mp4;base64,MDEyMzQ1Njc4OQ==" },
      kind: "video",
      source_kind: "generate",
    })
    const url = (endpoint: string, params: Record<string, string> = {}) =>
      `${endpoint}?${new URLSearchParams({ directory, ...params })}`
    const list = yield* HttpClient.get(url("/media", { kind: "image" }))
    expect(yield* list.json).toMatchObject({ items: [{ id: image.id }] })
    const stats = yield* HttpClient.get(url("/media/stats"))
    expect(yield* stats.json).toMatchObject({ count: 2, bytes: 15 })
    const asset = yield* HttpClient.get(url("/media/asset", { id: image.id }))
    expect(yield* asset.json).toMatchObject({ id: image.id })
    const content = yield* HttpClient.get(url("/media/content", { id: image.id }))
    expect({ status: content.status, body: yield* content.text }).toEqual({ status: 200, body: "image" })
    expect(content.headers["content-type"]).toContain("image/png")
    expect(content.headers["cache-control"]).toBe("private, max-age=3600")
    const cached = yield* HttpClient.get(url("/media/content", { id: image.id }), {
      headers: { "if-none-match": content.headers.etag! },
    })
    expect(cached.status).toBe(304)
    expect(yield* cached.text).toBe("")
    expect(yield* content.text).toBe("image")
    for (const [range, body] of [
      ["bytes=2-5", "2345"],
      ["bytes=-3", "789"],
      ["bytes=7-", "789"],
    ]) {
      const response = yield* HttpClient.get(url("/media/content", { id: video.id }), { headers: { range } })
      expect(response.status).toBe(206)
      expect(yield* response.text).toBe(body)
    }
    const invalid = yield* HttpClient.get(url("/media/content", { id: video.id }), { headers: { range: "bytes=99-" } })
    expect(invalid.status).toBe(416)
    for (const endpoint of ["/media/asset", "/media/content"]) {
      expect((yield* HttpClient.get(url(endpoint, { directory: other, id: image.id }))).status).toBe(404)
    }
    expect((yield* HttpClient.del(url("/media/asset", { directory: other, id: image.id }))).status).toBe(404)
    expect((yield* HttpClient.del(url("/media/asset", { id: image.id }))).status).toBe(204)
    expect((yield* HttpClient.get(url("/media/content", { id: image.id }))).status).toBe(404)
  }),
)

it.live("serves and caches small JPEG previews without bypassing ownership or deletion", () =>
  Effect.gen(function* () {
    const directory = yield* tmpdirScoped({ git: true })
    const other = yield* tmpdirScoped({ git: true })
    const library = yield* MediaLibrary.Service
    const ffmpeg = yield* MediaFFmpeg.Service
    const store = yield* InstanceStore.Service
    const input = path.join(directory, "large.png")
    yield* store.provide(
      { directory },
      ffmpeg.run(["-f", "lavfi", "-i", "testsrc2=size=1536x1024:rate=1", "-frames:v", "1", input], {
        timeoutMs: 10_000,
      }),
    )
    const asset = yield* library.ingest({
      directory,
      source: { type: "file", path: input },
      kind: "image",
      source_kind: "generate",
    })
    const url = (dir = directory) =>
      `/media/content?${new URLSearchParams({ directory: dir, id: asset.id, preview: "thumbnail" })}`
    const response = yield* HttpClient.get(url())
    expect(response.status).toBe(200)
    expect(response.headers["content-type"]).toContain("image/jpeg")
    const bytes = new Uint8Array(yield* response.arrayBuffer)
    expect([...bytes.slice(0, 2)]).toEqual([0xff, 0xd8])
    expect(bytes.byteLength).toBeLessThan(asset.bytes)
    expect(response.headers["cache-control"]).toBe("private, max-age=3600")
    const headers = { "if-none-match": response.headers.etag! }
    expect((yield* HttpClient.get(url(), { headers })).status).toBe(304)
    expect((yield* HttpClient.get(url(other), { headers })).status).toBe(404)
    const preview = MediaPreview.directory(path.join(directory, asset.path))
    expect(yield* Effect.promise(() => Bun.file(path.join(directory, asset.path)).exists())).toBe(true)
    expect((yield* HttpClient.del(`/media/asset?${new URLSearchParams({ directory, id: asset.id })}`)).status).toBe(204)
    expect((yield* HttpClient.get(url(), { headers })).status).toBe(404)
    expect(
      yield* Effect.promise(() =>
        access(preview).then(
          () => true,
          () => false,
        ),
      ),
    ).toBe(false)
  }),
)

it.live("paginates assets created at the same timestamp without omissions", () =>
  Effect.gen(function* () {
    const directory = yield* tmpdirScoped({ git: true })
    const library = yield* MediaLibrary.Service
    const db = (yield* Database.Service).db
    const assets = yield* Effect.forEach([1, 2, 3], () =>
      library.ingest({
        directory,
        source: { type: "dataUrl", url: "data:image/png;base64,aW1hZ2U=" },
        kind: "image",
        source_kind: "generate",
      }),
    )
    // Force timestamp ties in persisted rows; Date.now is deliberately not mocked.
    yield* Effect.forEach(assets, (asset) =>
      db.update(MediaAssetTable).set({ time_created: 1000 }).where(eq(MediaAssetTable.id, asset.id)).run(),
    )
    const seen: string[] = []
    let cursor: string | undefined
    for (let page = 0; page < 3; page++) {
      const response = yield* HttpClient.get(
        `/media?${new URLSearchParams({ directory, limit: "1", ...(cursor ? { cursor } : {}) })}`,
      )
      const body = (yield* response.json) as { items: { id: string }[]; next?: string }
      expect(body.items).toHaveLength(1)
      seen.push(body.items[0].id)
      cursor = body.next
    }
    expect(seen.sort()).toEqual(assets.map((asset) => asset.id).sort())
    expect(cursor).toBeUndefined()
  }),
)

it.live("binds task listing and cancellation to the requesting instance", () =>
  Effect.gen(function* () {
    const directory = yield* tmpdirScoped({ git: true })
    const other = yield* tmpdirScoped({ git: true })
    const store = yield* InstanceStore.Service
    const jobs = yield* BackgroundJob.Service
    const job = yield* store.provide({ directory }, jobs.start({ type: "media_generate_video", run: Effect.never }))
    const url = (endpoint: string, dir = directory) =>
      `${endpoint}?${new URLSearchParams({ directory: dir, id: job.id })}`
    const list = yield* HttpClient.get(url("/media/tasks"))
    expect(yield* list.json).toMatchObject({ items: [{ id: job.id, status: "running" }] })
    expect((yield* HttpClient.get(url("/media/task", other))).status).toBe(404)
    expect((yield* HttpClient.del(url("/media/task", other))).status).toBe(404)
    const cancelled = yield* HttpClient.del(url("/media/task"))
    expect(yield* cancelled.json).toMatchObject({ id: job.id, status: "cancelled" })
  }),
)

it.live("rejects invalid pagination and missing assets with 4xx responses", () =>
  Effect.gen(function* () {
    const directory = yield* tmpdirScoped({ git: true })
    for (const limit of ["0", "-1", "1.5", "bad", "201"]) {
      expect((yield* HttpClient.get(`/media?${new URLSearchParams({ directory, limit })}`)).status).toBe(400)
    }
    expect((yield* HttpClient.get(`/media/asset?${new URLSearchParams({ directory, id: "missing" })}`)).status).toBe(
      404,
    )
  }),
)

authenticated.live("protects all media endpoints and accepts native preview query authentication", () =>
  Effect.gen(function* () {
    const directory = yield* tmpdirScoped({ git: true })
    const library = yield* MediaLibrary.Service
    const asset = yield* library.ingest({
      directory,
      source: { type: "dataUrl", url: "data:image/png;base64,aW1hZ2U=" },
      kind: "image",
      source_kind: "generate",
    })
    const token = Buffer.from("opencode:media-test-secret").toString("base64")
    for (const endpoint of [
      "/media",
      "/media/stats",
      "/media/tasks",
      "/media/task",
      "/media/asset",
      "/media/content",
    ]) {
      expect((yield* HttpClient.get(`${endpoint}?${new URLSearchParams({ directory, id: asset.id })}`)).status).toBe(
        401,
      )
    }
    const url = `/media/content?${new URLSearchParams({ directory, id: asset.id, auth_token: token })}`
    expect(
      (yield* HttpClient.get(
        `/media/content?${new URLSearchParams({ directory, id: asset.id, preview: "thumbnail" })}`,
      )).status,
    ).toBe(401)
    const preview = yield* HttpClient.get(url)
    expect(preview.status).toBe(200)
    expect(yield* preview.text).toBe("image")
    const list = yield* HttpClient.get(`/media?${new URLSearchParams({ directory })}`, {
      headers: { authorization: `Basic ${token}` },
    })
    expect(list.status).toBe(200)
    expect(yield* list.json).toMatchObject({ items: [{ id: asset.id }] })
  }),
)

testEffectShared(Layer.mergeAll(services, NodeServices.layer)).live(
  "streams bytes through the Web handler as well as Node sockets",
  () =>
    Effect.gen(function* () {
      const directory = yield* tmpdirScoped({ git: true })
      const library = yield* MediaLibrary.Service
      const asset = yield* library.ingest({
        directory,
        source: { type: "dataUrl", url: "data:image/png;base64,aW1hZ2U=" },
        kind: "image",
        source_kind: "generate",
      })
      const response = yield* Effect.promise(() =>
        HttpApiApp.webHandler().handler(
          new Request(`http://localhost/media/content?${new URLSearchParams({ directory, id: asset.id })}`),
          Context.empty() as Context.Context<unknown>,
        ),
      )
      expect(response.status).toBe(200)
      expect(yield* Effect.promise(() => response.text())).toBe("image")
    }),
)
