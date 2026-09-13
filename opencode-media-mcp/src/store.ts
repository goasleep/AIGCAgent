import path from "node:path"
import { copyFile, mkdir, rename, stat, writeFile } from "node:fs/promises"
import { assetId, mediaMonthDir, relativeTo } from "./paths"

export interface AssetMeta {
  id: string
  path: string // 项目相对路径
  kind: "image" | "video"
  mime: string
  bytes: number
  source: "generate" | "process"
  model?: string
  prompt?: string
  params?: Record<string, unknown>
  job_id?: string
  cost_usd_estimate?: number | null
  created_at: number
}

const MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mkv": "video/x-matroska",
  ".mov": "video/quicktime",
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
}

/**
 * P0 产物存储：落盘 <project>/.opencode/media/<yyyy-mm>/<id>.<ext>，
 * 元数据写同目录 <id>.json（P1 迁移到 SQLite media_asset 表）。
 */
export class MediaStore {
  constructor(private root: string) {}

  async save(
    sourceAbs: string,
    init: Omit<AssetMeta, "id" | "path" | "bytes" | "created_at" | "mime">,
  ): Promise<AssetMeta> {
    const ext = path.extname(sourceAbs).toLowerCase()
    const mime = MIME[ext]
    if (!mime) throw new Error(`不支持的产物扩展名: ${ext}`)
    const id = assetId()
    const dir = mediaMonthDir(this.root)
    await mkdir(dir, { recursive: true })
    const target = path.join(dir, `${id}${ext}`)
    try {
      await rename(sourceAbs, target) // 同盘移动，零拷贝
    } catch {
      await copyFile(sourceAbs, target) // 跨盘（如 tmp 在别的盘）回退复制
    }
    const meta: AssetMeta = {
      ...init,
      id,
      path: relativeTo(this.root, target),
      mime,
      bytes: (await stat(target)).size,
      created_at: Date.now(),
    }
    await writeFile(path.join(dir, `${id}.json`), JSON.stringify(meta, null, 2))
    return meta
  }
}
