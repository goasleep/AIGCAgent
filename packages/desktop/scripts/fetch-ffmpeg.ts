#!/usr/bin/env bun
/**
 * 按平台拉取 ffmpeg/ffprobe 静态构建到 resources/ffmpeg/<platform>/。
 *
 * - 校验值硬编码在 FFMPEG_SOURCES 里（防止供应链篡改）；上游是 moving target
 *   （snapshot / latest 构建），校验失败即构建失败，需要人工更新本清单。
 * - 默认只拉取当前宿主平台；CI 矩阵在每个原生平台上跑 prebuild，各自拉取。
 * - 已存在且未指定 --force 时跳过（幂等）。
 */
import { $ } from "bun"
import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { chmod, cp, mkdir, mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

type Archive = {
  /** 下载地址（上游 moving target，更新清单时必须重新核对 sha256） */
  readonly url: string
  readonly sha256: string
}

// 校验值采集日期：2026-09-12
// macOS / Linux: ffmpeg.martin-riedl.de snapshot（原生 arm64/x64 静态构建）
// Windows: BtbN FFmpeg-Builds latest（GitHub API 资产 digest，含 LICENSE 文本）
const MRD = "https://ffmpeg.martin-riedl.de/redirect/latest"
const BTBN = "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest"

export const FFMPEG_SOURCES: Record<string, readonly Archive[]> = {
  "darwin-arm64": [
    { url: `${MRD}/macos/arm64/snapshot/ffmpeg.zip`, sha256: "376cc7800f261e658d69d83c3aae284bd74ae98b24d33f12ff26a71f8c8d8bd5" },
    { url: `${MRD}/macos/arm64/snapshot/ffprobe.zip`, sha256: "8bf24cf8bb6495c4565d3b9320994016e74cd0ae4c4397f3f8232d35b3bbb70e" },
  ],
  "darwin-x64": [
    { url: `${MRD}/macos/amd64/snapshot/ffmpeg.zip`, sha256: "6f0736d424b7426f8cbb7bba5c5448d94c976c138c669593b1f40ba534ed192f" },
    { url: `${MRD}/macos/amd64/snapshot/ffprobe.zip`, sha256: "46852ce00ae6f722ed30be269f310ea96c106a4246f2905d3147c5e02293081c" },
  ],
  "linux-arm64": [
    { url: `${MRD}/linux/arm64/snapshot/ffmpeg.zip`, sha256: "927e3050a031636a3563ca57372eccfb8129ead413fecaf243bdcd42376e9556" },
    { url: `${MRD}/linux/arm64/snapshot/ffprobe.zip`, sha256: "feb365479f41fea697ac96578d800feaa35bb3fa87eccf478e9a72b65524542c" },
  ],
  "linux-x64": [
    { url: `${MRD}/linux/amd64/snapshot/ffmpeg.zip`, sha256: "6d78d485f8a09a16cf050ad2a3727a2f4ec4aacc8b11f6f66ac416610d41fd7f" },
    { url: `${MRD}/linux/amd64/snapshot/ffprobe.zip`, sha256: "6119bd4515ddae3305963e5f9f9d3ec6443e26d453205c31247c2eb20d81107c" },
  ],
  "win32-x64": [
    {
      url: `${BTBN}/ffmpeg-master-latest-win64-lgpl.zip`,
      sha256: "84daf0581906df84c862f5380567050474e11b2639c4a45b0b39cf8ff2987d1e",
    },
  ],
  "win32-arm64": [
    {
      url: `${BTBN}/ffmpeg-master-latest-winarm64-lgpl.zip`,
      sha256: "a43649e4b7f6dade71952f4e3003c37147eb66bdbba3e351d8feaa9613f07c59",
    },
  ],
}

const packageDir = join(import.meta.dir, "..")
const exeName = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg"

function hostPlatform(): string {
  const arch = process.arch === "arm64" ? "arm64" : "x64"
  return `${process.platform}-${arch}`
}

async function sha256(file: string): Promise<string> {
  return createHash("sha256").update(await readFile(file)).digest("hex")
}

async function extract(archive: string, outDir: string) {
  if (process.platform === "win32") {
    await $`powershell -NoLogo -NoProfile -Command Expand-Archive -LiteralPath ${archive} -DestinationPath ${outDir} -Force`
    return
  }
  await $`unzip -o -q ${archive} -d ${outDir}`
}

/** 在解压树里找 ffmpeg/ffprobe/LICENSE，扁平化拷到目标目录 */
async function collect(extractedDir: string, targetDir: string): Promise<string[]> {
  const wanted = /^(ffmpeg|ffprobe)(\.\w+)?$|^LICENSE(\.|$)/i
  const found: string[] = []
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(full)
        continue
      }
      if (!wanted.test(entry.name)) continue
      const dest = join(targetDir, entry.name)
      await cp(full, dest)
      found.push(dest)
    }
  }
  await walk(extractedDir)
  return found
}

