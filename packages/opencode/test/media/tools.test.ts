import { expect } from "bun:test"
import { createServer } from "node:http"
import { json } from "node:stream/consumers"
import { Effect, Fiber } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { AppNodeBuilderV1 } from "../../src/effect/app-node-builder-v1"
import { MediaGenerateImageTool, MediaGenerateVideoTool } from "../../src/tool/media"
import { MediaLibrary } from "../../src/media/library"
import { MediaPreview } from "../../src/media/preview"
import { BackgroundJob } from "../../src/background/job"
import { Config } from "../../src/config/config"
import { Agent } from "../../src/agent/agent"
import { Truncate } from "../../src/tool/truncate"
import { InstanceStore } from "../../src/project/instance-store"
import { SessionID, MessageID } from "../../src/session/schema"
import { TestInstance, withTmpdirInstance } from "../fixture/fixture"
import { testEffect, pollWithTimeout } from "../lib/effect"

const it = testEffect(
  AppNodeBuilderV1.build(
    LayerNode.group([
      MediaLibrary.node,
      MediaPreview.node,
      BackgroundJob.node,
      Config.node,
      Agent.node,
      Truncate.node,
      InstanceStore.node,
    ]),
  ),
)
const ctx = {
  sessionID: SessionID.make("ses_media_test"),
  messageID: MessageID.make("msg_media_test"),
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

// A local provider speaks the real wire protocol; tools, config, background
// jobs and filesystem/database ingestion are the production implementations.
const upstream = Effect.acquireRelease(
  Effect.promise(async () => {
    const requests: { path: string; body?: unknown; authorization?: string }[] = []
    const state = { polls: 0, submittedAt: 0 }
    const server = createServer(async (req, res) => {
      const url = new URL(req.url!, `http://${req.headers.host}`)
      requests.push({
        path: url.pathname,
        authorization: req.headers.authorization,
        ...(req.method === "POST" && req.headers["content-type"]?.includes("application/json")
          ? { body: await json(req) }
          : {}),
      })
      if (url.pathname === "/v1/images/edits") {
        const chunks: Buffer[] = []
        for await (const chunk of req) chunks.push(Buffer.from(chunk))
        expect(Buffer.concat(chunks).toString()).toContain('name="image"')
      }
      res.setHeader("content-type", "application/json")
      if (url.pathname.startsWith("/v1/images/")) return res.end(JSON.stringify({ data: [{ b64_json: "aW1hZ2U=" }] }))
      if (url.pathname === "/v1/videos") {
        state.submittedAt = Date.now()
        return res.end(JSON.stringify({ video_id: "video_test" }))
      }
      if (url.pathname === "/agnesapi") {
        state.polls++
        return res.end(
          JSON.stringify(
            // Model a slow provider independently of when the client starts polling.
            Date.now() - state.submittedAt < 31_000
              ? { status: "running", progress: 77 }
              : { status: "completed", url: `${url.origin}/result.mp4` },
          ),
        )
      }
      if (url.pathname === "/result.mp4") return res.end("test video bytes")
      res.writeHead(404).end()
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("missing test listener")
    return { url: `http://127.0.0.1:${address.port}/v1`, requests, server, state }
  }),
  ({ server }) => Effect.promise(() => new Promise<void>((resolve) => server.close(() => resolve()))),
)

it.live(
  "generates then edits an image using saved media credentials and normalizes a portrait ratio",
  () =>
    Effect.gen(function* () {
      const provider = yield* upstream
      yield* Effect.gen(function* () {
        const info = yield* MediaGenerateImageTool
        const tool = yield* info.init()
        const generated = yield* tool.execute({ prompt: "cat", size: "9:16", quality: "medium" }, ctx)
        const library = yield* MediaLibrary.Service
        const asset = yield* library.get(generated.metadata.asset_id)
        expect(asset?.kind).toBe("image")
        const jobs = yield* BackgroundJob.Service
        const preview = yield* pollWithTimeout(
          jobs.list().pipe(Effect.map((items) => items.find((item) => item.type === "media_preview"))),
          "image preview job did not start",
        )
        expect(preview.metadata).toMatchObject({ asset_id: asset!.id })
        const edited = yield* tool.execute({ prompt: "edit cat", image: asset!.path, size: "1024x1536" }, ctx)
        expect(edited.metadata.asset_id).not.toBe(asset!.id)
        expect(provider.requests.map((req) => req.path)).toEqual(["/v1/images/generations", "/v1/images/edits"])
        expect(provider.requests[0].body).toMatchObject({ model: "gpt-image-2", size: "1024x1536", quality: "medium" })
        expect(provider.requests.every((req) => req.authorization === "Bearer dedicated-media-test-key")).toBe(true)
        expect((yield* library.list({ directory: (yield* TestInstance).directory })).items).toHaveLength(2)
      }).pipe(
        withTmpdirInstance({
          git: true,
          config: {
            media: {
              image_model: "gpt-image-2",
              openai_base_url: provider.url,
              openai_api_key: "dedicated-media-test-key",
            },
          },
        }),
      )
    }),
  30000,
)

it.live(
  "waits beyond 30 seconds for video completion and saves the resulting asset",
  () =>
    Effect.gen(function* () {
      const provider = yield* upstream
      yield* Effect.gen(function* () {
        const info = yield* MediaGenerateVideoTool
        const tool = yield* info.init()
        const started = Date.now()
        const result = yield* tool.execute({ prompt: "cat chasing mouse", duration: 4, model: "agnes" }, ctx)
        expect(Date.now() - started).toBeGreaterThan(30000)
        const library = yield* MediaLibrary.Service
        expect((yield* library.get(result.metadata.asset_id))?.kind).toBe("video")
        const preview = yield* pollWithTimeout(
          (yield* BackgroundJob.Service)
            .list()
            .pipe(Effect.map((items) => items.find((item) => item.type === "media_preview"))),
          "video preview job did not start",
        )
        expect(preview.metadata).toMatchObject({ asset_id: result.metadata.asset_id })
        expect(result.attachments?.[0].url).toContain("/media/content?")
        expect(provider.requests.filter((req) => req.path === "/v1/videos")).toHaveLength(1)
      }).pipe(
        withTmpdirInstance({
          git: true,
          config: { media: { agnes_base_url: provider.url, agnes_api_key: "dedicated-media-test-key" } },
        }),
      )
    }),
  60000,
)

it.live(
  "reports provider polling progress into the background media job",
  () =>
    Effect.gen(function* () {
      const provider = yield* upstream
      yield* Effect.gen(function* () {
        const info = yield* MediaGenerateVideoTool
        const tool = yield* info.init()
        const jobs = yield* BackgroundJob.Service
        const fiber = yield* tool.execute({ prompt: "cat", model: "agnes" }, ctx).pipe(Effect.forkScoped)
        const reported = yield* pollWithTimeout(
          jobs.list().pipe(
            Effect.map((items) =>
              items.find(
                (item) =>
                  item.type === "media_generate_video" && typeof item.metadata?.progress === "number",
              ),
            ),
          ),
          "video job never reported progress",
        )
        expect(reported.metadata!.progress).toBe(77)
        expect(typeof reported.metadata!.elapsed_ms).toBe("number")
        yield* Fiber.interrupt(fiber)
      }).pipe(
        withTmpdirInstance({
          git: true,
          config: { media: { agnes_base_url: provider.url, agnes_api_key: "dedicated-media-test-key" } },
        }),
      )
    }),
  30000,
)

it.live(
  "cancels the background media job when the tool is interrupted",
  () =>
    Effect.gen(function* () {
      const provider = yield* upstream
      yield* Effect.gen(function* () {
        const info = yield* MediaGenerateVideoTool
        const tool = yield* info.init()
        const jobs = yield* BackgroundJob.Service
        const fiber = yield* tool.execute({ prompt: "cat", model: "agnes" }, ctx).pipe(Effect.forkScoped)
        const job = yield* pollWithTimeout(jobs.list().pipe(Effect.map((items) => items[0])), "video job did not start")
        yield* Fiber.interrupt(fiber)
        expect((yield* jobs.get(job.id))?.status).toBe("cancelled")
        expect(provider.requests.filter((req) => req.path === "/v1/videos")).toHaveLength(1)
      }).pipe(
        withTmpdirInstance({
          git: true,
          config: { media: { agnes_base_url: provider.url, agnes_api_key: "dedicated-media-test-key" } },
        }),
      )
    }),
  30000,
)
