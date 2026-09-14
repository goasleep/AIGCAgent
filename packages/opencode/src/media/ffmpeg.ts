import { Context, Effect, Layer, PlatformError, Ref, Schema, Semaphore, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import path from "path"
import { existsSync } from "fs"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Config } from "@/config/config"

const findOnPath = (name: string) => process.env.PATH?.split(path.delimiter).map((dir) => path.join(dir, name)).find(existsSync)

export class FfmpegNotFoundError extends Schema.TaggedErrorClass<FfmpegNotFoundError>()("Media.FFmpegNotFoundError", {}) {
  override get message() {
    return "未找到 ffmpeg。请安装系统 ffmpeg、配置 media.ffmpeg_path，或通过 OPENCODE_MEDIA_FFMPEG 指定路径（桌面端由安装包自带）"
  }
}

export class FfmpegError extends Schema.TaggedErrorClass<FfmpegError>()("Media.FFmpegError", {
  code: Schema.NullOr(Schema.Number),
  stderrTail: Schema.String,
}) {
  override get message() {
    return `ffmpeg 退出码 ${this.code}：${this.stderrTail.slice(-500)}`
  }
}

export class FfmpegTimeoutError extends Schema.TaggedErrorClass<FfmpegTimeoutError>()("Media.FFmpegTimeoutError", {
  timeoutMs: Schema.Number,
}) {
  override get message() {
    return `ffmpeg 超时（${this.timeoutMs}ms），已终止`
  }
}

export interface ProbeResult {
  format: { duration?: string; size?: string; bit_rate?: string }
  streams: Array<{
    codec_type?: string
    codec_name?: string
    width?: number
    height?: number
    duration?: string
    bit_rate?: string
  }>
}

export interface Interface {
  /** 解析后的 ffmpeg 绝对路径（env → config → 桌面随包 → PATH），找不到则失败 */
  readonly bin: () => Effect.Effect<string, FfmpegNotFoundError>
  readonly run: (
    args: string[],
    opts: { timeoutMs: number },
  ) => Effect.Effect<{ stderrTail: string }, FfmpegNotFoundError | FfmpegError | FfmpegTimeoutError | PlatformError.PlatformError>
  readonly probe: (file: string) => Effect.Effect<ProbeResult, FfmpegNotFoundError | FfmpegError | PlatformError.PlatformError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Media/FFmpeg") {}

const MAX_CONCURRENT = 2
const semaphore = Semaphore.makeUnsafe(MAX_CONCURRENT)

function resolveBin(override?: string): string | undefined {
  const fromEnv = process.env.OPENCODE_MEDIA_FFMPEG
  if (fromEnv) return fromEnv
  if (override) return override
  const exe = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg"
  // 桌面端 extraResources：process.resourcesPath/ffmpeg（二进制不进 asar）
  const candidates: string[] = []
  const resourcesPath = (process as { resourcesPath?: string }).resourcesPath
  if (resourcesPath) candidates.push(path.join(resourcesPath, "ffmpeg", exe))
  // 相对可执行文件的位置（兼容未设置 resourcesPath 的进程）
  const exeDir = path.dirname(process.execPath)
  candidates.push(
    path.join(exeDir, "resources", "ffmpeg", exe),
    path.join(exeDir, "..", "Resources", "ffmpeg", exe),
    path.join(exeDir, "ffmpeg", exe),
  )
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return findOnPath(exe)
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const config = yield* Config.Service

    let cachedBin: string | null | undefined
    const bin = () =>
      Effect.gen(function* () {
        if (cachedBin === undefined) {
          const info = yield* config.get()
          cachedBin = resolveBin(info.media?.ffmpeg_path) ?? null
        }
        if (cachedBin === null) return yield* new FfmpegNotFoundError()
        return cachedBin
      })

    /** stderr 是 ffmpeg 的进度通道：只留尾部 8KB 窗口，防刷屏撑爆内存 */
    const collectTail = (stream: Stream.Stream<Uint8Array, unknown>) =>
      Effect.gen(function* () {
        const ref = yield* Ref.make("")
        yield* Stream.runForEach(stream, (chunk) =>
          Ref.update(ref, (s) => (s + new TextDecoder().decode(chunk)).slice(-8_192)),
        ).pipe(Effect.ignore)
        return yield* Ref.get(ref)
      })

    // 中断语义：spawn 在 Effect.scoped 内，中断/超时会关闭 scope 并杀掉进程
    const run = (args: string[], opts: { timeoutMs: number }) =>
      Effect.gen(function* () {
        const ffmpeg = yield* bin()
        return yield* semaphore.withPermits(1)(
          Effect.scoped(
            Effect.gen(function* () {
              const handle = yield* spawner.spawn(
                ChildProcess.make(ffmpeg, ["-hide_banner", "-y", ...args], {
                  stdin: "ignore",
                  stdout: "ignore",
                  stderr: "pipe",
                }),
              )
              const [code, stderrTail] = yield* Effect.zip(
                handle.exitCode,
                collectTail(handle.stderr),
                { concurrent: true },
              ).pipe(
                Effect.timeoutOrElse({
                  duration: opts.timeoutMs,
                  orElse: () =>
                    Effect.suspend(() => {
                      handle.kill()
                      return Effect.fail(new FfmpegTimeoutError({ timeoutMs: opts.timeoutMs }))
                    }),
                }),
              )
              if (code !== 0) return yield* new FfmpegError({ code, stderrTail })
              return { stderrTail }
            }),
          ),
        )
      })

    const probe = (file: string) =>
      Effect.gen(function* () {
        const ffmpeg = yield* bin().pipe(Effect.catch(() => Effect.succeed<string | null>(null)))
        let ffprobe: string | undefined
        if (ffmpeg) {
          const candidate = path.join(path.dirname(ffmpeg), path.basename(ffmpeg).replace("ffmpeg", "ffprobe"))
          ffprobe = existsSync(candidate) ? candidate : findOnPath("ffprobe")
        } else {
          ffprobe = process.env.OPENCODE_MEDIA_FFPROBE ?? findOnPath("ffprobe")
        }
        if (!ffprobe) return yield* new FfmpegNotFoundError()
        const args = ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", file]
        return yield* Effect.scoped(
          Effect.gen(function* () {
            const handle = yield* spawner.spawn(
              ChildProcess.make(ffprobe, args, { stdin: "ignore", stdout: "pipe", stderr: "ignore" }),
            )
            const [raw, code] = yield* Effect.zip(
              Stream.mkString(Stream.decodeText(handle.stdout)),
              handle.exitCode,
              { concurrent: true },
            )
            if (code !== 0) return yield* new FfmpegError({ code, stderrTail: "" })
            return JSON.parse(raw) as ProbeResult
          }),
        )
      })

    return Service.of({ bin, run, probe })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [Config.node, CrossSpawnSpawner.node],
})

export * as MediaFFmpeg from "./ffmpeg"
