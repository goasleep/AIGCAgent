import path from "path"
import { Schema } from "effect"

export class PathError extends Schema.TaggedErrorClass<PathError>()("Media.PathError", {
  detail: Schema.String,
}) {
  override get message() {
    return this.detail
  }
}

/**
 * 把项目相对路径解析为绝对路径，并强制约束在项目根内。
 * 拒绝绝对路径（含 Windows 盘符）、.. 穿越、空路径——防止 prompt injection 读项目外文件。
 */
export function resolveInside(root: string, input: string): string {
  if (input.length === 0 || input.includes("\0")) throw new PathError({ detail: `非法路径: ${JSON.stringify(input)}` })
  if (path.isAbsolute(input) || /^[a-zA-Z]:[\\/]/.test(input)) {
    throw new PathError({ detail: `仅接受项目相对路径，拒绝绝对路径: ${input}` })
  }
  const resolved = path.resolve(root, input)
  const rel = path.relative(root, resolved)
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new PathError({ detail: `路径越界（必须位于项目内）: ${input}` })
  }
  return resolved
}

export function mediaTmpDir(root: string): string {
  return path.join(root, ".opencode", "media", "tmp")
}
