import { expect, test } from "bun:test"
import { createEffect, createRoot, createSignal } from "solid-js"
import { createServer, type ServerResponse } from "node:http"
import { createMediaLibrary, type MediaAsset } from "../src/utils/media-library"

const asset = (id: string, kind: "image" | "video" = "image"): MediaAsset => ({
  id,
  kind,
  path: `${id}.png`,
  mime: `${kind}/png`,
  bytes: 1000,
  time_created: 1,
  width: null,
  height: null,
  duration_ms: null,
  source: "generate",
  model: null,
  prompt: null,
  cost_usd_estimate: null,
})

async function setup() {
  type Request = { url: URL; response: ServerResponse }
  const pending: Request[] = []
  const waiting: ((request: Request) => void)[] = []
  const seen: string[] = []
  const server = createServer((request, response) => {
    response.setHeader("Access-Control-Allow-Origin", "*")
    response.setHeader("Access-Control-Allow-Headers", "Authorization")
    if (request.method === "OPTIONS") return response.writeHead(204).end()
    seen.push(request.url!)
    const value = { url: new URL(request.url!, "http://localhost"), response }
    const resolve = waiting.shift()
    if (resolve) return resolve(value)
    pending.push(value)
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Expected TCP server")
  const root = createRoot((dispose) => {
    const [source, setSource] = createSignal({
      url: `http://127.0.0.1:${address.port}`,
      directory: "/first",
      kind: "all" as "all" | "image" | "video",
    })
    return { library: createMediaLibrary(source), source, setSource, dispose }
  })
  return {
    ...root,
    seen,
    next: () =>
      pending.length ? Promise.resolve(pending.shift()!) : new Promise<Request>((resolve) => waiting.push(resolve)),
    [Symbol.dispose]() {
      root.dispose()
      server.closeAllConnections()
      server.close()
    },
  }
}

function settled(library: ReturnType<typeof createMediaLibrary>) {
  return new Promise<void>((resolve) =>
    createRoot((dispose) => {
      createEffect(() => {
        if (library.loading()) return
        dispose()
        resolve()
      })
    }),
  )
}

function reply(response: ServerResponse, items: MediaAsset[], next?: string) {
  response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ items, next }))
}

test("shows metadata immediately, retains it during refresh/failure and avoids equivalent requests", async () => {
  using api = await setup()
  const first = await api.next()
  expect(api.library.loading()).toBe(true)
  expect(api.library.items()).toEqual([])
  reply(first.response, [asset("one")])
  await settled(api.library)
  expect(api.library.items().map((item) => item.id)).toEqual(["one"])
  api.setSource({ ...api.source() })
  expect(api.library.loading()).toBe(false)
  expect(api.seen).toHaveLength(1)

  const refresh = api.library.refetch()
  const second = await api.next()
  expect(api.library.items().map((item) => item.id)).toEqual(["one"])
  expect(api.library.refetch()).toBeUndefined()
  second.response.writeHead(503).end()
  await refresh
  expect(api.library.items().map((item) => item.id)).toEqual(["one"])
  expect(api.library.error()).toBe(true)
  const original = api.library.items()[0]
  const retry = api.library.refetch()
  reply((await api.next()).response, [asset("one"), asset("two")])
  await retry
  expect(api.library.error()).toBe(false)
  expect(api.library.items().map((item) => item.id)).toEqual(["one", "two"])
  expect(api.library.items()[0]).toBe(original)
})

test("does not show a previous project's late response after switching projects", async () => {
  using api = await setup()
  const first = await api.next()
  api.setSource({ ...api.source(), directory: "/second" })
  const second = await api.next()
  expect(second.url.searchParams.get("directory")).toBe("/second")
  expect(api.library.items()).toEqual([])
  reply(second.response, [asset("current")])
  await settled(api.library)
  reply(first.response, [asset("stale")])
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
  expect(api.library.items().map((item) => item.id)).toEqual(["current"])
})

test("refreshing after a deletion supersedes an in-flight background refresh", async () => {
  using api = await setup()
  reply((await api.next()).response, [asset("deleted")])
  await settled(api.library)
  const old = api.library.refetch()
  const stale = await api.next()
  const latest = api.library.refetch(true)
  reply((await api.next()).response, [])
  await latest
  reply(stale.response, [asset("deleted")])
  await old
  expect(api.library.items()).toEqual([])
  expect(api.library.error()).toBe(false)
})

test("deduplicates pagination and discards it when the filter changes", async () => {
  using api = await setup()
  reply((await api.next()).response, [asset("one")], "next")
  await settled(api.library)
  const more = api.library.loadMore()
  const page = await api.next()
  expect(page.url.searchParams.get("cursor")).toBe("next")
  await api.library.loadMore()
  expect(api.seen).toHaveLength(2)
  reply(page.response, [asset("one"), asset("two")], "last")
  await more
  expect(api.library.items().map((item) => item.id)).toEqual(["one", "two"])

  const stale = api.library.loadMore()
  const late = await api.next()
  api.setSource({ ...api.source(), kind: "video" })
  const videos = await api.next()
  expect(videos.url.searchParams.get("kind")).toBe("video")
  reply(videos.response, [asset("video", "video")])
  await settled(api.library)
  reply(late.response, [asset("wrong")])
  await stale
  expect(api.library.items().map((item) => item.id)).toEqual(["video"])
  expect(api.library.more()).toBe(false)
})
