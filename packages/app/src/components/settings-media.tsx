import { Button } from "@opencode-ai/ui/button"
import { Icon } from "@opencode-ai/ui/icon"
import { Select } from "@opencode-ai/ui/select"
import { TextField } from "@opencode-ai/ui/text-field"
import { For, Show, createEffect, createUniqueId, onMount, type Component } from "solid-js"
import { createStore } from "solid-js/store"
import type { Config } from "@opencode-ai/sdk/v2"
import { useLanguage } from "@/context/language"
import { useServerSDK, type ServerSDK } from "@/context/server-sdk"
import { useServerSync } from "@/context/server-sync"
import { showToast } from "@/utils/toast"
import { createMediaSettingsController, type MediaSettings } from "./settings-media-state"

type MediaMode = "image" | "video"
type ModelOption = { id: string; label: string; value: string }
type MediaProvider = {
  id: string
  name: string
  url?: keyof MediaSettings
  key: keyof MediaSettings
  imageModels: readonly ModelOption[]
  videoModels: readonly ModelOption[]
}

const providers: readonly MediaProvider[] = [
  {
    id: "openai",
    name: "OpenAI",
    url: "openai_base_url",
    key: "openai_api_key",
    imageModels: [{ id: "openai:gpt-image-2", label: "GPT Image 2", value: "gpt-image-2" }],
    videoModels: [],
  },
  {
    id: "ark",
    name: "Ark",
    url: "ark_base_url",
    key: "ark_api_key",
    imageModels: [],
    videoModels: [
      { id: "ark:seedance-2-0", label: "Seedance 2.0", value: "seedance-2-0" },
      { id: "ark:seedance-2-5", label: "Seedance 2.5", value: "seedance-2-5" },
    ],
  },
  {
    id: "dashscope",
    name: "DashScope",
    url: "dashscope_base_url",
    key: "dashscope_api_key",
    imageModels: [],
    videoModels: [
      { id: "dashscope:wan2.7", label: "Wan 2.7", value: "wan2.7" },
      { id: "dashscope:wan3", label: "Wan 3", value: "wan3" },
    ],
  },
  {
    id: "minimax",
    name: "MiniMax",
    url: "minimax_base_url",
    key: "minimax_api_key",
    imageModels: [],
    videoModels: [
      { id: "minimax:h3", label: "H3", value: "MiniMax-H3" },
      { id: "minimax:hailuo", label: "Hailuo", value: "hailuo" },
    ],
  },
  {
    id: "agnes",
    name: "Agnes",
    url: "agnes_base_url",
    key: "agnes_api_key",
    imageModels: [
      { id: "agnes:image", label: "Image", value: "agnes-image" },
      { id: "agnes:image-2.1-flash", label: "Image 2.1 Flash", value: "agnes-image-2.1-flash" },
      { id: "agnes:image-2.5-flash", label: "Image 2.5 Flash", value: "agnes-image-2.5-flash" },
    ],
    videoModels: [
      { id: "agnes:video", label: "Video", value: "agnes-video" },
      { id: "agnes:video-v2.0", label: "Video V2.0", value: "agnes-video-v2.0" },
      { id: "agnes:video-2.5-flash", label: "Video 2.5 Flash", value: "agnes-video-2.5-flash" },
    ],
  },
]

export const SettingsMedia: Component = () => {
  const sdk = useServerSDK()
  return (
    <Show when={sdk()} keyed>
      {(server) => <MediaSettingsForm server={server} />}
    </Show>
  )
}

