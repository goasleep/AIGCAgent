import { z } from "zod"

export class TemplateError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "TemplateError"
  }
}

/** 模板上下文：inputs/output 均为已通过路径沙箱校验的绝对路径；resolve 用于模板内部的额外路径（如水印图） */
export interface TemplateContext {
  inputs: string[]
  output: string
  tmpDir: string
  resolve: (input: string) => string
}

export interface TemplateResult {
  args: string[]
  /** concat 等模板需要的辅助清单文件，runner 写入 tmpDir 并在结束后清理 */
  auxFiles?: { path: string; content: string }[]
}

export interface Template {
  readonly kind: "image" | "video"
  readonly description: string
  readonly outputExts: string[]
  readonly build: (ctx: TemplateContext, params: unknown) => TemplateResult
}

const timeValue = z.union([
  z.number().nonnegative(),
  z
    .string()
    .regex(/^(\d{1,2}:)?[0-5]?\d:[0-5]\d(\.\d+)?$|^\d+(\.\d+)?$/, "时间格式：秒数或 hh:mm:ss"),
])

type TimeValue = z.infer<typeof timeValue>

const position = z.enum([
  "top-left", "top-center", "top-right",
  "center-left", "center", "center-right",
  "bottom-left", "bottom-center", "bottom-right",
])
type Position = z.infer<typeof position>

function strTime(v: TimeValue): string {
  return typeof v === "number" ? String(v) : v
}

function durationOf(p: { start: TimeValue; duration?: TimeValue; end?: TimeValue }): string {
  if (p.duration !== undefined) return strTime(p.duration)
  if (p.end === undefined) throw new TemplateError("trim: duration 或 end 必选一个")
  if (typeof p.start === "string" || typeof p.end === "string") {
    throw new TemplateError("trim: 使用 end 时 start/end 必须是秒数")
  }
  return String(p.end - p.start)
}

const overlayXY: Record<Position, string> = {
  "top-left": "10:10",
  "top-center": "(main_w-overlay_w)/2:10",
  "top-right": "main_w-overlay_w-10:10",
  "center-left": "10:(main_h-overlay_h)/2",
  center: "(main_w-overlay_w)/2:(main_h-overlay_h)/2",
  "center-right": "main_w-overlay_w-10:(main_h-overlay_h)/2",
  "bottom-left": "10:main_h-overlay_h-10",
  "bottom-center": "(main_w-overlay_w)/2:main_h-overlay_h-10",
  "bottom-right": "main_w-overlay_w-10:main_h-overlay_h-10",
}

function requireInput(ctx: TemplateContext): string {
  const input = ctx.inputs[0]
  if (!input) throw new TemplateError("该模板需要 1 个输入文件")
  return input
}

function define<P extends z.ZodTypeAny>(
  kind: Template["kind"],
  description: string,
  outputExts: string[],
  schema: P,
  build: (ctx: TemplateContext, params: z.infer<P>) => TemplateResult,
): Template {
  return {
    kind,
    description,
    outputExts,
    build: (ctx, raw) => {
      const parsed = schema.safeParse(raw ?? {})
      if (!parsed.success) {
        const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")
        throw new TemplateError(`参数校验失败 — ${issues}`)
      }
      return build(ctx, parsed.data)
    },
  }
}

