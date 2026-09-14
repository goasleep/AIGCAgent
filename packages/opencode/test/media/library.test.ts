import { describe, expect, test } from "bun:test"
import { aggregateStats, type Asset } from "@/media/library"

const asset = (input: Partial<Asset>): Asset => ({
  id: "med_test",
  project_id: "project",
  path: ".opencode/media/2026-09/med_test.png",
  kind: "image",
  mime: "image/png",
  bytes: 100,
  width: null,
  height: null,
  duration_ms: null,
  source: "generate",
  model: "gpt-image-2",
  prompt: null,
  params: null,
  job_id: null,
  cost_usd_estimate: 0.12,
  time_created: Date.parse("2026-09-12T00:00:00Z"),
  time_updated: Date.parse("2026-09-12T00:00:00Z"),
  ...input,
})

describe("aggregateStats", () => {
  test("aggregates totals and groups by kind, model, and UTC day", () => {
    const result = aggregateStats([
      asset({ bytes: 100, cost_usd_estimate: 0.12 }),
      asset({ id: "med_video", kind: "video", mime: "video/mp4", bytes: 900, model: "seedance-2-0", cost_usd_estimate: null }),
      asset({ id: "med_second", bytes: 50, cost_usd_estimate: 0.02, time_created: Date.parse("2026-09-13T00:00:00Z") }),
    ])

    expect(result.count).toBe(3)
    expect(result.bytes).toBe(1050)
    expect(result.cost_usd_estimate).toBeCloseTo(0.14)
    expect(result.by_kind.image.count).toBe(2)
    expect(result.by_kind.video.bytes).toBe(900)
    expect(result.by_model[0]?.model).toBe("gpt-image-2")
    expect(result.by_model[0]?.count).toBe(2)
    expect(result.by_model[0]?.cost_usd_estimate).toBeCloseTo(0.14)
    expect(result.by_day.map((item) => item.day)).toEqual(["2026-09-12", "2026-09-13"])
  })
})
