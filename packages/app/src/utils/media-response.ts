export async function readMediaResponse<T>(response: Response, kind: "list" | "stats"): Promise<T> {
  const body: unknown = await response.json().catch(() => {
    throw new Error(`media ${kind} returned a non-JSON response (HTTP ${response.status})`)
  })
  const object = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value)
  const valid =
    object(body) &&
    (kind === "stats"
      ? [body.count, body.bytes, body.cost_usd_estimate].every(
          (value) => typeof value === "number" && Number.isFinite(value),
        )
      : Array.isArray(body.items) &&
        body.items.every(
          (item) =>
            object(item) &&
            typeof item.id === "string" &&
            typeof item.path === "string" &&
            typeof item.mime === "string" &&
            (item.kind === "image" || item.kind === "video") &&
            typeof item.bytes === "number" &&
            typeof item.time_created === "number",
        ) &&
        (body.next === undefined || typeof body.next === "string"))
  if (!valid) throw new Error(`media ${kind} returned an invalid response (HTTP ${response.status})`)
  return body as T
}
