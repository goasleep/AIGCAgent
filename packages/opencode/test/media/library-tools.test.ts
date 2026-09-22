import { expect } from "bun:test"
import { Cause, Effect, Exit } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { AppNodeBuilderV1 } from "../../src/effect/app-node-builder-v1"
import { MediaGetTool, MediaListTool, MediaProcessTool } from "../../src/tool/media"
import { MediaLibrary } from "../../src/media/library"
import { MediaPreview } from "../../src/media/preview"
import { MediaFFmpeg } from "../../src/media/ffmpeg"
import { BackgroundJob } from "../../src/background/job"
import { Config } from "../../src/config/config"
import { Agent } from "../../src/agent/agent"
import { Truncate } from "../../src/tool/truncate"
import { InstanceStore } from "../../src/project/instance-store"
import { SessionID, MessageID } from "../../src/session/schema"
import { TestInstance, withTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(
  AppNodeBuilderV1.build(
    LayerNode.group([
      MediaLibrary.node,
      MediaPreview.node,
      MediaFFmpeg.node,
      BackgroundJob.node,
      Config.node,
      Agent.node,
      Truncate.node,
      InstanceStore.node,
    ]),
  ),
)
const ctx = {
  sessionID: SessionID.make("ses_media_library_test"),
  messageID: MessageID.make("msg_media_library_test"),
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
const MP4 = "data:video/mp4;base64,AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDE="

const ingest = (input: Parameters<MediaLibrary.Interface["ingest"]>[0]) =>
  Effect.flatMap(MediaLibrary.Service, (library) => library.ingest(input))

it.live(
  "lists, filters, and pages library assets and fetches one by id",
  () =>
    Effect.gen(function* () {
      const directory = (yield* TestInstance).directory
      const cat = yield* ingest({
        directory,
        source: { type: "dataUrl", url: PNG },
        kind: "image",
        source_kind: "generate",
        model: "gpt-image-2",
        prompt: "a cat in space",
      })
      const dog = yield* ingest({
        directory,
        source: { type: "dataUrl", url: PNG },
        kind: "image",
        source_kind: "generate",
        model: "gpt-image-2",
        prompt: "a dog on the beach",
      })
      const clip = yield* ingest({
        directory,
        source: { type: "dataUrl", url: MP4 },
        kind: "video",
        source_kind: "upload",
        params: { filename: "holiday.mp4" },
      })

      const info = yield* MediaListTool
      const tool = yield* info.init()
      const run = (params: Parameters<typeof tool.execute>[0]) =>
        Effect.map(tool.execute(params, ctx), (result) => JSON.parse(result.output))

      const all = yield* run({})
      expect(all.count).toBe(3)
      expect(all.items.map((item: { id: string }) => item.id)).toEqual([clip.id, dog.id, cat.id])
      expect(all.items[0]).toMatchObject({ kind: "video", source: "upload" })

      expect(((yield* run({ kind: "image" })) as { count: number }).count).toBe(2)
      expect(
        ((yield* run({ source: "upload" })) as { items: { id: string }[] }).items.map((item) => item.id),
      ).toEqual([clip.id])
      expect(
        ((yield* run({ query: "beach" })) as { items: { id: string }[] }).items.map((item) => item.id),
      ).toEqual([dog.id])
      // 上传素材按原始文件名可搜
      expect(
        ((yield* run({ query: "holiday" })) as { items: { id: string }[] }).items.map((item) => item.id),
      ).toEqual([clip.id])
      expect(((yield* run({ query: "gpt-image" })) as { count: number }).count).toBe(2)

      const page1 = yield* run({ limit: 2 })
      expect(page1.items.map((item: { id: string }) => item.id)).toEqual([clip.id, dog.id])
      expect(page1.next_cursor).toBe(dog.id)
      const page2 = yield* run({ limit: 2, cursor: page1.next_cursor })
      expect(page2.items.map((item: { id: string }) => item.id)).toEqual([cat.id])
      expect(page2.next_cursor).toBeNull()

      const getInfo = yield* MediaGetTool
      const get = yield* getInfo.init()
      const asset = JSON.parse((yield* get.execute({ id: cat.id }, ctx)).output)
      expect(asset).toMatchObject({ id: cat.id, path: cat.path, prompt: "a cat in space" })
      expect(asset.content_url).toContain("/media/content?")

      const missing = yield* get.execute({ id: "med_missing0000000000000000" }, ctx).pipe(Effect.exit)
      expect(Exit.isFailure(missing)).toBe(true)
    }).pipe(
      withTmpdirInstance({
        git: true,
        config: { media: { image_model: "gpt-image-2" } },
      }),
    ),
  30000,
)

it.live("accepts media library asset ids as process inputs and rejects unknown ones", () =>
  Effect.gen(function* () {
    const directory = (yield* TestInstance).directory
    const source = yield* ingest({
      directory,
      source: { type: "dataUrl", url: PNG },
      kind: "image",
      source_kind: "upload",
      params: { filename: "dot.png" },
    })

    const info = yield* MediaProcessTool
    const tool = yield* info.init()
    const result = yield* tool.execute(
      { template: "resize_image", inputs: [source.id], output: "resized.png", params: { width: 4, height: 4 } },
      ctx,
    )
    expect(result.metadata.asset_id).not.toBeNull()
    const library = yield* MediaLibrary.Service
    expect((yield* library.get(result.metadata.asset_id!))?.width).toBe(4)

    const missing = yield* tool
      .execute(
        { template: "resize_image", inputs: ["med_missing00000000000000"], output: "resized2.png", params: { width: 4 } },
        ctx,
      )
      .pipe(Effect.exit)
    if (Exit.isFailure(missing)) {
      const error = Cause.squash(missing.cause)
      expect(error).toBeInstanceOf(Error)
      expect((error as Error).message).toContain("med_missing")
    } else {
      throw new Error("expected unknown asset id to fail")
    }
  }).pipe(withTmpdirInstance({ git: true })),
)