async function fetchPlatform(platform: string, force: boolean): Promise<void> {
  const sources = FFMPEG_SOURCES[platform]
  if (!sources) throw new Error(`No ffmpeg source configured for platform '${platform}'`)
  const targetDir = join(packageDir, "resources", "ffmpeg", platform)
  const ffmpegPath = join(targetDir, exeName)
  const probePath = join(targetDir, process.platform === "win32" ? "ffprobe.exe" : "ffprobe")
  if (!force && existsSync(ffmpegPath) && existsSync(probePath)) {
    console.log(`ffmpeg already present for ${platform}, skipping`)
    return
  }

  // 先在 workDir 里完整备好（下载 + 校验 + 解压 + 收集），全部成功后才原子替换目标目录，
  // 避免半下载状态把已有的可用二进制删掉
  const workDir = await mkdtemp(join(tmpdir(), `opencode-ffmpeg-${platform}-`))
  const stagingDir = join(workDir, "staging")
  await mkdir(stagingDir, { recursive: true })
  try {
    for (const [index, source] of sources.entries()) {
      const archive = join(workDir, `archive-${index}.bin`)
      console.log(`Downloading ${source.url}`)
      // 家用网络下偶发 ECONNRESET，指数退避重试 3 次再失败
      let response: Response | undefined
      let delayMs = 1_000
      for (let attempt = 0; attempt < 3 && !response?.ok; attempt++) {
        if (attempt > 0) {
          console.log(`Retry ${attempt}/3: ${source.url}`)
          await new Promise((resolve) => setTimeout(resolve, delayMs))
          delayMs *= 2
        }
        response = await fetch(source.url).catch(() => undefined)
      }
      if (!response?.ok) throw new Error(`Download failed: ${source.url}`)
      await Bun.write(archive, response)
      const actual = await sha256(archive)
      if (actual !== source.sha256) {
        throw new Error(
          `SHA256 mismatch for ${source.url}\n  expected: ${source.sha256}\n  actual:   ${actual}\n` +
            "Upstream build rotated — update FFMPEG_SOURCES with the new checksum.",
        )
      }
      const extractedDir = join(workDir, `extracted-${index}`)
      await mkdir(extractedDir, { recursive: true })
      await extract(archive, extractedDir)
      await collect(extractedDir, stagingDir)
    }
    const stagedFfmpeg = join(stagingDir, exeName)
    if (!(await stat(stagedFfmpeg).catch(() => undefined))) {
      throw new Error(`ffmpeg binary missing after extraction for ${platform}`)
    }
    if (process.platform !== "win32") {
      await chmod(stagedFfmpeg, 0o755)
      await chmod(join(stagingDir, "ffprobe"), 0o755).catch(() => undefined)
      if (process.platform === "darwin") {
        await $`codesign --force --sign - ${stagedFfmpeg}`.quiet().catch(() => undefined)
      }
    }
    await rm(targetDir, { recursive: true, force: true })
    await mkdir(join(targetDir, ".."), { recursive: true })
    await cp(stagingDir, targetDir, { recursive: true })
    console.log(`Fetched ffmpeg for ${platform} -> ${targetDir}`)
  } finally {
    await rm(workDir, { recursive: true, force: true })
  }
}

const args = process.argv.slice(2)
const force = args.includes("--force")
const all = args.includes("--all")
const platformFlag = args.indexOf("--platform")
const platforms =
  platformFlag >= 0 && args[platformFlag + 1]
    ? [args[platformFlag + 1]!]
    : all
      ? Object.keys(FFMPEG_SOURCES)
      : [hostPlatform()]

for (const platform of platforms) {
  await fetchPlatform(platform, force)
}
