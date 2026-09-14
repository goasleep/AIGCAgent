import { NodeFileSystem } from "@effect/platform-node"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Cache, Context, Data, Effect, FileSystem, Layer, Option } from "effect"
import { createHash, randomUUID } from "node:crypto"
import path from "node:path"
import { MediaFFmpeg } from "./ffmpeg"

export interface Interface {
  readonly get: (file: string) => Effect.Effect<string, unknown>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Media/Preview") {}

class Source extends Data.Class<{ file: string; version: string }> {}

export function directory(file: string) {
  return path.join(path.dirname(file), ".previews", "v1", path.basename(file))
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const ffmpeg = yield* MediaFFmpeg.Service
    const cache = yield* Cache.make({
      capacity: 128,
      timeToLive: "1 minute",
      // FFmpeg resolves per-instance configuration at lookup time.
      requireServicesAt: "lookup",
      lookup: ({ file, version }: Source) =>
        Effect.gen(function* () {
          const output = path.join(directory(file), `${version}.jpg`)
          if (yield* fs.exists(output)) return output
          yield* fs.makeDirectory(directory(file), { recursive: true })
          const temporary = path.join(directory(file), `${randomUUID()}.jpg`)
          yield* ffmpeg
            .run(
              [
                "-v",
                "error",
                "-threads",
                "1",
                "-i",
                file,
                "-map",
                "0:v:0",
                "-frames:v",
                "1",
                "-vf",
                "scale=w='min(640,iw)':h='min(640,ih)':force_original_aspect_ratio=decrease",
                "-q:v",
                "4",
                "-threads",
                "1",
                temporary,
              ],
              { timeoutMs: 10_000 },
            )
            .pipe(
              Effect.andThen(() => fs.rename(temporary, output)),
              // Never expose a partially written JPEG, including on cancellation.
              Effect.ensuring(fs.remove(temporary, { force: true }).pipe(Effect.ignore)),
            )
          return output
        }).pipe(Effect.timeout("15 seconds")),
    })

    const get = Effect.fn("Media.Preview.get")(function* (file: string) {
      const info = yield* fs.stat(file)
      const version = createHash("sha256")
        .update(`${info.size}:${Option.getOrUndefined(info.mtime)?.getTime()}`)
        .digest("hex")
        .slice(0, 16)
      return yield* Cache.get(cache, new Source({ file, version }))
    })
    return Service.of({ get })
  }),
).pipe(Layer.provide(NodeFileSystem.layer))

export const node = LayerNode.make({ service: Service, layer, deps: [MediaFFmpeg.node] })

export * as MediaPreview from "./preview"
