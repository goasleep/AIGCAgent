import { z } from "zod"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { mkdir, readdir, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { mediaTmpDir, projectRoot, resolveInside } from "./paths"
import { templates, type TemplateContext } from "./templates"
import { probe, runFfmpeg } from "./ffmpeg"
import { MediaStore } from "./store"
import {
  createVideoTaskArk,
  download,
  estimateImageCost,
  generateImageOpenAI,
  pollVideoTaskArk,
} from "./generate"

const HARD_TIMEOUT_MS = 30 * 60 * 1000

const root = projectRoot()
const store = new MediaStore(root)

function json(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] }
}

function fail(err: unknown) {
  const msg = err instanceof Error ? err.message : String(err)
  return { isError: true, content: [{ type: "text" as const, text: JSON.stringify({ error: msg }) }] }
}

const probeArgs = z.object({ path: z.string().min(1) })
const processArgs = z.object({
  template: z.string().min(1),
  inputs: z.array(z.string().min(1)).min(1).max(20),
  output: z.string().min(1),
  params: z.record(z.unknown()).optional(),
})
const genImageArgs = z.object({
  prompt: z.string().min(1),
  size: z.enum(["1024x1024", "1536x1024", "1024x1536", "auto"]).optional(),
  quality: z.enum(["low", "medium", "high"]).optional(),
  model: z.string().optional(),
  reference: z.string().optional(),
})
const genVideoArgs = z.object({
  prompt: z.string().min(1),
  duration: z.number().int().min(1).max(12).optional(),
  ratio: z.enum(["16:9", "9:16", "1:1"]).optional(),
  model: z.string().optional(),
  first_frame: z.string().optional(),
})
type ProcessArgs = z.infer<typeof processArgs>

async function handleProcess(args: ProcessArgs) {
  const template = templates[args.template]
  if (!template) return fail(new Error(`未知模板: ${args.template}（可选：${Object.keys(templates).join("/")}）`))

  const { timeout_ms, ...tplParams } = args.params ?? {}
  const timeoutMs = Math.min(Number(timeout_ms ?? (template.kind === "video" ? 600_000 : 60_000)), HARD_TIMEOUT_MS)
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return fail(new Error("timeout_ms 非法"))

  const ext = path.extname(args.output).toLowerCase()
  if (!template.outputExts.includes(ext)) {
    return fail(new Error(`模板 ${args.template} 的产物扩展名必须是 ${template.outputExts.join("/")}，收到 ${ext || "(无)"}`))
  }

  const inputs = args.inputs.map((p) => resolveInside(root, p))
  const output = resolveInside(root, args.output)
  const tmpDir = mediaTmpDir(root)
  await mkdir(tmpDir, { recursive: true })
  await mkdir(path.dirname(output), { recursive: true })

  const ctx: TemplateContext = { inputs, output, tmpDir, resolve: (p) => resolveInside(root, p) }
  const { args: ffmpegArgs, auxFiles } = template.build(ctx, tplParams)
  for (const aux of auxFiles ?? []) await writeFile(aux.path, aux.content)

  try {
    const { stderrTail } = await runFfmpeg(ffmpegArgs, { timeoutMs })
    if (output.includes("%")) {
      // 多帧产物：不搬入媒体库，原位置返回清单
      const produced = (await readdir(path.dirname(output)))
        .filter((f) => f.startsWith(path.basename(output).split("%")[0] ?? ""))
        .sort()
      return json({ outputs: produced.map((f) => path.join(path.dirname(output), f).slice(root.length + 1)), stderr_tail: stderrTail.slice(-500) })
    }
    const meta = await store.save(output, {
      kind: template.kind,
      source: "process",
      model: "ffmpeg",
      params: { template: args.template, ...tplParams },
      cost_usd_estimate: null,
    })
    return json({ asset: meta, stderr_tail: stderrTail.slice(-500) })
  } finally {
    for (const aux of auxFiles ?? []) await rm(aux.path, { force: true })
  }
}

async function handleProbe(args: { path: string }) {
  const file = resolveInside(root, args.path)
  const info = await probe(file)
  return json(info)
}

type ImageSize = "1024x1024" | "1536x1024" | "1024x1536" | "auto"
type ImageQuality = "low" | "medium" | "high"
type VideoRatio = "16:9" | "9:16" | "1:1"

async function handleGenerateImage(args: { prompt: string; size?: ImageSize; quality?: ImageQuality; model?: string; reference?: string }) {
  if (args.model && args.model !== "gpt-image-2") return fail(new Error(`P0 仅支持 gpt-image-2，收到: ${args.model}`))
  if (args.reference) return fail(new Error("P0 不支持 reference 参考图，P1 提供"))
  const req = { prompt: args.prompt, size: args.size ?? "1024x1024", quality: args.quality ?? "high" } as const
  const { data, revisedPrompt } = await generateImageOpenAI(req)
  const tmp = path.join(mediaTmpDir(root), `gen-${Date.now()}.png`)
  await mkdir(mediaTmpDir(root), { recursive: true })
  await writeFile(tmp, data)
  const meta = await store.save(tmp, {
    kind: "image",
    source: "generate",
    model: "gpt-image-2",
    prompt: args.prompt,
    params: { size: req.size, quality: req.quality },
    cost_usd_estimate: estimateImageCost(req),
  })
  return json({ asset: meta, revised_prompt: revisedPrompt ?? null })
}

