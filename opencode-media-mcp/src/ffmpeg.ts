import { spawn } from "node:child_process"

export class FfmpegError extends Error {
  constructor(
    readonly code: number | null,
    readonly stderrTail: string,
  ) {
    super(`ffmpeg 退出码 ${code}：${stderrTail.slice(-500)}`)
    this.name = "FfmpegError"
  }
}

export class FfmpegTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`ffmpeg 超时（${timeoutMs}ms），已 SIGKILL`)
    this.name = "FfmpegTimeoutError"
  }
}

const MAX_CONCURRENT = 2
let active = 0
const waiters: (() => void)[] = []

function acquire(): Promise<void> {
  if (active < MAX_CONCURRENT) {
    active++
    return Promise.resolve()
  }
  return new Promise<void>((resolve) => waiters.push(resolve)).then(() => {
    active++
  })
}

function release() {
  active--
  const next = waiters.shift()
  if (next) next()
}

export function ffmpegBin(): string {
  return process.env.OPENCODE_MEDIA_FFMPEG ?? "ffmpeg"
}

export interface RunOptions {
  timeoutMs: number
  signal?: AbortSignal
}

/** spawn 数组形式执行 ffmpeg（不走 shell，杜绝注入）；stderr 只留尾部 8KB；超时 SIGKILL */
export async function runFfmpeg(args: string[], opts: RunOptions): Promise<{ stderrTail: string }> {
  await acquire()
  try {
    return await new Promise((resolvePromise, rejectPromise) => {
      const proc = spawn(ffmpegBin(), ["-hide_banner", "-y", ...args], { stdio: ["ignore", "ignore", "pipe"] })
      let stderrTail = ""
      proc.stderr?.on("data", (chunk: Buffer) => {
        stderrTail = (stderrTail + chunk.toString()).slice(-8_192)
      })
      const timer = setTimeout(() => {
        proc.kill("SIGKILL")
        rejectPromise(new FfmpegTimeoutError(opts.timeoutMs))
      }, opts.timeoutMs)
      opts.signal?.addEventListener("abort", () => {
        proc.kill("SIGKILL")
        rejectPromise(new Error("aborted"))
      })
      proc.on("error", (err) => {
        clearTimeout(timer)
        rejectPromise(err)
      })
      proc.on("close", (code) => {
        clearTimeout(timer)
        if (code === 0) resolvePromise({ stderrTail })
        else rejectPromise(new FfmpegError(code, stderrTail))
      })
    })
  } finally {
    release()
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

export async function probe(file: string): Promise<ProbeResult> {
  const bin = process.env.OPENCODE_MEDIA_FFPROBE ?? "ffprobe"
  const args = ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", file]
  const raw = await new Promise<string>((resolvePromise, rejectPromise) => {
    const proc = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] })
    let stdout = ""
    let stderr = ""
    proc.stdout.on("data", (c: Buffer) => (stdout += c.toString()))
    proc.stderr.on("data", (c: Buffer) => (stderr += c.toString()))
    proc.on("error", rejectPromise)
    proc.on("close", (code) => {
      if (code === 0) resolvePromise(stdout)
      else rejectPromise(new FfmpegError(code, stderr))
    })
  })
  return JSON.parse(raw) as ProbeResult
}
