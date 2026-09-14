import { expect } from "bun:test"
import { Effect } from "effect"
import path from "node:path"
import { readdir, stat } from "node:fs/promises"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { AppNodeBuilderV1 } from "../../src/effect/app-node-builder-v1"
import { MediaPreview } from "../../src/media/preview"
import { MediaFFmpeg } from "../../src/media/ffmpeg"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(AppNodeBuilderV1.build(LayerNode.group([MediaPreview.node, MediaFFmpeg.node])))

it.instance("creates bounded image/video previews once and preserves originals", () =>
  Effect.gen(function* () {
    const instance = yield* TestInstance
    const ffmpeg = yield* MediaFFmpeg.Service
    const previews = yield* MediaPreview.Service
    const image = path.join(instance.directory, "source.png")
    const video = path.join(instance.directory, "source.mp4")
    yield* ffmpeg.run(["-f", "lavfi", "-i", "testsrc2=size=1536x1024:rate=1", "-frames:v", "1", image], {
      timeoutMs: 10_000,
    })
    yield* ffmpeg.run(["-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=1", "-t", "1", "-c:v", "mpeg4", video], {
      timeoutMs: 10_000,
    })
    const original = yield* Effect.promise(() => Bun.file(image).arrayBuffer())
    const files = yield* Effect.all([previews.get(image), previews.get(image), previews.get(video)], {
      concurrency: "unbounded",
    })
    expect(files[0]).toBe(files[1])
    const imageInfo = yield* ffmpeg.probe(files[0])
    const videoInfo = yield* ffmpeg.probe(files[2])
    expect(imageInfo.streams[0]).toMatchObject({ codec_name: "mjpeg", width: 640 })
    expect(imageInfo.streams[0].height).toBeLessThanOrEqual(640)
    expect(videoInfo.streams[0]).toMatchObject({ codec_name: "mjpeg", width: 640, height: 360 })
    const before = yield* Effect.promise(() => stat(files[0]))
    expect(yield* previews.get(image)).toBe(files[0])
    expect((yield* Effect.promise(() => stat(files[0]))).mtimeMs).toBe(before.mtimeMs)
    expect(yield* Effect.promise(() => readdir(MediaPreview.directory(image)))).toEqual([path.basename(files[0])])
    expect(yield* Effect.promise(() => Bun.file(image).arrayBuffer())).toEqual(original)
    expect(before.size).toBeLessThan(original.byteLength)
    yield* ffmpeg.run(["-f", "lavfi", "-i", "testsrc2=size=320x200:rate=1", "-frames:v", "1", image], {
      timeoutMs: 10_000,
    })
    const changed = yield* previews.get(image)
    expect(changed).not.toBe(files[0])
    expect((yield* ffmpeg.probe(changed)).streams[0]).toMatchObject({ width: 320, height: 200 })
  }),
)

it.instance("fails safely for invalid media and removes partial outputs", () =>
  Effect.gen(function* () {
    const instance = yield* TestInstance
    const previews = yield* MediaPreview.Service
    const file = path.join(instance.directory, "invalid.png")
    yield* Effect.promise(() => Bun.write(file, "invalid image"))
    expect((yield* Effect.exit(previews.get(file)))._tag).toBe("Failure")
    expect(yield* Effect.promise(() => readdir(MediaPreview.directory(file)))).toEqual([])
    expect(yield* Effect.promise(() => Bun.file(file).text())).toBe("invalid image")
  }),
)
