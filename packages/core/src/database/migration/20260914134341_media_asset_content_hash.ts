import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260914134341_media_asset_content_hash",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`media_asset\` ADD \`content_hash\` text;`)
    })
  },
} satisfies DatabaseMigration.Migration
