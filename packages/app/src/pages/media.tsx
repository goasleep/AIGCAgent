import { createEffect, createMemo, createResource, createSignal, For, on, onCleanup, Show } from "solid-js"
import { useNavigate, useParams } from "@solidjs/router"
import { decodeDirectory } from "@/pages/directory-layout"
import { useLanguage } from "@/context/language"
import { useSDK } from "@/context/sdk"
import { useServer } from "@/context/server"
import { authTokenFromCredentials } from "@/utils/server"
import { legacySessionHref } from "@/utils/session-route"

export type MediaKindFilter = "all" | "image" | "video"

type MediaAsset = {
  id: string
  path: string
  kind: "image" | "video"
  mime: string
  bytes: number
  width: number | null
  height: number | null
  duration_ms: number | null
  source: "generate" | "process"
  model: string | null
  prompt: string | null
  cost_usd_estimate: number | null
  time_created: number
}

const PAGE_SIZE = 60

// 图片官方单价（与内核 media/provider.ts 保持一致），仅作生成前估算
const IMAGE_COST_USD: Record<string, number> = {
  "low:1024x1024": 0.02,
  "medium:1024x1024": 0.066,
  "high:1024x1024": 0.12,
}

export default function MediaPage() {
  const params = useParams()
  const navigate = useNavigate()
  const language = useLanguage()
  const sdk = useSDK()
  const server = useServer()
  const t = language.t

  const directory = createMemo(() => decodeDirectory(params.dir ?? "") ?? "")

  const headers = createMemo((): Record<string, string> => {
    const conn = server.current
    if (!conn) return {}
    if (!conn.http.password) return {}
    return {
      Authorization: `Basic ${authTokenFromCredentials({ username: conn.http.username, password: conn.http.password })}`,
    }
  })

  const contentUrl = (id: string) =>
    `${sdk().url}/media/content?directory=${encodeURIComponent(directory())}&id=${encodeURIComponent(id)}`

  const [kind, setKind] = createSignal<MediaKindFilter>("all")
  const [items, setItems] = createSignal<MediaAsset[]>([])
  const [next, setNext] = createSignal<string | undefined>()
  const [selected, setSelected] = createSignal<Set<string>>(new Set())
  const [showGenerate, setShowGenerate] = createSignal(false)
  const [notice, setNotice] = createSignal<string | undefined>()

  const load = async (cursor?: string) => {
    const query = new URLSearchParams({ directory: directory(), limit: String(PAGE_SIZE) })
    if (kind() !== "all") query.set("kind", kind())
    if (cursor) query.set("cursor", cursor)
    const res = await fetch(`${sdk().url}/media?${query}`, { headers: headers() })
    if (!res.ok) throw new Error(`media list ${res.status}`)
    const body = (await res.json()) as { items: MediaAsset[]; next?: string }
    return body
  }

  const [resource, { refetch }] = createResource(kind, async () => {
    const body = await load()
    setItems(body.items)
    setNext(body.next)
    setSelected(new Set<string>())
    return body
  })

  // 生成发生在会话页；从会话跳回本页会重新挂载并刷新，但停留在本页时
  // 依赖窗口重新聚焦做一次静默刷新，让新产物自动出现。
  createEffect(
    on(kind, () => {
      const handler = () => {
        if (!resource.loading) void refetch()
      }
      window.addEventListener("focus", handler)
      onCleanup(() => window.removeEventListener("focus", handler))
    }),
  )

  const loadMore = async () => {
    const cursor = next()
    if (!cursor) return
    const body = await load(cursor)
    setItems((prev) => [...prev, ...body.items.filter((item) => !prev.some((p) => p.id === item.id))])
    setNext(body.next)
  }

  const toggle = (id: string) => {
    const nextSet = new Set(selected())
    if (nextSet.has(id)) nextSet.delete(id)
    else nextSet.add(id)
    setSelected(nextSet)
  }

  const removeSelected = async () => {
    const ids = [...selected()]
    if (ids.length === 0) return
    if (!window.confirm(t("media.delete.confirm", { count: String(ids.length) }))) return
    const failed: string[] = []
    for (const id of ids) {
      const query = new URLSearchParams({ directory: directory(), id })
      const res = await fetch(`${sdk().url}/media/asset?${query}`, { method: "DELETE", headers: headers() })
      if (!res.ok) failed.push(id)
    }
    setSelected(new Set(failed))
    await refetch()
  }

  /** 新建 creator 会话并把指令发进去，然后跳转过去看流式生成过程 */
  const sendToSession = async (text: string) => {
    setNotice(undefined)
    const result = await sdk().client.session.create({ directory: directory(), agent: "creator" })
    if (!result.data) throw new Error("failed to create session")
    await sdk().client.session.promptAsync({
      sessionID: result.data.id,
      directory: directory(),
      agent: "creator",
      parts: [{ type: "text", text }],
    })
    navigate(legacySessionHref(directory(), result.data.id))
  }

  const useSelected = () => {
    const chosen = items().filter((item) => selected().has(item.id))
    if (chosen.length === 0) return
    const list = chosen.map((item) => `- ${item.path}（kind=${item.kind}, id=${item.id}）`).join("\n")
    void sendToSession(`${t("media.use.prompt")}\n${list}`).catch((error) =>
      setNotice(error instanceof Error ? error.message : String(error)),
    )
  }

  const filterTabs: Array<{ value: MediaKindFilter; label: string }> = [
    { value: "all", label: t("media.filter.all") },
    { value: "image", label: t("media.filter.image") },
    { value: "video", label: t("media.filter.video") },
  ]

  return (
    <div class="size-full overflow-hidden flex flex-col bg-background-base">
      <header class="flex items-center gap-3 border-b border-border-weak-base px-4 py-3">
        <h1 class="text-16-semibold text-text-strong">{t("media.title")}</h1>
        <div class="flex items-center gap-1 rounded-lg bg-background-stronger p-1">
          <For each={filterTabs}>
            {(tab) => (
              <button
                type="button"
                class="rounded-md px-3 py-1 text-13-regular"
                classList={{
                  "bg-background-base text-text-strong shadow-sm": kind() === tab.value,
                  "text-text-weak hover:text-text-base": kind() !== tab.value,
                }}
                onClick={() => setKind(tab.value)}
              >
                {tab.label}
              </button>
            )}
          </For>
        </div>
        <div class="flex-1" />
        <Show when={selected().size > 0}>
          <span class="text-13-regular text-text-weak">{t("media.selected", { count: String(selected().size) })}</span>
          <button
            type="button"
            class="rounded-lg border border-border-weak-base px-3 py-1.5 text-13-regular text-text-base hover:bg-background-stronger"
            onClick={() => useSelected()}
          >
            {t("media.use.selected")}
          </button>
          <button
            type="button"
            class="rounded-lg border border-border-weak-base px-3 py-1.5 text-13-regular text-red-base hover:bg-background-stronger"
            onClick={() => void removeSelected()}
          >
            {t("common.delete")}
          </button>
        </Show>
        <button
          type="button"
          class="rounded-lg bg-text-strong px-3 py-1.5 text-13-regular text-background-base hover:opacity-90"
          onClick={() => setShowGenerate((v) => !v)}
        >
          {showGenerate() ? t("common.close") : t("media.generate.open")}
        </button>
      </header>

      <Show when={showGenerate()}>
        <GeneratePanel
          onSubmit={(text) => {
            setShowGenerate(false)
            void sendToSession(text).catch((error) =>
              setNotice(error instanceof Error ? error.message : String(error)),
            )
          }}
        />
      </Show>

      <Show when={notice()}>
        {(message) => <div class="border-b border-red-base px-4 py-2 text-13-regular text-red-base">{message()}</div>}
      </Show>

      <div class="flex-1 min-h-0 overflow-y-auto p-4">
        <Show
          when={!resource.error}
          fallback={<div class="flex min-h-40 items-center justify-center text-text-weak">{t("media.load.error")}</div>}
        >
          <Show
            when={items().length > 0}
            fallback={
              <Show when={!resource.loading} fallback={<div class="py-20 text-center text-text-weak">{t("common.loading")}</div>}>
                <div class="flex min-h-40 items-center justify-center text-text-weak">{t("media.empty")}</div>
              </Show>
            }
          >
            <div class="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
              <For each={items()}>
                {(asset) => (
                  <button
                    type="button"
                    class="group relative overflow-hidden rounded-xl border text-left transition-shadow hover:shadow-md"
                    classList={{
                      "border-text-strong ring-2 ring-text-strong/40": selected().has(asset.id),
                      "border-border-weak-base": !selected().has(asset.id),
                    }}
                    title={asset.prompt ?? asset.path}
                    onClick={() => toggle(asset.id)}
                  >
                    <div class="flex h-36 items-center justify-center overflow-hidden bg-background-stronger">
                      <Show
                        when={asset.kind === "video"}
                        fallback={
                          <img
                            src={contentUrl(asset.id)}
                            alt={asset.path}
                            loading="lazy"
                            class="size-full object-cover"
                          />
                        }
                      >
                        <video src={contentUrl(asset.id)} preload="metadata" controls class="size-full object-contain" />
                      </Show>
                    </div>
                    <div class="flex flex-col gap-0.5 px-2.5 py-2">
                      <span class="truncate text-12-medium text-text-strong">{asset.path.split("/").pop()}</span>
                      <span class="truncate text-11-regular text-text-weak">
                        {asset.model ?? asset.source} · {formatBytes(asset.bytes)}
                        <Show when={asset.duration_ms}> · {formatDuration(asset.duration_ms!)}</Show>
                      </span>
                    </div>
                  </button>
                )}
              </For>
            </div>
            <Show when={next()}>
              <div class="flex justify-center py-6">
                <button
                  type="button"
                  class="rounded-lg border border-border-weak-base px-4 py-2 text-13-regular text-text-base hover:bg-background-stronger"
                  onClick={() => void loadMore()}
                >
                  {t("media.load.more")}
                </button>
              </div>
            </Show>
          </Show>
        </Show>
      </div>
    </div>
  )
}

