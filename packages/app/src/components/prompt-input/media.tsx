import { Dialog } from "@opencode-ai/ui/dialog"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { ImagePreview } from "@opencode-ai/ui/image-preview"
import { useSDK } from "@/context/sdk"
import { useServer } from "@/context/server"
import { usePlatform } from "@/context/platform"
import { useLanguage } from "@/context/language"
import type { ImageAttachmentPart, Prompt } from "@/context/prompt"
import { authTokenFromCredentials } from "@/utils/server"
import { mediaContentURL } from "@/utils/media-url"
import { DialogMediaLibrary } from "../dialog-media-library"
import { attachMediaAssets } from "./media-attachments"

export function createPromptMedia(input: {
  capture: () => {
    current: () => Prompt
    cursor: () => number | undefined
    set: (prompt: Prompt, cursor?: number) => void
  }
}) {
  const sdk = useSDK()
  const server = useServer()
  const platform = usePlatform()
  const dialog = useDialog()
  const language = useLanguage()
  const source = () => ({
    url: sdk().url.replace(/\/+$/, ""),
    directory: sdk().directory,
    username: server.current?.http.username,
    password: server.current?.http.password,
    authorization: server.current?.http.password
      ? `Basic ${authTokenFromCredentials({ username: server.current.http.username, password: server.current.http.password })}`
      : undefined,
  })
  const open = (upload = false) => {
    const target = input.capture()
    const snapshot = source()
    dialog.show(() => (
      <DialogMediaLibrary
        source={snapshot}
        upload={upload}
        onSelect={(assets) => attachMediaAssets({ assets, source: snapshot, target, store: platform.draftStore })}
      />
    ))
  }
  return {
    actions: [
      { label: language.t("media.picker.open"), onSelect: () => open() },
      { label: language.t("media.upload.open"), onSelect: () => open(true) },
    ],
    open,
    preview: (attachment: ImageAttachmentPart) => {
      if (attachment.media && attachment.mime.startsWith("video/")) {
        const url = mediaContentURL({
          ...source(),
          directory: attachment.media.directory,
          id: attachment.media.asset_id,
        })
        dialog.show(() => (
          <Dialog title={attachment.filename} size="large">
            <video src={url} controls class="max-h-[70vh] w-full" />
          </Dialog>
        ))
        return
      }
      dialog.show(() => <ImagePreview src={attachment.blob.url} alt={attachment.filename} />)
    },
  }
}