export const templates: Record<string, Template> = {
  transcode: define(
    "video",
    "转码/改封装。codec=h264(默认,libx264)/vp9(libvpx-vp9)，音频统一 aac",
    [".mp4", ".webm", ".mkv"],
    z.object({
      codec: z.enum(["h264", "vp9"]).default("h264"),
      crf: z.number().int().min(0).max(51).default(23),
      preset: z.string().regex(/^[a-z0-9]+$/).default("medium"),
    }),
    (ctx, p) => {
      const input = requireInput(ctx)
      const vcodec = p.codec === "vp9" ? "libvpx-vp9" : "libx264"
      return {
        args: ["-i", input, "-c:v", vcodec, "-crf", String(p.crf), "-preset", p.preset, "-c:a", "aac", ctx.output],
      }
    },
  ),

  // 快 Seek（-ss 在 -i 前）+ 流拷贝：速度快，但切点可能落在非关键帧（开头黑帧/短漂移）
  trim: define(
    "video",
    "截取片段（无损快剪，非帧精确）。start 必填，duration 或 end 选一个",
    [".mp4", ".webm", ".mkv"],
    z.object({ start: timeValue, duration: timeValue.optional(), end: timeValue.optional() }),
    (ctx, p) => ({
      args: ["-ss", strTime(p.start), "-i", requireInput(ctx), "-t", durationOf(p), "-c", "copy", ctx.output],
    }),
  ),

  // 精确剪辑：重编码切点，帧精确但慢
  trim_exact: define(
    "video",
    "截取片段（重编码，帧精确）",
    [".mp4", ".webm", ".mkv"],
    z.object({ start: timeValue, duration: timeValue.optional(), end: timeValue.optional() }),
    (ctx, p) => ({
      args: [
        "-ss", strTime(p.start), "-i", requireInput(ctx), "-t", durationOf(p),
        "-c:v", "libx264", "-crf", "18", "-c:a", "aac", ctx.output,
      ],
    }),
  ),

  concat: define(
    "video",
    "多段拼接（concat demuxer 无损）。要求各段编码参数一致，不一致先用 transcode 统一",
    [".mp4", ".webm", ".mkv"],
    z.object({}),
    (ctx) => {
      if (ctx.inputs.length < 2 || ctx.inputs.length > 20) {
        throw new TemplateError(`concat 需要 2–20 个输入，收到 ${ctx.inputs.length}`)
      }
      const listPath = `${ctx.tmpDir}/concat-${Date.now()}.txt`
      const content = ctx.inputs.map((f) => `file '${f.replaceAll("'", "'\\''")}'`).join("\n")
      return {
        args: ["-f", "concat", "-safe", "0", "-i", listPath, "-c", "copy", ctx.output],
        auxFiles: [{ path: listPath, content }],
      }
    },
  ),

  extract_frames: define(
    "video",
    "抽帧。fps 模式按帧率抽全段；timestamps 模式抽指定时间点。output 必须含 %03d 占位",
    [".png", ".jpg"],
    z.object({
      fps: z.number().positive().optional(),
      timestamps: z.array(z.number().nonnegative()).min(1).optional(),
      format: z.enum(["png", "jpg"]).default("png"),
    }),
    (ctx, p) => {
      const input = requireInput(ctx)
      if (!ctx.output.includes("%")) {
        throw new TemplateError("extract_frames: output 必须包含 %03d 之类的 printf 占位（多帧产物）")
      }
      if (p.timestamps) {
        const select = p.timestamps.map((t) => `between(t,${t - 0.05},${t + 0.05})`).join("+")
        return { args: ["-i", input, "-vf", `select='${select}'`, "-vsync", "0", ctx.output] }
      }
      return { args: ["-i", input, "-vf", `fps=${p.fps ?? 1}`, "-f", "image2", ctx.output] }
    },
  ),

  watermark: define(
    "video",
    "叠加图片水印。overlay_path 为项目相对路径，position 九宫格，opacity 0–1",
    [".mp4", ".webm", ".mkv"],
    z.object({
      overlay_path: z.string().min(1),
      position: position.default("bottom-right"),
      opacity: z.number().min(0).max(1).default(1),
    }),
    (ctx, p) => {
      const input = requireInput(ctx)
      const overlayAbs = ctx.resolve(p.overlay_path)
      const [x, y] = overlayXY[p.position].split(":")
      const graph =
        p.opacity >= 1
          ? `[0:v][1:v]overlay=${x}:${y}`
          : `[1:v]format=rgba,colorchannelmixer=aa=${p.opacity}[wm];[0:v][wm]overlay=${x}:${y}`
      return { args: ["-i", input, "-i", overlayAbs, "-filter_complex", graph, "-c:a", "copy", ctx.output] }
    },
  ),

  make_gif: define(
    "video",
    "视频转 GIF（palettegen 两遍法，画质明显优于单遍）",
    [".gif"],
    z.object({
      fps: z.number().positive().default(12),
      width: z.number().int().positive().default(480),
    }),
    (ctx, p) => ({
      args: [
        "-i", requireInput(ctx),
        "-filter_complex",
        `fps=${p.fps},scale=${p.width}:-1:flags=lanczos,split[a][b];[a]palettegen[pal];[b][pal]paletteuse`,
        ctx.output,
      ],
    }),
  ),

  resize_image: define(
    "image",
    "图片缩放/格式转换。只给 width 或 height 时另一边等比",
    [".png", ".jpg", ".webp"],
    z.object({
      width: z.number().int().positive().optional(),
      height: z.number().int().positive().optional(),
      format: z.enum(["png", "jpg", "webp"]).optional(),
    }),
    (ctx, p) => {
      const w = p.width ?? -1
      const h = p.height ?? -1
      if (w === -1 && h === -1) throw new TemplateError("resize_image: width/height 至少给一个")
      return { args: ["-i", requireInput(ctx), "-vf", `scale=${w}:${h}`, ctx.output] }
    },
  ),

  thumbnail: define(
    "video",
    "视频封面帧（at 秒处，默认 1s）",
    [".png", ".jpg"],
    z.object({ at: z.number().nonnegative().default(1) }),
    (ctx, p) => ({
      args: ["-ss", String(p.at), "-i", requireInput(ctx), "-frames:v", "1", "-q:v", "2", ctx.output],
    }),
  ),
}
