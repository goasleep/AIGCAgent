import path from "node:path"
import { randomBytes } from "node:crypto"

export class PathError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "PathError"
  }
}

/** 项目根：env 覆盖优先，否则取进程 cwd（MCP server 由 opencode 在项目目录下拉起） */
export function projectRoot(): string {
  return path.resolve(process.env.OPENCODE_MEDIA_PROJECT ?? process.cwd())
}

/**
 * 把项目相对路径解析为绝对路径，并强制约束在项目根内。
 * 拒绝绝对路径（含 Windows 盘符）、.. 穿越、空路径——防止 prompt injection 读项目外文件。
 */
export function resolveInside(root: string, input: string): string {
  if (input.length === 0 || input.includes("\0")) throw new PathError(`非法路径: ${JSON.stringify(input)}`)
  if (path.isAbsolute(input) || /^[a-zA-Z]:[\\/]/.test(input)) {
    throw new PathError(`仅接受项目相对路径，拒绝绝对路径: ${input}`)
  }
  const resolved = path.resolve(root, input)
  const rel = path.relative(root, resolved)
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new PathError(`路径越界（必须位于项目内）: ${input}`)
  }
  return resolved
}

/** 可排序 asset id：定宽时间戳 base36（字典序 = 时间序）+ 随机后缀，风格对齐 opencode 的 Identifier.ascending */
export function assetId(now = new Date()): string {
  return `m${now.getTime().toString(36).padStart(10, "0")}${randomBytes(3).toString("hex")}`
}

export function mediaMonthDir(root: string, now = new Date()): string {
  const yyyy = now.getFullYear()
  const mm = String(now.getMonth() + 1).padStart(2, "0")
  return path.join(root, ".opencode", "media", `${yyyy}-${mm}`)
}

export function mediaTmpDir(root: string): string {
  return path.join(root, ".opencode", "media", "tmp")
}

/** 绝对路径 → 项目相对路径（元数据里存相对路径，防项目迁移后失效） */
export function relativeTo(root: string, abs: string): string {
  return path.relative(root, abs)
}
