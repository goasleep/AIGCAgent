export * as ConfigMediaV1 from "./media"

import { Schema } from "effect"

export const Info = Schema.Struct({
  image_model: Schema.optional(Schema.String).annotate({
    description: "Default image generation model (default: gpt-image-2)",
  }),
  video_model: Schema.optional(Schema.String).annotate({
    description: "Default video generation model (default: seedance-2-0)",
  }),
  openai_base_url: Schema.optional(Schema.String).annotate({
    description: "Optional OpenAI-compatible base URL for image generation (defaults to https://api.openai.com/v1)",
  }),
  openai_api_key: Schema.optional(Schema.String).annotate({
    description: "Dedicated API key for OpenAI image generation; separate from inference credentials",
  }),
  agnes_api_key: Schema.optional(Schema.String),
  agnes_base_url: Schema.optional(Schema.String),
  ark_api_key: Schema.optional(Schema.String).annotate({
    description: "API key for Volcengine Ark video generation (falls back to ARK_API_KEY env)",
  }),
  ark_base_url: Schema.optional(Schema.String).annotate({
    description: "Volcengine Ark base URL (falls back to ARK_BASE_URL env)",
  }),
  dashscope_api_key: Schema.optional(Schema.String).annotate({
    description:
      "API key for Alibaba DashScope video generation, e.g. wan3.0-video (falls back to DASHSCOPE_API_KEY env)",
  }),
  dashscope_base_url: Schema.optional(Schema.String).annotate({
    description:
      "DashScope base URL (falls back to DASHSCOPE_BASE_URL env, default https://dashscope.aliyuncs.com/api/v1; Wan3 may require the workspace URL https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/api/v1)",
  }),
  minimax_api_key: Schema.optional(Schema.String).annotate({
    description: "API key for MiniMax video generation, e.g. MiniMax-H3 (falls back to MINIMAX_API_KEY env)",
  }),
  minimax_base_url: Schema.optional(Schema.String).annotate({
    description:
      "MiniMax base URL without version suffix (falls back to MINIMAX_BASE_URL env, default https://api.minimax.io; China: https://api.minimax.cn)",
  }),
  ffmpeg_path: Schema.optional(Schema.String).annotate({
    description: "Override ffmpeg binary path (falls back to OPENCODE_MEDIA_FFMPEG env, bundled, then PATH)",
  }),
})
