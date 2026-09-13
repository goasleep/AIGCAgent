import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { probe, runFfmpeg } from "../src/ffmpeg"

// 需要本机 ffmpeg；用 ffmpeg 自己造测试素材，再对各模板做端到端断言
let dir: string

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "media-mcp-it-"))
  // 4 秒测试视频（testsrc 自带时间戳画面，1280x720）
  await runFfmpeg(
    ["-f", "lavfi", "-i", "testsrc=duration=4:size=1280x720:rate=30", "-c:v", "libx264", "-pix_fmt", "yuv420p", path.join(dir, "in.mp4")],
    { timeoutMs: 60_000 },
  )
})

afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe("ffmpeg 集成（模板端到端）", () => {
  test("trim 快剪：时长 ≈2s", async () => {
    const out = path.join(dir, "trim.mp4")
    await runFfmpeg(["-ss", "1", "-i", path.join(dir, "in.mp4"), "-t", "2", "-c", "copy", out], { timeoutMs: 60_000 })
    const info = await probe(out)
    expect(Number(info.format.duration)).toBeGreaterThan(1)
    expect(Number(info.format.duration)).toBeLessThan(3)
  })

  test("trim_exact：帧精确 2s ±0.1", async () => {
    const out = path.join(dir, "trim-exact.mp4")
    await runFfmpeg(
      ["-ss", "1", "-i", path.join(dir, "in.mp4"), "-t", "2", "-c:v", "libx264", "-crf", "18", "-c:a", "aac", out],
      { timeoutMs: 60_000 },
    )
    const info = await probe(out)
    expect(Math.abs(Number(info.format.duration) - 2)).toBeLessThan(0.1)
  })

  test("thumbnail：产出单帧图片", async () => {
    const out = path.join(dir, "thumb.jpg")
    await runFfmpeg(["-ss", "1", "-i", path.join(dir, "in.mp4"), "-frames:v", "1", "-q:v", "2", out], { timeoutMs: 60_000 })
    const info = await probe(out)
    expect(info.streams[0]?.codec_type).toBe("video")
    expect(info.streams[0]?.width).toBe(1280)
  })

  test("make_gif：palettegen/paletteuse 链路", async () => {
    const out = path.join(dir, "out.gif")
    await runFfmpeg(
      [
        "-i", path.join(dir, "in.mp4"),
        "-filter_complex", "fps=6,scale=160:-1:flags=lanczos,split[a][b];[a]palettegen[pal];[b][pal]paletteuse",
        out,
      ],
      { timeoutMs: 60_000 },
    )
    const info = await probe(out)
    expect(info.streams[0]?.codec_name).toBe("gif")
  })

  test("extract_frames fps：产出多帧", async () => {
    const pattern = path.join(dir, "f-%03d.png")
    await runFfmpeg(["-i", path.join(dir, "in.mp4"), "-vf", "fps=1", "-f", "image2", pattern], { timeoutMs: 60_000 })
    const { readdir } = await import("node:fs/promises")
    const frames = (await readdir(dir)).filter((f) => f.startsWith("f-"))
    expect(frames.length).toBe(4)
  })

  test("transcode vp9：编码器正确", async () => {
    const out = path.join(dir, "vp9.webm")
    await runFfmpeg(
      ["-i", path.join(dir, "in.mp4"), "-c:v", "libvpx-vp9", "-crf", "30", "-b:v", "0", "-c:a", "libopus", out],
      { timeoutMs: 120_000 },
    )
    const info = await probe(out)
    expect(info.streams[0]?.codec_name).toBe("vp9")
  })

  test("probe 返回时长与流", async () => {
    const info = await probe(path.join(dir, "in.mp4"))
    expect(Number(info.format.duration)).toBeCloseTo(4, 0)
    expect(info.streams.some((s) => s.codec_type === "video")).toBe(true)
  })

  test("非零退出码抛 FfmpegError 且带 stderr 尾部", async () => {
    await expect(
      runFfmpeg(["-i", path.join(dir, "missing.mp4"), path.join(dir, "x.mp4")], { timeoutMs: 10_000 }),
    ).rejects.toThrow(/退出码/)
  })
})
