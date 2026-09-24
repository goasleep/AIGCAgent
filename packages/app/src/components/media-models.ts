import type { MediaSettings } from "./settings-media-state"

export type MediaMode = "image" | "video"
export type MediaModelOption = { id: string; label: string; value: string }
export type MediaProviderCatalog = {
  id: string
  name: string
  url?: keyof MediaSettings
  key: keyof MediaSettings
  imageModels: readonly MediaModelOption[]
  videoModels: readonly MediaModelOption[]
}

/** 生成 provider 与模型目录；与内核 media/provider.ts 支持的模型保持一致 */
export const mediaProviders: readonly MediaProviderCatalog[] = [
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

export const mediaModelsFor = (mode: MediaMode): readonly MediaModelOption[] => {
  const seen = new Set<string>()
  return mediaProviders
    .flatMap((provider) => (mode === "image" ? provider.imageModels : provider.videoModels))
    .filter((option) => !seen.has(option.value) && seen.add(option.value))
}

export const providerForModel = (mode: MediaMode, model: string) =>
  mediaProviders.find((provider) =>
    (mode === "image" ? provider.imageModels : provider.videoModels).some((option) => option.value === model),
  )
