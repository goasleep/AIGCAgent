import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260912120857_media_asset",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`media_asset\` (
          \`id\` text PRIMARY KEY,
          \`project_id\` text NOT NULL,
          \`path\` text NOT NULL,
          \`kind\` text NOT NULL,
          \`mime\` text NOT NULL,
          \`bytes\` integer NOT NULL,
          \`width\` integer,
          \`height\` integer,
          \`duration_ms\` integer,
          \`source\` text NOT NULL,
          \`model\` text,
          \`prompt\` text,
          \`params\` text,
          \`job_id\` text,
          \`cost_usd_estimate\` real,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_media_asset_project_id_project_id_fk\` FOREIGN KEY (\`project_id\`) REFERENCES \`project\`(\`id\`) ON DELETE CASCADE
        );
      `)
    })
  },
} satisfies DatabaseMigration.Migration