const MediaSettingsForm: Component<{ server: ServerSDK }> = (props) => {
  const language = useLanguage()
  const sync = useServerSync()()
  const controller = createMediaSettingsController({
    read: () => props.server.client.global.config.get({ throwOnError: true }).then((result) => result.data),
    write: (media) => {
      const config: Config & { media: Partial<MediaSettings> } = { media }
      return sync.updateConfig(config)
    },
  })
  const form = controller.state.form
  const typeId = createUniqueId()
  const [selection, setSelection] = createStore<{ mode: MediaMode; provider: string }>({ mode: "image", provider: "" })
  const field = () => (selection.mode === "image" ? "image_model" : "video_model")
  const modelsFor = (provider: (typeof providers)[number], mode: MediaMode) =>
    mode === "image" ? provider.imageModels : provider.videoModels
  const providersFor = (mode: MediaMode) => providers.filter((provider) => modelsFor(provider, mode).length > 0)
  const availableProviders = () => providersFor(selection.mode)
  const providerForModel = (mode: MediaMode, model: string) =>
    providersFor(mode).find((provider) => modelsFor(provider, mode).some((option) => option.value === model))?.id ??
    providersFor(mode)[0]?.id ??
    ""
  const selectedProvider = () =>
    availableProviders().find((provider) => provider.id === selection.provider) ??
    availableProviders().find((provider) => provider.id === providerForModel(selection.mode, form[field()])) ??
    availableProviders()[0]
  const selectedModels = () => {
    const provider = selectedProvider()
    return provider ? modelsFor(provider, selection.mode) : []
  }

  createEffect(() => {
    if (!controller.state.ready) return
    const provider = selectedProvider()
    if (!provider) return
    if (selection.provider !== provider.id) setSelection("provider", provider.id)
    const options = modelsFor(provider, selection.mode)
    if (!options.some((option) => option.value === form[field()]) && options[0])
      controller.change(field(), options[0].value)
  })

  onMount(() => void controller.load())
  const save = async () => {
    if (!(await controller.save())) return
    showToast({ variant: "success", title: language.t("settings.media.saved") })
  }
  const changeMode = (mode: MediaMode) => {
    setSelection({
      mode,
      provider: providerForModel(mode, form[mode === "image" ? "image_model" : "video_model"]),
    })
  }
  const changeProvider = (id: string) => {
    setSelection("provider", id)
    const provider = providers.find((item) => item.id === id)
    const options = provider ? modelsFor(provider, selection.mode) : []
    if (options.length > 0 && !options.some((option) => option.value === form[field()]) && options[0]) {
      controller.change(field(), options[0].value)
    }
  }

  return (
    <div class="flex max-w-2xl flex-col gap-6 p-6" data-component="settings-media" aria-busy={controller.state.loading}>
      <div>
        <h2 class="text-18-medium">{language.t("settings.media.title")}</h2>
        <p class="text-12-regular text-text-weak">{language.t("settings.media.description")}</p>
      </div>
      <Show when={controller.state.loading}>
        <p role="status" class="text-14-regular text-text-weak">
          {language.t("settings.media.loading")}
        </p>
      </Show>
      <Show when={controller.state.error === "load"}>
        <div role="alert" class="flex flex-col gap-2 text-14-regular text-text-strong">
          <p>{language.t("settings.media.error.load")}</p>
          <Button onClick={() => void controller.load()}>{language.t("settings.media.retry")}</Button>
        </div>
      </Show>
      <Show when={controller.state.ready}>
        <fieldset class="min-w-0" disabled={controller.state.saving}>
          <legend class="mb-3 text-14-medium">{language.t("settings.media.type")}</legend>
          <div class="grid grid-cols-2 gap-3">
            <For each={["image", "video"] as const}>
              {(mode) => (
                <label class="min-w-0 cursor-pointer has-disabled:cursor-not-allowed has-disabled:opacity-50">
                  <input
                    type="radio"
                    name={typeId}
                    value={mode}
                    checked={selection.mode === mode}
                    onChange={() => changeMode(mode)}
                    aria-controls={`${typeId}-config`}
                    class="peer sr-only"
                  />
                  <span class="flex min-h-24 items-center gap-3 rounded-lg border border-border-base p-4 text-text-weak transition-colors hover:bg-surface-base-hover peer-checked:border-border-selected peer-checked:bg-surface-base-hover peer-checked:text-text-strong peer-focus-visible:ring-2 peer-focus-visible:ring-border-selected peer-focus-visible:ring-offset-2">
                    <Icon name={mode === "image" ? "photo" : "video"} size="large" />
                    <span class="flex-1 text-14-medium">
                      {language.t(mode === "image" ? "settings.media.type.image" : "settings.media.type.video")}
                    </span>
                    <span class="flex size-5 shrink-0 items-center justify-center rounded-full border border-current">
                      <Show when={selection.mode === mode}>
                        <Icon name="check" size="small" />
                      </Show>
                    </span>
                  </span>
                </label>
              )}
            </For>
          </div>
        </fieldset>
        <section id={`${typeId}-config`} data-media-type={selection.mode} class="flex flex-col gap-6">
          <div class="flex flex-col gap-2">
            <span class="text-14-medium">{language.t("settings.media.provider")}</span>
            <Select
              triggerProps={{ "aria-label": language.t("settings.media.provider") }}
              options={availableProviders().map((provider) => ({
                id: provider.id,
                label: provider.name,
                value: provider.id,
              }))}
              current={
                selectedProvider()
                  ? { id: selectedProvider()!.id, label: selectedProvider()!.name, value: selectedProvider()!.id }
                  : undefined
              }
              value={(item) => item.id}
              label={(item) => item.label}
              onSelect={(item) => item && changeProvider(item.value)}
              disabled={controller.state.saving}
            />
          </div>
          <Show when={selectedProvider()} keyed>
            {(provider) => (
              <div class="flex flex-col gap-4 rounded-lg border border-border-base p-4" data-provider={provider.name}>
                <div class="flex items-center justify-between gap-3">
                  <h3 class="text-14-medium">{provider.name}</h3>
                  <span
                    role="status"
                    class="flex items-center gap-1 text-12-medium"
                    classList={{
                      "text-text-strong": controller.configured(provider.key),
                      "text-text-weak": !controller.configured(provider.key),
                    }}
                  >
                    <Show when={controller.configured(provider.key) && !form[provider.key].trim()}>
                      <Icon name="check" size="small" class="text-icon-success-base" />
                    </Show>
                    {form[provider.key].trim()
                      ? language.t("settings.media.key.pending")
                      : controller.configured(provider.key)
                        ? language.t("settings.media.key.configured")
                        : language.t("settings.media.key.missing")}
                  </span>
                </div>
                <Show when={provider.url} keyed>
                  {(url) => (
                    <TextField
                      label={language.t("settings.media.apiUrl", { provider: provider.name })}
                      value={form[url]}
                      placeholder={provider.id === "openai" ? "https://api.openai.com/v1" : undefined}
                      description={
                        provider.id === "openai" ? language.t("settings.media.openai.compatibleHint") : undefined
                      }
                      disabled={controller.state.saving}
                      onChange={(value) => controller.change(url, value)}
                    />
                  )}
                </Show>
                <TextField
                  label={language.t("settings.media.apiKey", { provider: provider.name })}
                  type="password"
                  autocomplete="new-password"
                  value={form[provider.key]}
                  placeholder={
                    controller.configured(provider.key) ? "••••••••" : language.t("provider.connect.apiKey.placeholder")
                  }
                  description={
                    controller.configured(provider.key)
                      ? language.t("settings.media.key.savedHint")
                      : language.t("settings.media.key.emptyHint")
                  }
                  disabled={controller.state.saving}
                  onChange={(value) => controller.change(provider.key, value)}
                />
              </div>
            )}
          </Show>
          <div class="flex flex-col gap-2">
            <span class="text-14-medium">
              {language.t(selection.mode === "image" ? "settings.media.imageModel" : "settings.media.videoModel")}
            </span>
            <Select
              triggerProps={{
                "aria-label": language.t(
                  selection.mode === "image" ? "settings.media.imageModel" : "settings.media.videoModel",
                ),
              }}
              options={[...selectedModels()]}
              current={selectedModels().find((item) => item.value === form[field()]) ?? selectedModels()[0]}
              value={(item) => item.id}
              label={(item) => item.label}
              onSelect={(item) => item && controller.change(field(), item.value)}
              disabled={controller.state.saving}
            />
          </div>
        </section>
        <Show when={controller.state.error === "save" || controller.state.error === "verify"}>
          <p role="alert" class="rounded-lg border border-border-critical-base p-3 text-14-regular text-text-strong">
            {language.t(
              controller.state.error === "verify" ? "settings.media.error.verify" : "settings.media.error.save",
            )}
          </p>
        </Show>
        <Show when={controller.state.success}>
          <p role="status" class="flex items-center gap-2 text-14-regular text-text-strong">
            <Icon name="check" size="small" class="text-icon-success-base" />
            {language.t("settings.media.saved")}
          </p>
        </Show>
        <Button onClick={save} disabled={!controller.canSave()}>
          {language.t(controller.state.saving ? "common.saving" : "common.save")}
        </Button>
      </Show>
    </div>
  )
}
