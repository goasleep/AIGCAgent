import type { MediaAsset, MediaSource } from "./media-library"

export function uploadMediaFile(input: {
  source: MediaSource
  file: File
  onProgress: (percent: number) => void
  messages?: { failed: string; tooLarge: string }
}) {
  const request = new XMLHttpRequest()
  const promise = new Promise<MediaAsset>((resolve, reject) => {
    const image = input.file.type.startsWith("image/") || /\.(png|jpe?g|gif|webp)$/i.test(input.file.name)
    if (input.file.size > (image ? 20 : 250) * 1024 * 1024) {
      reject(
        new Error(
          input.messages?.tooLarge ?? (image ? "Images must be 20 MB or smaller" : "Videos must be 250 MB or smaller"),
        ),
      )
      return
    }
    request.open(
      "POST",
      `${input.source.url}/media/upload?${new URLSearchParams({ directory: input.source.directory })}`,
    )
    if (input.source.authorization) request.setRequestHeader("Authorization", input.source.authorization)
    request.responseType = "json"
    request.upload.onprogress = (event) =>
      input.onProgress(event.lengthComputable ? Math.round((event.loaded / event.total) * 100) : 0)
    request.onload = () => {
      if (request.status < 200 || request.status >= 300 || !request.response?.asset) {
        reject(
          new Error(
            request.response?.message ?? `${input.messages?.failed ?? "Media upload failed"} (${request.status})`,
          ),
        )
        return
      }
      resolve(request.response.asset as MediaAsset)
    }
    request.onerror = () => reject(new Error(input.messages?.failed ?? "Media upload failed"))
    request.onabort = () => reject(new Error("Media upload cancelled"))
    const form = new FormData()
    form.append("file", input.file)
    input.onProgress(0)
    request.send(form)
  })
  return { promise, abort: () => request.abort() }
}
