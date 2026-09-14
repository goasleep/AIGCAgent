import { Schema } from "effect"

/** Public status model for media jobs exposed by the instance HTTP API. */
export const Kind = Schema.Literals(["image", "video", "process"])
export type Kind = typeof Kind.Type

export const Status = Schema.Literals(["queued", "running", "completed", "error", "cancelled"])
export type Status = typeof Status.Type

export const Info = Schema.Struct({
  id: Schema.String,
  kind: Kind,
  status: Status,
  title: Schema.optional(Schema.String),
  progress: Schema.NullOr(Schema.Number),
  provider_job_id: Schema.optional(Schema.String),
  asset_id: Schema.optional(Schema.String),
  started_at: Schema.Number,
  completed_at: Schema.optional(Schema.Number),
  output: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
})
export type Info = typeof Info.Type
