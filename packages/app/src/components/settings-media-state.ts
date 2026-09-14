import { createStore, reconcile } from "solid-js/store"
import { entries } from "remeda"

const defaults = {
  openai_base_url: "",
  openai_api_key: "",
  ark_base_url: "",
  ark_api_key: "",
  dashscope_base_url: "",
  dashscope_api_key: "",
  minimax_base_url: "",
  minimax_api_key: "",
  agnes_base_url: "https://apihub.agnes-ai.com/v1",
  agnes_api_key: "",
  image_model: "gpt-image-2",
  video_model: "seedance-2-0",
}

export type MediaSettings = typeof defaults

export function createMediaSettingsController(input: {
  read: () => Promise<unknown>
  write: (media: Partial<MediaSettings>) => Promise<unknown>
}) {
  const [state, setState] = createStore({
    form: { ...defaults },
    saved: {} as Partial<MediaSettings>,
    ready: false,
    loading: false,
    saving: false,
    success: false,
    error: undefined as "load" | "save" | "verify" | undefined,
  })
  const patch = (): Partial<MediaSettings> =>
    Object.fromEntries(
      entries(state.form).flatMap(([key, value]) => {
        // Empty secret drafts mean "keep the saved key". Mask placeholders
        // never become form values or enter the update payload.
        if (key.endsWith("_api_key")) return value.trim() ? [[key, value.trim()]] : []
        if (value === (state.saved[key] ?? defaults[key])) return []
        return [[key, value]]
      }),
    )
  const canSave = () => state.ready && !state.loading && !state.saving && Object.keys(patch()).length > 0
  const hydrate = (media: Partial<MediaSettings>) => {
    setState("saved", reconcile(media))
    setState("form", {
      ...defaults,
      ...Object.fromEntries(Object.entries(media).filter(([key]) => !key.endsWith("_api_key"))),
    })
  }
  return {
    state,
    canSave,
    configured: (key: keyof MediaSettings) => !!state.saved[key]?.trim(),
    change(key: keyof MediaSettings, value: string) {
      if (!state.ready || state.loading || state.saving) return
      setState({ success: false, error: undefined })
      setState("form", key, value)
    },
    async load() {
      if (state.loading || state.saving) return
      setState({ loading: true, ready: false, success: false, error: undefined })
      const media = await input.read().then(readMedia, () => undefined)
      if (media === undefined) {
        setState({ loading: false, error: "load" })
        return
      }
      hydrate(media)
      setState({ loading: false, ready: true })
    },
    async save() {
      if (!canSave()) return false
      const media = patch()
      setState({ saving: true, success: false, error: undefined })
      const written = await input.write(media).then(
        () => true,
        () => false,
      )
      if (!written) {
        setState({ saving: false, error: "save" })
        return false
      }
      // A successful PATCH can silently discard fields on older servers.
      // Only confirm persistence after an independent GET returns each edit.
      const saved = await input.read().then(readMedia, () => undefined)
      if (saved === undefined || entries(media).some(([key, value]) => saved[key] !== value)) {
        if (saved) setState("saved", reconcile(saved))
        setState({ saving: false, error: "verify" })
        return false
      }
      hydrate(saved)
      setState({ saving: false, success: true })
      return true
    },
  }
}

function readMedia(config: unknown): Partial<MediaSettings> | undefined {
  if (!config || typeof config !== "object" || Array.isArray(config)) return undefined
  if (!("media" in config) || config.media === undefined) return {}
  if (!config.media || typeof config.media !== "object" || Array.isArray(config.media)) return undefined
  const fields: [string, unknown][] = Object.entries(config.media).filter(([key]) => Object.hasOwn(defaults, key))
  if (fields.some(([, value]) => typeof value !== "string")) return undefined
  const media = Object.fromEntries(fields.filter((entry): entry is [string, string] => typeof entry[1] === "string"))
  if (media.image_model === "agnes-image-2.0" || media.image_model === "agnes-image-2.0-flash") {
    media.image_model = "agnes-image-2.1-flash"
  }
  if (media.video_model === "h3") media.video_model = "MiniMax-H3"
  return media
}
