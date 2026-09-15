import { createMemo, createResource, onCleanup, type Accessor } from "solid-js"
import { createStore } from "solid-js/store"
import { readMediaResponse } from "./media-response"

export type MediaKindFilter = "all" | "image" | "video"

export type MediaAsset = {
  id: string
  path: string
  kind: "image" | "video"
  mime: string
  bytes: number
  width: number | null
  height: number | null
  duration_ms: number | null
  source: "generate" | "process" | "upload"
  content_hash?: string | null
  params?: Record<string, unknown> | null
  model: string | null
  prompt: string | null
  cost_usd_estimate: number | null
  time_created: number
}

export type MediaSource = {
  url: string
  directory: string
  authorization?: string
  username?: string
  password?: string
}
type Source = MediaSource & { kind: MediaKindFilter }
type Page = { items: MediaAsset[]; next?: string }
type Loaded = Page & { source: Source; error: boolean }

export function createMediaLibrary(input: Accessor<Source>) {
  const source = createMemo(input, undefined, {
    equals: (a, b) =>
      a.url === b.url && a.directory === b.directory && a.kind === b.kind && a.authorization === b.authorization,
  })
  const [state, setState] = createStore({ more: false, error: false })
  let request: AbortController | undefined
  let pagination: AbortController | undefined
  onCleanup(() => {
    request?.abort()
    pagination?.abort()
  })

  const read = async (snapshot: Source, signal: AbortSignal, cursor?: string) => {
    const query = new URLSearchParams({ directory: snapshot.directory, limit: "60" })
    if (snapshot.kind !== "all") query.set("kind", snapshot.kind)
    if (cursor) query.set("cursor", cursor)
    const response = await fetch(`${snapshot.url}/media?${query}`, {
      signal,
      headers: snapshot.authorization ? { Authorization: snapshot.authorization } : {},
    })
    if (!response.ok) throw new Error(`media list ${response.status}`)
    return readMediaResponse<Page>(response, "list")
  }

  const [resource, { refetch, mutate }] = createResource<Loaded, Source>(source, async (snapshot, previous) => {
    request?.abort()
    pagination?.abort()
    const controller = new AbortController()
    request = controller
    setState({ more: false, error: false })
    return read(snapshot, controller.signal)
      .then((body) => {
        const saved = new Map(
          previous.value?.source === snapshot ? previous.value.items.map((item) => [item.id, item]) : [],
        )
        return {
          ...body,
          source: snapshot,
          error: false,
          // Preserve DOM/media elements when a focus refresh returns unchanged assets.
          items: body.items.map((item) => {
            const old = saved.get(item.id)
            return old && JSON.stringify(old) === JSON.stringify(item) ? old : item
          }),
        }
      })
      .catch(() => ({
        source: snapshot,
        items: previous.value?.source === snapshot ? previous.value.items : [],
        next: previous.value?.source === snapshot ? previous.value.next : undefined,
        error: true,
      }))
  })
  const page = createMemo(() => {
    const value = resource.latest
    return value?.source === source() ? value : undefined
  })

  const loadMore = async () => {
    const previous = page()
    if (!previous?.next || resource.loading || state.more) return
    const controller = new AbortController()
    pagination = controller
    setState({ more: true, error: false })
    await read(previous.source, controller.signal, previous.next)
      .then((body) => {
        if (controller.signal.aborted || page() !== previous) return
        const seen = new Set(previous.items.map((item) => item.id))
        mutate({
          ...body,
          source: previous.source,
          error: false,
          items: [...previous.items, ...body.items.filter((item) => !seen.has(item.id))],
        })
      })
      .catch(() => {
        if (!controller.signal.aborted && page() === previous) setState("error", true)
      })
    if (!controller.signal.aborted) setState("more", false)
  }

  return {
    source,
    items: () => page()?.items ?? [],
    next: () => page()?.next,
    loading: () => resource.loading,
    more: () => state.more,
    error: () => page()?.error || state.error,
    refetch: (force = false) => (resource.loading && !force ? undefined : refetch()),
    loadMore,
  }
}
