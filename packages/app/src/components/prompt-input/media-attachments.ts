import type { ImageAttachmentPart, Prompt } from "@/context/prompt"
import { blobDataUrl, createBlobReference, type DraftStore } from "@/utils/draft-store"
import type { MediaAsset, MediaSource } from "@/utils/media-library"
import { uuid } from "@/utils/uuid"

export const isVideoReference = (attachment: ImageAttachmentPart) =>
  !!attachment.media && attachment.mime.startsWith("video/")

export function mediaReference(attachment: Pick<ImageAttachmentPart, "media" | "mime" | "filename">) {
  if (!attachment.media) return ""
  return `Media asset ${JSON.stringify(attachment.media.asset_id)}: ${JSON.stringify(attachment.media.path)} (${attachment.mime}, ${JSON.stringify(attachment.filename)}). Use the project-relative path with media tools.`
}

export async function encodeMediaAttachment(attachment: ImageAttachmentPart) {
  return {
    uri: await blobDataUrl(attachment.blob, attachment.mime),
    name: attachment.filename,
    mime: attachment.mime,
    asset_id: attachment.media?.asset_id,
    path: attachment.media?.path,
  }
}

export async function attachMediaAssets(input: {
  assets: MediaAsset[]
  source: MediaSource
  target: { current: () => Prompt; cursor: () => number | undefined; set: (prompt: Prompt, cursor?: number) => void }
  store?: DraftStore
}) {
  for (const asset of input.assets) {
    if (input.target.current().some((part) => part.type === "image" && part.media?.asset_id === asset.id)) continue
    const blob = await fetch(
      `${input.source.url}/media/content?${new URLSearchParams({ directory: input.source.directory, id: asset.id })}`,
      { headers: input.source.authorization ? { Authorization: input.source.authorization } : {} },
    ).then((response) => {
      if (!response.ok) throw new Error(`Media content unavailable (${response.status})`)
      return response.blob()
    })
    const attachment: ImageAttachmentPart = {
      type: "image",
      id: uuid(),
      filename:
        typeof asset.params?.filename === "string" ? asset.params.filename : (asset.path.split("/").pop() ?? asset.id),
      mime: asset.mime,
      blob: input.store ? await input.store.putBlob(blob) : await createBlobReference(blob),
      media: { asset_id: asset.id, path: asset.path, directory: input.source.directory },
    }
    // Recheck after the content read so overlapping selections cannot duplicate the same asset.
    if (input.target.current().some((part) => part.type === "image" && part.media?.asset_id === asset.id)) continue
    input.target.set([...input.target.current(), attachment], input.target.cursor())
  }
}
