import { expect, test } from "bun:test"
import { readMediaResponse } from "./media-response"

test("rejects HTML fallback and malformed JSON before rendering media data", async () => {
  await expect(readMediaResponse(new Response("<!doctype html><html>app</html>"), "stats")).rejects.toThrow("non-JSON")
  for (const body of [{}, null, [], { count: 1, bytes: 100 }, { count: 1, bytes: 100, cost_usd_estimate: "0" }]) {
    await expect(readMediaResponse(new Response(JSON.stringify(body)), "stats")).rejects.toThrow("invalid response")
  }
  for (const body of [{}, { items: null }, { items: [{}] }, { items: [], next: 1 }]) {
    await expect(readMediaResponse(new Response(JSON.stringify(body)), "list")).rejects.toThrow("invalid response")
  }
  expect(
    await readMediaResponse<{ items: unknown[] }>(
      new Response(JSON.stringify({ items: [] }), { headers: { "content-type": "application/json" } }),
      "list",
    ),
  ).toEqual({ items: [] })
  expect(
    await readMediaResponse<{ count: number; bytes: number; cost_usd_estimate: number }>(
      new Response(JSON.stringify({ count: 0, bytes: 0, cost_usd_estimate: 0 }), {
        headers: { "content-type": "application/json" },
      }),
      "stats",
    ),
  ).toEqual({ count: 0, bytes: 0, cost_usd_estimate: 0 })
})
