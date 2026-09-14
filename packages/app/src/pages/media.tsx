import { createEffect, createMemo, createResource, createSignal, For, on, onCleanup, Show } from "solid-js"
import { useNavigate, useParams } from "@solidjs/router"
import { decodeDirectory } from "@/pages/directory-layout"
import { useLanguage } from "@/context/language"
import { useSDK } from "@/context/sdk"
import { useServer } from "@/context/server"
import { authTokenFromCredentials } from "@/utils/server"
import { readMediaResponse } from "@/utils/media-response"
import { mediaContentURL } from "@/utils/media-url"
import { legacySessionHref } from "@/utils/session-route"
import { createMediaLibrary, type MediaKindFilter } from "@/utils/media-library"

export type { MediaKindFilter } from "@/utils/media-library"

type MediaStats = {
  count: number
  bytes: number
  cost_usd_estimate: number
}

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

  const contentUrl = (id: string, preview?: "thumbnail") =>
    mediaContentURL({
      url: sdk().url,
      directory: directory(),
      id,
      username: server.current?.http.username,
      password: server.current?.http.password,
      preview,
    })

  const [kind, setKind] = createSignal<MediaKindFilter>("all")
  const [selected, setSelected] = createSignal<Set<string>>(new Set())
  const [showGenerate, setShowGenerate] = createSignal(false)
  const [notice, setNotice] = createSignal<string | undefined>()

  const library = createMediaLibrary(() => ({
    url: sdk().url.replace(/\/+$/, ""),
    directory: directory(),
    kind: kind(),
    authorization: headers().Authorization,
  }))
  const source = library.source
  const items = library.items
  const next = library.next
  const lifecycle = { active: true }
  onCleanup(() => {
    lifecycle.active = false
  })
  createEffect(
    on(source, () => {
      setSelected(new Set<string>())
      setNotice(undefined)
    }),
  )
  // Filters do not change project totals.
  const statsSource = createMemo(
    () => ({ url: source().url, directory: source().directory, authorization: source().authorization }),
    undefined,
    {
      equals: (a, b) => a.url === b.url && a.directory === b.directory && a.authorization === b.authorization,
    },
  )
  const [stats, { refetch: refetchStats }] = createResource(statsSource, async (snapshot) => {
    if (!snapshot.directory) return undefined
    const query = new URLSearchParams({ directory: snapshot.directory })
    const res = await fetch(`${snapshot.url}/media/stats?${query}`, {
      headers: snapshot.authorization ? { Authorization: snapshot.authorization } : {},
    })
    if (!res.ok) throw new Error(`media stats ${res.status}`)
    return { source: snapshot, data: await readMediaResponse<MediaStats>(res, "stats") }
  })

  // 生成发生在会话页；从会话跳回本页会重新挂载并刷新，但停留在本页时
  // 依赖窗口重新聚焦做一次静默刷新，让新产物自动出现。
  createEffect(
    on(kind, () => {
      const handler = () => {
        void library.refetch()
        if (!stats.loading) void refetchStats()
      }
      window.addEventListener("focus", handler)
      onCleanup(() => window.removeEventListener("focus", handler))
    }),
  )

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
    const snapshot = source()
    const failed: string[] = []
    for (const id of ids) {
      const query = new URLSearchParams({ directory: snapshot.directory, id })
      const res = await fetch(`${snapshot.url}/media/asset?${query}`, {
        method: "DELETE",
        headers: snapshot.authorization ? { Authorization: snapshot.authorization } : {},
      }).catch(() => undefined)
      if (!res?.ok) failed.push(id)
    }
    if (!lifecycle.active || snapshot !== source()) return
    await Promise.allSettled([library.refetch(true), refetchStats()])
    setSelected(new Set(failed))
    if (failed.length) setNotice(t("media.load.error"))
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
        <Show when={!stats.error}>
          <Show when={stats()?.source === statsSource() ? stats()?.data : undefined}>
            {(value) => (
              <div class="flex items-center gap-2 text-12-regular text-text-weak">
                <span>{t("media.stats.assets", { count: String(value().count) })}</span>
                <span>{t("media.stats.cost", { cost: `$${value().cost_usd_estimate.toFixed(3)}` })}</span>
              </div>
            )}
          </Show>
        </Show>
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
            void sendToSession(text).catch((error) => setNotice(error instanceof Error ? error.message : String(error)))
          }}
        />
      </Show>

      <Show when={notice()}>
        {(message) => <div class="border-b border-red-base px-4 py-2 text-13-regular text-red-base">{message()}</div>}
      </Show>

      <div class="flex-1 min-h-0 overflow-y-auto p-4">
        <Show when={library.error() && items().length > 0}>
          <div class="py-2 text-13-regular text-text-weak" role="status">
            {t("media.load.error")}
          </div>
        </Show>
        <Show
          when={!library.error() || items().length > 0}
          fallback={<div class="flex min-h-40 items-center justify-center text-text-weak">{t("media.load.error")}</div>}
        >
          <Show
            when={items().length > 0}
            fallback={
              <Show
                when={!library.loading()}
                fallback={
                  <div
                    aria-busy="true"
                    aria-label={t("common.loading")}
                    class="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6"
                  >
                    <For each={[0, 1, 2, 3, 4, 5]}>
                      {() => <div class="h-48 rounded-xl bg-background-stronger animate-pulse" />}
                    </For>
                  </div>
                }
              >
                <div class="flex min-h-40 items-center justify-center text-text-weak">{t("media.empty")}</div>
              </Show>
            }
          >
            <div class="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
              <For each={items()}>
                {(asset) => (
                  <div
                    class="group relative overflow-hidden rounded-xl border text-left transition-shadow hover:shadow-md"
                    classList={{
                      "border-text-strong ring-2 ring-text-strong/40": selected().has(asset.id),
                      "border-border-weak-base": !selected().has(asset.id),
                    }}
                    title={asset.prompt ?? asset.path}
                  >
                    <div
                      class="relative flex h-36 cursor-pointer items-center justify-center overflow-hidden bg-background-stronger"
                      onClick={() => toggle(asset.id)}
                    >
                      <Show
                        when={asset.kind === "video"}
                        fallback={
                          <img
                            src={contentUrl(asset.id, "thumbnail")}
                            alt={asset.path}
                            loading="lazy"
                            decoding="async"
                            onError={(event) => {
                              if (event.currentTarget.src === contentUrl(asset.id)) return
                              event.currentTarget.src = contentUrl(asset.id)
                            }}
                            class="size-full object-cover"
                          />
                        }
                      >
                        <video
                          src={contentUrl(asset.id)}
                          poster={contentUrl(asset.id, "thumbnail")}
                          preload="none"
                          controls
                          class="size-full object-contain"
                          onClick={(event) => event.stopPropagation()}
                        />
                      </Show>
                      <button
                        type="button"
                        class="absolute left-2 top-2 flex size-6 items-center justify-center rounded-full border border-white/60 bg-black/50 text-12-medium text-white"
                        aria-pressed={selected().has(asset.id)}
                        aria-label={asset.path}
                        onClick={(event) => {
                          event.stopPropagation()
                          toggle(asset.id)
                        }}
                      >
                        {selected().has(asset.id) ? "✓" : "＋"}
                      </button>
                    </div>
                    <div class="flex flex-col gap-0.5 px-2.5 py-2">
                      <span class="truncate text-12-medium text-text-strong">{asset.path.split("/").pop()}</span>
                      <span class="truncate text-11-regular text-text-weak">
                        {asset.model ?? asset.source} · {formatBytes(asset.bytes)}
                        <Show when={asset.duration_ms}> · {formatDuration(asset.duration_ms!)}</Show>
                      </span>
                    </div>
                  </div>
                )}
              </For>
            </div>
            <Show when={next()}>
              <div class="flex justify-center py-6">
                <button
                  type="button"
                  class="rounded-lg border border-border-weak-base px-4 py-2 text-13-regular text-text-base hover:bg-background-stronger"
                  disabled={library.more() || library.loading()}
                  onClick={() => void library.loadMore()}
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
                <select
                  class={selectClass}
                  value={duration()}
                  onChange={(e) => setDuration(Number(e.currentTarget.value))}
                >
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
            {(cost) => (
              <span class="text-13-regular text-text-weak">
                {t("media.generate.estimate", { cost: `$${cost().toFixed(3)}` })}
              </span>
            )}
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
