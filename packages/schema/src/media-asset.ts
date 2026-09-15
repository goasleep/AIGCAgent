import { Schema } from "effect"

export const MediaAsset = Schema.Struct({
  id: Schema.String,
  project_id: Schema.String,
  path: Schema.String,
  kind: Schema.Literals(["image", "video"]),
  mime: Schema.String,
  bytes: Schema.Finite,
  width: Schema.NullOr(Schema.Finite),
  height: Schema.NullOr(Schema.Finite),
  duration_ms: Schema.NullOr(Schema.Finite),
  source: Schema.Literals(["generate", "process", "upload"]),
  content_hash: Schema.optional(Schema.NullOr(Schema.String)),
  model: Schema.NullOr(Schema.String),
  prompt: Schema.NullOr(Schema.String),
  params: Schema.NullOr(Schema.Record(Schema.String, Schema.Unknown)),
  job_id: Schema.NullOr(Schema.String),
  cost_usd_estimate: Schema.NullOr(Schema.Finite),
  time_created: Schema.Finite,
  time_updated: Schema.Finite,
}).annotate({ identifier: "MediaAsset" })

export type MediaAsset = typeof MediaAsset.Type
