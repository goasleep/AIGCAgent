import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { spawn, type ChildProcess } from "node:child_process"
import { runFfmpeg } from "../src/ffmpeg"

// MCP 协议级 E2E：真实 stdio server，覆盖 §4.7 验收 1/4 与安全用例
let dir: string
let proc: ChildProcess
let nextId = 0
const pending = new Map<number, (v: unknown) => void>()
let buffer = ""

function send(msg: unknown) {
  proc.stdin!.write(JSON.stringify(msg) + "\n")
}

function request(method: string, params: unknown): Promise<any> {
  const id = ++nextId
  send({ jsonrpc: "2.0", id, method, params })
  return new Promise((resolvePromise) => pending.set(id, resolvePromise))
}

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "media-mcp-e2e-"))
  await runFfmpeg(
    ["-f", "lavfi", "-i", "testsrc=duration=6:size=640x360:rate=30", "-c:v", "libx264", "-pix_fmt", "yuv420p", path.join(dir, "in.mp4")],
    { timeoutMs: 60_000 },
  )
  proc = spawn("bun", ["src/index.ts"], {
    cwd: path.resolve(__dirname, ".."),
    env: { ...process.env, OPENCODE_MEDIA_PROJECT: dir },
    stdio: ["pipe", "pipe", "pipe"],
  })
  proc.stdout!.on("data", (chunk: Buffer) => {
    buffer += chunk.toString()
    let idx: number
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx).trim()
      buffer = buffer.slice(idx + 1)
      if (!line) continue
      const msg = JSON.parse(line)
      if (msg.id && pending.has(msg.id)) {
        pending.get(msg.id)!(msg)
        pending.delete(msg.id)
      }
    }
  })
  await request("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "0" } })
  send({ jsonrpc: "2.0", method: "notifications/initialized" })
})

afterAll(async () => {
  proc.kill()
  await rm(dir, { recursive: true, force: true })
})

describe("MCP 端到端", () => {
  test("tools/list 暴露 4 个工具", async () => {
    const res = await request("tools/list", {})
    const names = res.result.tools.map((t: any) => t.name)
    expect(names).toEqual(["media_probe", "media_process", "media_generate_image", "media_generate_video"])
  })

  test("media_probe 返回流信息", async () => {
    const res = await request("tools/call", { name: "media_probe", arguments: { path: "in.mp4" } })
    const info = JSON.parse(res.result.content[0].text)
    expect(Number(info.format.duration)).toBeCloseTo(6, 0)
  })

  test("验收 1：trim 产物落盘 .opencode/media/", async () => {
    const res = await request("tools/call", {
      name: "media_process",
      arguments: { template: "trim", inputs: ["in.mp4"], output: "clips/head.mp4", params: { start: 0, duration: 2 } },
    })
    expect(res.result.isError).toBeUndefined()
    const { asset } = JSON.parse(res.result.content[0].text)
    expect(asset.path).toMatch(/^\.opencode\/media\/\d{4}-\d{2}\/m[0-9a-z]+\.mp4$/)
    expect(asset.source).toBe("process")
    expect(asset.model).toBe("ffmpeg")
    expect(asset.bytes).toBeGreaterThan(0)
  })

  test("安全用例：../ 穿越被拒绝", async () => {
    const res = await request("tools/call", {
      name: "media_process",
      arguments: { template: "trim", inputs: ["../evil.mp4"], output: "clips/x.mp4", params: { start: 0, duration: 1 } },
    })
    expect(res.result.isError).toBe(true)
    expect(res.result.content[0].text).toContain("越界")
  })

  test("安全用例：自由命令行无逃生门（未知模板）", async () => {
    const res = await request("tools/call", {
      name: "media_process",
      arguments: { template: "exec", inputs: ["in.mp4"], output: "x.mp4", params: { args: "-i http://evil" } },
    })
    expect(res.result.isError).toBe(true)
    expect(res.result.content[0].text).toContain("未知模板")
  })

  test("扩展名校验：gif 模板拒 mp4 输出", async () => {
    const res = await request("tools/call", {
      name: "media_process",
      arguments: { template: "make_gif", inputs: ["in.mp4"], output: "x.mp4", params: {} },
    })
    expect(res.result.isError).toBe(true)
  })

  test("generate_image 缺密钥时报结构化错误", async () => {
    const res = await request("tools/call", {
      name: "media_generate_image",
      arguments: { prompt: "test" },
    })
    expect(res.result.isError).toBe(true)
    expect(res.result.content[0].text).toContain("OPENAI_API_KEY")
  })
})
