import { describe, expect, test } from "bun:test"
import path from "node:path"
import { PathError, assetId, mediaMonthDir, resolveInside } from "../src/paths"

const ROOT = path.resolve("/proj")

describe("路径沙箱", () => {
  test("正常相对路径", () => {
    expect(resolveInside(ROOT, "a/b.mp4")).toBe(path.join(ROOT, "a/b.mp4"))
    expect(resolveInside(ROOT, ".opencode/media/x.mp4")).toBe(path.join(ROOT, ".opencode/media/x.mp4"))
  })

  test("拒绝绝对路径逃逸", () => {
    expect(() => resolveInside(ROOT, "/etc/passwd")).toThrow(PathError)
    expect(() => resolveInside(ROOT, path.join(ROOT, "ok.mp4"))).toThrow(PathError)
  })

  test("拒绝 .. 穿越", () => {
    expect(() => resolveInside(ROOT, "../secret.mp4")).toThrow(/越界/)
    expect(() => resolveInside(ROOT, "a/../../secret.mp4")).toThrow(/越界/)
    expect(() => resolveInside(ROOT, "a/../../../etc/passwd")).toThrow(/越界/)
  })

  test("拒绝空路径与 NUL", () => {
    expect(() => resolveInside(ROOT, "")).toThrow(PathError)
    expect(() => resolveInside(ROOT, "a\0b.mp4")).toThrow(PathError)
  })

  test("Windows 盘符路径（在非 Windows 上按绝对路径拒绝）", () => {
    expect(() => resolveInside(ROOT, "C:\\Windows\\secret.mp4")).toThrow(PathError)
  })

  test("CJK 路径正常通过", () => {
    expect(resolveInside(ROOT, "素材/视频_最终版.mp4")).toBe(path.join(ROOT, "素材/视频_最终版.mp4"))
  })

  test("id 可排序且唯一", () => {
    const a = assetId(new Date(1000))
    const b = assetId(new Date(2000))
    const c = assetId(new Date(2000))
    expect(a < b).toBe(true)
    expect(b).not.toBe(c)
    expect(a).toMatch(/^m[0-9a-z]+$/)
  })

  test("月份目录", () => {
    expect(mediaMonthDir(ROOT, new Date(2026, 8, 12))).toBe(path.join(ROOT, ".opencode", "media", "2026-09"))
    expect(mediaMonthDir(ROOT, new Date(2026, 11, 1))).toBe(path.join(ROOT, ".opencode", "media", "2026-12"))
  })
})
