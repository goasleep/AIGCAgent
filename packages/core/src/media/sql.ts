import { integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { ProjectTable } from "../project/sql"
import { Timestamps } from "../database/schema.sql"

/**
 * 媒体库产物表（AIGC 工作台）。
 * path 为项目相对路径（相对 project.worktree），迁移项目后不失效。
 * cost_usd_estimate 仅为估算值，非计费依据。
 */
export const MediaAssetTable = sqliteTable("media_asset", {
  id: text().primaryKey(),
  project_id: text()
    .notNull()
    .references(() => ProjectTable.id, { onDelete: "cascade" }),
  path: text().notNull(),
  kind: text().$type<"image" | "video">().notNull(),
  mime: text().notNull(),
  bytes: integer().notNull(),
  width: integer(),
  height: integer(),
  duration_ms: integer(),
  source: text().$type<"generate" | "process">().notNull(),
  model: text(),
  prompt: text(),
  params: text({ mode: "json" }).$type<Record<string, unknown>>(),
  job_id: text(),
  cost_usd_estimate: real(),
  ...Timestamps,
})
