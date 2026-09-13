import { describe, expect, test } from "bun:test"
import { templates, TemplateError, type TemplateContext } from "@/media/templates"

const ctx = (over: Partial<TemplateContext> = {}): TemplateContext => ({
  inputs: ["/proj/in.mp4"],
  output: "/proj/out.mp4",
  tmpDir: "/proj/.opencode/media/tmp",
  resolve: (p) => `/proj/${p}`,
  ...over,
})

describe("模板 argv 生成", () => {
  test("transcode 默认 h264", () => {
    const r = templates.transcode!.build(ctx(), {})
    expect(r.args).toEqual(["-i", "/proj/in.mp4", "-c:v", "libx264", "-crf", "23", "-preset", "medium", "-c:a", "aac", "/proj/out.mp4"])
  })

  test("trim 用 duration", () => {
    const r = templates.trim!.build(ctx(), { start: 3, duration: 10 })
    expect(r.args).toEqual(["-ss", "3", "-i", "/proj/in.mp4", "-t", "10", "-c", "copy", "/proj/out.mp4"])
  })

  test("trim 用 end 计算时长", () => {
    const r = templates.trim!.build(ctx(), { start: 5, end: 12.5 })
    expect(r.args).toContain("7.5")
  })

  test("trim 接受 hh:mm:ss", () => {
    const r = templates.trim!.build(ctx(), { start: "00:01:03", duration: "00:00:10" })
    expect(r.args).toEqual(["-ss", "00:01:03", "-i", "/proj/in.mp4", "-t", "00:00:10", "-c", "copy", "/proj/out.mp4"])
  })

  test("trim_exact 重编码", () => {
    const r = templates.trim_exact!.build(ctx(), { start: 0, duration: 4 })
    expect(r.args).toContain("-c:v")
    expect(r.args).toContain("libx264")
    expect(r.args).not.toContain("copy")
  })

  test("concat 生成清单文件", () => {
    const c = ctx({ inputs: ["/proj/a.mp4", "/proj/b.mp4"] })
    const r = templates.concat!.build(c, {})
    expect(r.auxFiles).toHaveLength(1)
    expect(r.auxFiles![0]!.content).toBe("file '/proj/a.mp4'\nfile '/proj/b.mp4'")
    expect(r.args).toContain("concat")
    expect(r.args).toContain("-c")
    expect(r.args).toContain("copy")
  })

  test("concat 拒绝单段", () => {
    expect(() => templates.concat!.build(ctx({ inputs: ["/proj/a.mp4"] }), {})).toThrow(TemplateError)
  })

  test("extract_frames fps 模式", () => {
    const r = templates.extract_frames!.build(ctx({ output: "/proj/f-%03d.png" }), { fps: 2 })
    expect(r.args).toContain("fps=2")
  })

  test("extract_frames 输出必须含占位符", () => {
    expect(() => templates.extract_frames!.build(ctx({ output: "/proj/f.png" }), { fps: 1 })).toThrow(/占位/)
  })

  test("extract_frames timestamps 模式", () => {
    const r = templates.extract_frames!.build(ctx({ output: "/proj/f-%03d.jpg" }), { timestamps: [1.2, 5] })
    expect(r.args.join(" ")).toContain("between(t,1.15,1.25)")
    expect(r.args.join(" ")).toContain("between(t,4.95,5.05)")
  })

  test("watermark 九宫格坐标 + opacity 滤镜", () => {
    const r = templates.watermark!.build(ctx(), { overlay_path: "wm.png", position: "top-right", opacity: 0.5 })
    expect(r.args.join(" ")).toContain("overlay=main_w-overlay_w-10:10")
    expect(r.args.join(" ")).toContain("colorchannelmixer=aa=0.5")
    expect(r.args).toContain("/proj/wm.png")
  })

  test("make_gif 双遍法", () => {
    const r = templates.make_gif!.build(ctx({ output: "/proj/out.gif" }), {})
    expect(r.args.join(" ")).toContain("palettegen")
    expect(r.args.join(" ")).toContain("paletteuse")
  })

  test("resize_image 单维等比", () => {
    const r = templates.resize_image!.build(ctx({ output: "/proj/out.webp" }), { width: 800, format: "webp" })
    expect(r.args).toContain("scale=800:-1")
  })

  test("resize_image 两维都不给则拒绝", () => {
    expect(() => templates.resize_image!.build(ctx({ output: "/proj/out.png" }), {})).toThrow(TemplateError)
  })

  test("thumbnail 默认 1s", () => {
    const r = templates.thumbnail!.build(ctx({ output: "/proj/out.jpg" }), {})
    expect(r.args).toEqual(["-ss", "1", "-i", "/proj/in.mp4", "-frames:v", "1", "-q:v", "2", "/proj/out.jpg"])
  })
})

describe("参数校验拒绝非法输入", () => {
  test("未知字段/类型错误", () => {
    expect(() => templates.transcode!.build(ctx(), { crf: "high" })).toThrow(TemplateError)
    expect(() => templates.trim!.build(ctx(), {})).toThrow(TemplateError) // 缺 start
    expect(() => templates.trim!.build(ctx(), { start: 1 })).toThrow(/duration 或 end/) // 两者都缺
  })

  test("时间字符串注入字符被拒", () => {
    expect(() => templates.trim!.build(ctx(), { start: "1; rm -rf /", duration: 1 })).toThrow(TemplateError)
  })
})
