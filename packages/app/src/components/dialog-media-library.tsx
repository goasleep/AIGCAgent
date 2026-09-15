import { createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { Dialog } from "@opencode-ai/ui/dialog"
import { Button } from "@opencode-ai/ui/button"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { useLanguage } from "@/context/language"
import { createMediaLibrary, type MediaAsset, type MediaKindFilter, type MediaSource } from "@/utils/media-library"
import { mediaContentURL } from "@/utils/media-url"
import { uploadMediaFile } from "@/utils/media-upload"

export const MEDIA_FILE_TYPES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "video/mp4",
  "video/quicktime",
  "video/webm",
  "video/x-matroska",
  ".mkv",
  ".mov",
]

export function DialogMediaLibrary(props: {
  source: MediaSource
  upload?: boolean
  onSelect: (assets: MediaAsset[]) => Promise<void>
}) {
  const dialog = useDialog()
  const language = useLanguage()
  const [kind, setKind] = createSignal<MediaKindFilter>("all")
  const [selected, setSelected] = createSignal<MediaAsset[]>([])
  const [busy, setBusy] = createSignal(false)
  const [progress, setProgress] = createSignal<string>()
  const [errors, setErrors] = createSignal<string[]>([])
  const library = createMediaLibrary(() => ({ ...props.source, kind: kind() }))
  let picker: HTMLInputElement | undefined
  let request: ReturnType<typeof uploadMediaFile> | undefined
  const lifecycle = { active: true }
  onCleanup(() => {
    lifecycle.active = false
    request?.abort()
  })
  onMount(() => {
    if (props.upload) picker?.click()
  })
  const content = (id: string, thumbnail = false) =>
    mediaContentURL({ ...props.source, id, preview: thumbnail ? "thumbnail" : undefined })
  const toggle = (asset: MediaAsset) =>
    setSelected((items) =>
      items.some((item) => item.id === asset.id) ? items.filter((item) => item.id !== asset.id) : [...items, asset],
    )
  const upload = async (files: File[]) => {
    setBusy(true)
    setErrors([])
    for (const file of files) {
      if (!lifecycle.active) break
      request = uploadMediaFile({
        source: props.source,
        file,
        messages: { failed: language.t("media.upload.failed"), tooLarge: language.t("media.upload.tooLarge") },
        onProgress: (percent) => {
          if (lifecycle.active) setProgress(`${file.name} · ${percent}%`)
        },
      })
      await request.promise
        .then(async (asset) => {
          if (!lifecycle.active) return
          await props.onSelect([asset])
        })
        .catch((error: unknown) => {
          if (lifecycle.active)
            setErrors((items) => [...items, `${file.name}: ${error instanceof Error ? error.message : String(error)}`])
        })
    }
    if (!lifecycle.active) return
    setBusy(false)
    setProgress(undefined)
    void library.refetch(true)
  }
  const add = async () => {
    setBusy(true)
    await props
      .onSelect(selected())
      .then(() => dialog.close())
      .catch((error: unknown) => {
        setErrors([error instanceof Error ? error.message : String(error)])
        setBusy(false)
      })
  }

  return (
    <Dialog title={language.t("media.picker.title")} size="large">
      <div class="flex flex-col gap-4 px-5 pb-5" data-component="media-library-picker">
        <div class="flex items-center gap-2">
          <For each={["all", "image", "video"] as const}>
            {(value) => (
              <Button variant={kind() === value ? "primary" : "ghost"} onClick={() => setKind(value)}>
                {language.t(
                  value === "all"
                    ? "media.filter.all"
                    : value === "image"
                      ? "media.filter.image"
                      : "media.filter.video",
                )}
              </Button>
            )}
          </For>
          <div class="flex-1" />
          <Button onClick={() => picker?.click()} disabled={busy()}>
            {language.t("media.upload.open")}
          </Button>
          <input
            ref={picker}
            type="file"
            class="hidden"
            multiple
            accept={MEDIA_FILE_TYPES.join(",")}
            onChange={(event) => {
              const files = Array.from(event.currentTarget.files ?? [])
              event.currentTarget.value = ""
              if (files.length) void upload(files)
            }}
          />
        </div>
        <p class="text-12-regular text-text-weak">{language.t("media.upload.hint")}</p>
        <Show when={progress()}>
          {(value) => (
            <div role="status" aria-live="polite" class="text-13-regular">
              {value()}
            </div>
          )}
        </Show>
        <For each={errors()}>
          {(error) => (
            <p role="alert" class="text-13-regular text-red-base">
              {error}
            </p>
          )}
        </For>
        <Show when={library.error()}>
          <p role="alert">{language.t("media.load.error")}</p>
        </Show>
        <div class="min-h-40 max-h-[55vh] overflow-y-auto">
          <Show
            when={!library.loading() || library.items().length}
            fallback={<p role="status">{language.t("common.loading")}</p>}
          >
            <Show
              when={library.items().length}
              fallback={<p class="py-10 text-center text-text-weak">{language.t("media.empty")}</p>}
            >
              <div class="grid grid-cols-2 gap-3 sm:grid-cols-3">
                <For each={library.items()}>
                  {(asset) => (
                    <div class="overflow-hidden rounded-lg border border-border-weak-base">
                      <Show
                        when={asset.kind === "video"}
                        fallback={
                          <img
                            src={content(asset.id, true)}
                            alt={asset.path}
                            class="h-32 w-full object-cover"
                            loading="lazy"
                            onError={(event) => {
                              if (event.currentTarget.src !== content(asset.id))
                                event.currentTarget.src = content(asset.id)
                            }}
                          />
                        }
                      >
                        <video
                          src={content(asset.id)}
                          poster={content(asset.id, true)}
                          controls
                          preload="none"
                          class="h-32 w-full object-contain"
                        />
                      </Show>
                      <label class="flex cursor-pointer items-center gap-2 p-2 text-12-regular">
                        <input
                          type="checkbox"
                          checked={selected().some((item) => item.id === asset.id)}
                          onChange={() => toggle(asset)}
                          disabled={busy()}
                        />
                        <span class="truncate" title={asset.path}>
                          {typeof asset.params?.filename === "string"
                            ? asset.params.filename
                            : asset.path.split("/").pop()}
                        </span>
                      </label>
                    </div>
                  )}
                </For>
              </div>
              <Show when={library.next()}>
                <Button class="mt-3" disabled={library.more()} onClick={() => void library.loadMore()}>
                  {language.t("media.load.more")}
                </Button>
              </Show>
            </Show>
          </Show>
        </div>
        <div class="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => dialog.close()}>
            {language.t("common.close")}
          </Button>
          <Button variant="primary" disabled={busy() || !selected().length} onClick={() => void add()}>
            {language.t("media.picker.add", { count: String(selected().length) })}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}