function GeneratePanel(props: { onSubmit: (text: string) => void }) {
  const language = useLanguage()
  const t = language.t
  const [kind, setKind] = createSignal<"image" | "video">("image")
  const [prompt, setPrompt] = createSignal("")
  const [size, setSize] = createSignal("1024x1024")
  const [quality, setQuality] = createSignal<"low" | "medium" | "high">("high")
  const [duration, setDuration] = createSignal(5)
  const [ratio, setRatio] = createSignal<"16:9" | "9:16" | "1:1">("16:9")

  const estimate = createMemo(() => IMAGE_COST_USD[`${quality()}:${size()}`] ?? null)

  const submit = () => {
    const text = prompt().trim()
    if (!text) return
    if (kind() === "image") {
      props.onSubmit(t("media.generate.image.prompt", { prompt: text, size: size(), quality: quality() }))
      return
    }
    props.onSubmit(t("media.generate.video.prompt", { prompt: text, duration: String(duration()), ratio: ratio() }))
  }

  const selectClass =
    "rounded-lg border border-border-weak-base bg-background-base px-2 py-1.5 text-13-regular text-text-base"

  return (
    <div class="flex flex-col gap-3 border-b border-border-weak-base bg-background-stronger/40 px-4 py-4">
      <div class="flex items-center gap-2">
        <For each={["image", "video"] as const}>
          {(value) => (
            <button
              type="button"
              class="rounded-md px-3 py-1 text-13-regular"
              classList={{
                "bg-background-base text-text-strong shadow-sm": kind() === value,
                "text-text-weak hover:text-text-base": kind() !== value,
              }}
              onClick={() => setKind(value)}
            >
              {t(value === "image" ? "media.filter.image" : "media.filter.video")}
            </button>
          )}
        </For>
      </div>
      <textarea
        rows={3}
        class="w-full resize-none rounded-lg border border-border-weak-base bg-background-base px-3 py-2 text-13-regular text-text-base outline-none focus:border-text-strong"
        placeholder={t("media.generate.placeholder")}
        value={prompt()}
        onInput={(event) => setPrompt(event.currentTarget.value)}
      />
      <div class="flex flex-wrap items-center gap-3">
        <Show
          when={kind() === "image"}
          fallback={
            <>
              <label class="flex items-center gap-2 text-13-regular text-text-weak">
                {t("media.generate.duration")}
                <select class={selectClass} value={duration()} onChange={(e) => setDuration(Number(e.currentTarget.value))}>
                  <For each={[4, 5, 8, 10]}>{(d) => <option value={d}>{d}s</option>}</For>
                </select>
              </label>
              <label class="flex items-center gap-2 text-13-regular text-text-weak">
                {t("media.generate.ratio")}
                <select
                  class={selectClass}
                  value={ratio()}
                  onChange={(e) => setRatio(e.currentTarget.value as "16:9" | "9:16" | "1:1")}
                >
                  <For each={["16:9", "9:16", "1:1"]}>{(r) => <option value={r}>{r}</option>}</For>
                </select>
              </label>
            </>
          }
        >
          <label class="flex items-center gap-2 text-13-regular text-text-weak">
            {t("media.generate.size")}
            <select class={selectClass} value={size()} onChange={(e) => setSize(e.currentTarget.value)}>
              <For each={["1024x1024", "1536x1024", "1024x1536", "auto"]}>{(s) => <option value={s}>{s}</option>}</For>
            </select>
          </label>
          <label class="flex items-center gap-2 text-13-regular text-text-weak">
            {t("media.generate.quality")}
            <select
              class={selectClass}
              value={quality()}
              onChange={(e) => setQuality(e.currentTarget.value as "low" | "medium" | "high")}
            >
              <For each={["low", "medium", "high"]}>{(q) => <option value={q}>{q}</option>}</For>
            </select>
          </label>
          <Show when={estimate()}>
            {(cost) => <span class="text-13-regular text-text-weak">{t("media.generate.estimate", { cost: `$${cost().toFixed(3)}` })}</span>}
          </Show>
        </Show>
        <div class="flex-1" />
        <button
          type="button"
          class="rounded-lg bg-text-strong px-4 py-1.5 text-13-regular text-background-base hover:opacity-90 disabled:opacity-40"
          disabled={!prompt().trim()}
          onClick={submit}
        >
          {t("media.generate.submit")}
        </button>
      </div>
    </div>
  )
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function formatDuration(ms: number): string {
  const total = Math.round(ms / 1000)
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`
}
