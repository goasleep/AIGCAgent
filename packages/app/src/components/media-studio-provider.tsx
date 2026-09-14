import type { ParentProps } from "solid-js"
import { MediaStudioProvider, type MediaRegenerateRequest } from "@opencode-ai/session-ui/context"
import { useSDK } from "@/context/sdk"
import { useServer } from "@/context/server"
import { usePrompt } from "@/context/prompt"
import { isServerContentURL, mediaContentURL } from "@/utils/media-url"
import { authTokenFromCredentials } from "@/utils/server"

/**
 * 会话页媒体工作室：为 session-ui 的视频附件卡片提供资产定位与「选段重生成」入口。
 * 重生成不直接发送，而是把结构化指令填入 prompt 输入框，由用户确认后发出。
 */
export function SessionMediaStudioProvider(props: ParentProps) {
  const sdk = useSDK()
  const server = useServer()
  const prompt = usePrompt()

  const headers = (): Record<string, string> => {
    const conn = server.current
    if (!conn?.http.password) return {}
    return {
      Authorization: `Basic ${authTokenFromCredentials({ username: conn.http.username, password: conn.http.password })}`,
    }
  }

  const contentUrl = (assetID: string) =>
    mediaContentURL({
      url: sdk().url,
      directory: sdk().directory,
      id: assetID,
      username: server.current?.http.username,
      password: server.current?.http.password,
    })

  const resolveUrl = (url: string) => {
    if (!url.startsWith("/media/content") && !url.startsWith("/file/content")) return url
    return `${sdk().url}${url}`
  }

  const loadUrl = async (url: string) => {
    const resolved = resolveUrl(url)
    if (isServerContentURL(resolved, sdk().url, "file")) {
      const response = await fetch(resolved, { headers: headers() })
      if (!response.ok) throw new Error(`file content request failed: ${response.status}`)
      const body = (await response.json()) as { type?: string; content?: string; encoding?: string; mimeType?: string }
      if (body.type !== "binary" || body.encoding !== "base64" || typeof body.content !== "string") {
        throw new Error("file content response is not binary")
      }
      const binary = Uint8Array.from(atob(body.content), (char) => char.charCodeAt(0))
      return URL.createObjectURL(new Blob([binary], { type: body.mimeType ?? "application/octet-stream" }))
    }
    if (!isServerContentURL(resolved, sdk().url, "media")) return resolved
    const parsed = new URL(resolved)
    return mediaContentURL({
      url: sdk().url,
      directory: parsed.searchParams.get("directory") ?? sdk().directory,
      id: parsed.searchParams.get("id") ?? "",
      username: server.current?.http.username,
      password: server.current?.http.password,
    })
  }

  const resolveAsset = async (assetID: string) => {
    const query = new URLSearchParams({ directory: sdk().directory, id: assetID })
    const res = await fetch(`${sdk().url}/media/asset?${query}`, { headers: headers() })
    if (!res.ok) return undefined
    const asset = (await res.json()) as { path?: string }
    if (!asset.path) return undefined
    return { path: asset.path }
  }

  const regenerate = (request: MediaRegenerateRequest) => {
    const start = request.start.toFixed(1)
    const end = request.end.toFixed(1)
    const duration = (request.end - request.start).toFixed(1)
    const text = [
      `Regenerate the segment from ${start}s to ${end}s of \`${request.path}\`${request.prompt ? `: ${request.prompt}` : "."}`,
      "",
      `Workflow: media_probe the source video; media_process trim_exact to cut the head (0–${start}s) and the tail (${end}s–end); media_process extract_frames at the two cut boundaries; media_generate_video a ~${duration}s replacement clip using those boundary frames as first_frame/last_frame for continuity; media_process concat the three parts into a new file. Keep the original file untouched.`,
    ].join("\n")
    prompt.set([{ type: "text", content: text, start: 0, end: text.length }], text.length)
  }

  return (
    <MediaStudioProvider
      contentUrl={contentUrl}
      resolveUrl={resolveUrl}
      loadUrl={loadUrl}
      resolveAsset={resolveAsset}
      regenerate={regenerate}
    >
      {props.children}
    </MediaStudioProvider>
  )
}