async function handleGenerateVideo(args: { prompt: string; duration?: number; ratio?: VideoRatio; model?: string; first_frame?: string }) {
  if (args.model && args.model !== "seedance-2-0") return fail(new Error(`P0 仅支持 seedance-2-0，收到: ${args.model}`))
  if (args.first_frame) return fail(new Error("P0 不支持 first_frame 首帧参考，P1 提供"))
  const req = { prompt: args.prompt, duration: args.duration ?? 5, ratio: args.ratio ?? "16:9" } as const
  const { jobId } = await createVideoTaskArk(req)
  const deadline = Date.now() + 15 * 60 * 1000
  let intervalMs = 5_000
  for (;;) {
    await new Promise((r) => setTimeout(r, intervalMs))
    intervalMs = Math.min(Math.round(intervalMs * 1.5), 15_000)
    const status = await pollVideoTaskArk(jobId)
    if (status.state === "succeeded") {
      // Ark 产物 URL 约 24h 过期：立即下载落盘，失败保留 job_id 供重试下载（不重新生成，避免重复扣费）
      try {
        const buf = await download(status.url!)
        const tmp = path.join(mediaTmpDir(root), `gen-${Date.now()}.mp4`)
        await mkdir(mediaTmpDir(root), { recursive: true })
        await writeFile(tmp, buf)
        const meta = await store.save(tmp, {
          kind: "video",
          source: "generate",
          model: "seedance-2-0",
          prompt: args.prompt,
          params: { duration: req.duration, ratio: req.ratio },
          job_id: jobId,
          cost_usd_estimate: null,
        })
        return json({ asset: meta, job_id: jobId })
      } catch (err) {
        return fail(new Error(`产物下载落盘失败（job_id=${jobId}，请用 job_id 重试下载，勿重新生成）: ${(err as Error).message}`))
      }
    }
    if (status.state === "failed" || status.state === "cancelled") {
      return fail(new Error(`生成失败（job_id=${jobId}）: ${status.error ?? status.state}（内容审核拒绝不重试）`))
    }
    if (Date.now() > deadline) return fail(new Error(`轮询超时 15min（job_id=${jobId}，任务可能仍在跑，可凭 job_id 对账）`))
  }
}

// 用底层 Server + 手写 JSON Schema 注册工具：McpServer.tool 的 zod 泛型在 zod v3 下
// 触发 TS2589（类型实例化过深），手写 schema 类型确定、无推导负担
const TOOLS = [
  {
    name: "media_probe",
    description: "探测媒体文件（时长/分辨率/码率/流信息），返回 ffprobe JSON。path 为项目相对路径",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", minLength: 1, description: "项目相对路径" } },
      required: ["path"],
    },
  },
  {
    name: "media_process",
    description:
      "用 ffmpeg 模板化处理媒体（不接受自由命令行）。template 可选：transcode/trim/trim_exact/concat/extract_frames/watermark/make_gif/resize_image/thumbnail。产物落盘 .opencode/media/ 并返回元数据",
    inputSchema: {
      type: "object",
      properties: {
        template: { type: "string", minLength: 1 },
        inputs: { type: "array", items: { type: "string", minLength: 1 }, minItems: 1, maxItems: 20 },
        output: { type: "string", minLength: 1, description: "项目相对路径；extract_frames 需含 %03d 占位" },
        params: { type: "object", description: "模板参数（见各模板说明），可传 timeout_ms" },
      },
      required: ["template", "inputs", "output"],
    },
  },
  {
    name: "media_generate_image",
    description: "调用 gpt-image-2 生成图片，落盘 .opencode/media/。计费，建议先向用户确认",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", minLength: 1 },
        size: { type: "string", enum: ["1024x1024", "1536x1024", "1024x1536", "auto"] },
        quality: { type: "string", enum: ["low", "medium", "high"] },
        model: { type: "string" },
        reference: { type: "string" },
      },
      required: ["prompt"],
    },
  },
  {
    name: "media_generate_video",
    description: "调用 Seedance 2.0 生成视频（异步任务，内部轮询最长 15min），落盘 .opencode/media/。计费，建议先向用户确认",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", minLength: 1 },
        duration: { type: "integer", minimum: 1, maximum: 12 },
        ratio: { type: "string", enum: ["16:9", "9:16", "1:1"] },
        model: { type: "string" },
        first_frame: { type: "string" },
      },
      required: ["prompt"],
    },
  },
]

const server = new Server({ name: "media", version: "0.1.0" }, { capabilities: { tools: {} } })

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }))

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  try {
    const args = req.params.arguments ?? {}
    switch (req.params.name) {
      case "media_probe":
        return await handleProbe(probeArgs.parse(args))
      case "media_process":
        return await handleProcess(processArgs.parse(args))
      case "media_generate_image":
        return await handleGenerateImage(genImageArgs.parse(args))
      case "media_generate_video":
        return await handleGenerateVideo(genVideoArgs.parse(args))
      default:
        return fail(new Error(`未知工具: ${req.params.name}`))
    }
  } catch (err) {
    return fail(err)
  }
})

const transport = new StdioServerTransport()
await server.connect(transport)
