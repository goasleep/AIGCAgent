import { z } from "zod"

export class GenerateError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "GenerateError"
  }
}

const imageRequest = z.object({
  prompt: z.string().min(1),
  size: z.enum(["1024x1024", "1536x1024", "1024x1536", "auto"]).default("1024x1024"),
  quality: z.enum(["low", "medium", "high"]).default("high"),
})
export type ImageRequest = z.infer<typeof imageRequest>

const videoRequest = z.object({
  prompt: z.string().min(1),
  duration: z.number().int().min(1).max(12).default(5),
  ratio: z.enum(["16:9", "9:16", "1:1"]).default("16:9"),
})
export type VideoRequest = z.infer<typeof videoRequest>

// gpt-image 系官方单价（1024x1024，美元/张），仅作成本估算，随官方定价调整
const IMAGE_COST_USD: Record<string, number> = {
  "low:1024x1024": 0.02,
  "medium:1024x1024": 0.066,
  "high:1024x1024": 0.12,
}

export function estimateImageCost(req: ImageRequest): number | null {
  return IMAGE_COST_USD[`${req.quality}:${req.size}`] ?? null
}

export async function generateImageOpenAI(req: ImageRequest): Promise<{ data: Buffer; revisedPrompt?: string }> {
  const key = process.env.OPENAI_API_KEY
  if (!key) throw new GenerateError("缺少 OPENAI_API_KEY")
  const res = await fetch("https://api.openai.com/v1/images/generations", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: "gpt-image-2",
      prompt: req.prompt,
      size: req.size === "auto" ? undefined : req.size,
      quality: req.quality,
      response_format: "b64_json",
    }),
  })
  if (!res.ok) throw new GenerateError(`OpenAI images API ${res.status}: ${(await res.text()).slice(0, 500)}`)
  const body = (await res.json()) as {
    data?: Array<{ b64_json?: string; revised_prompt?: string }>
  }
  const first = body.data?.[0]
  if (!first?.b64_json) throw new GenerateError("OpenAI 响应缺少 b64_json")
  return { data: Buffer.from(first.b64_json, "base64"), revisedPrompt: first.revised_prompt }
}

const ARK_BASE = () => process.env.ARK_BASE_URL ?? "https://ark.cn-beijing.volces.com/api/v3"

export async function createVideoTaskArk(req: VideoRequest): Promise<{ jobId: string }> {
  const key = process.env.ARK_API_KEY
  if (!key) throw new GenerateError("缺少 ARK_API_KEY")
  const res = await fetch(`${ARK_BASE()}/contents/generations/tasks`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: "seedance-2-0",
      content: [
        { type: "text", text: `${req.prompt} --ratio ${req.ratio} --duration ${req.duration}` },
      ],
    }),
  })
  if (!res.ok) throw new GenerateError(`Ark 创建任务 ${res.status}: ${(await res.text()).slice(0, 500)}`)
  const body = (await res.json()) as { id?: string }
  if (!body.id) throw new GenerateError("Ark 响应缺少任务 id")
  return { jobId: body.id }
}

export interface ArkTaskStatus {
  state: "queued" | "running" | "succeeded" | "failed" | "cancelled"
  url?: string
  error?: string
}

export async function pollVideoTaskArk(jobId: string): Promise<ArkTaskStatus> {
  const key = process.env.ARK_API_KEY
  if (!key) throw new GenerateError("缺少 ARK_API_KEY")
  const res = await fetch(`${ARK_BASE()}/contents/generations/tasks/${jobId}`, {
    headers: { authorization: `Bearer ${key}` },
  })
  if (!res.ok) throw new GenerateError(`Ark 轮询 ${res.status}: ${(await res.text()).slice(0, 500)}`)
  const body = (await res.json()) as {
    status?: string
    content?: { video_url?: string }
    error?: { message?: string }
  }
  const state = body.status ?? "queued"
  if (state === "succeeded") {
    const url = body.content?.video_url
    if (!url) throw new GenerateError("Ark 任务成功但缺少 video_url")
    return { state, url }
  }
  if (state === "failed" || state === "cancelled") {
    return { state, error: body.error?.message ?? state }
  }
  return { state: "queued" }
}

export async function download(url: string): Promise<Buffer> {
  const res = await fetch(url)
  if (!res.ok) throw new GenerateError(`下载产物 ${res.status}: ${url.slice(0, 120)}`)
  return Buffer.from(await res.arrayBuffer())
}
