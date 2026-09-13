import type { FilePart } from "@opencode-ai/sdk/v2"
import { createSignal, Show } from "solid-js"
import { useI18n } from "@opencode-ai/ui/context/i18n"
import { useMediaStudio } from "../context/media-studio"
import "./media-video.css"

// 工具附件 url 形如 /media/<assetID>/content（见 packages/opencode/src/tool/media.ts contentUrl）
const ASSET_URL = /^\/media\/([^/]+)\/content$/

/** 最小选段长度（秒），避免两个手柄重叠 */
const MIN_RANGE = 0.1

function formatTime(value: number) {
  const minutes = Math.floor(value / 60)
  const seconds = value - minutes * 60
  return `${minutes}:${seconds.toFixed(1).padStart(4, "0")}`
}

export function MediaVideo(props: { file: FilePart; title: string }) {
  const i18n = useI18n()
  const studio = useMediaStudio()

  const assetID = () => ASSET_URL.exec(props.file.url)?.[1]
  const src = () => {
    const id = assetID()
    if (id && studio.contentUrl) return studio.contentUrl(id)
    return props.file.url
  }
  // 只有媒体库资产 + app 侧提供了重生成入口时才展示选段面板
  const actionable = () => !!assetID() && !!studio.regenerate

  const [open, setOpen] = createSignal(false)
  const [duration, setDuration] = createSignal(0)
  const [start, setStart] = createSignal(0)
  const [end, setEnd] = createSignal(0)
  const [prompt, setPrompt] = createSignal("")
  const [busy, setBusy] = createSignal(false)
  const [failed, setFailed] = createSignal(false)

  let video: HTMLVideoElement | undefined
  let track: HTMLDivElement | undefined

  const onMetadata = () => {
    const value = video?.duration
    if (!value || !Number.isFinite(value)) return
    setDuration(value)
    setEnd((current) => (current === 0 || current > value ? value : current))
  }

  const pct = (value: number) => (duration() > 0 ? (value / duration()) * 100 : 0)

  const seek = (event: PointerEvent) => {
    if (!track || duration() <= 0) return 0
    const rect = track.getBoundingClientRect()
    const ratio = Math.min(Math.max((event.clientX - rect.left) / rect.width, 0), 1)
    return ratio * duration()
  }

  const drag = (which: "start" | "end") => (event: PointerEvent) => {
    event.preventDefault()
    const move = (ev: PointerEvent) => {
      const time = seek(ev)
      if (which === "start") setStart(Math.min(time, end() - MIN_RANGE))
      else setEnd(Math.max(time, start() + MIN_RANGE))
    }
    move(event)
    const up = () => {
      window.removeEventListener("pointermove", move)
      window.removeEventListener("pointerup", up)
    }
    window.addEventListener("pointermove", move)
    window.addEventListener("pointerup", up)
  }

  const trackDown = (event: PointerEvent) => {
    const time = seek(event)
    const which = Math.abs(time - start()) <= Math.abs(time - end()) ? "start" : "end"
    drag(which)(event)
  }

  const preview = () => {
    if (!video) return
    video.currentTime = start()
    void video.play()
  }

  const onTimeUpdate = () => {
    if (!open() || !video || !video.paused) return
    if (video.currentTime >= end()) video.pause()
  }

  const submit = async () => {
    const id = assetID()
    if (!id || !studio.regenerate) return
    setBusy(true)
    setFailed(false)
    try {
      const asset = studio.resolveAsset ? await studio.resolveAsset(id) : undefined
      if (!asset) {
        setFailed(true)
        return
      }
      studio.regenerate({ assetID: id, path: asset.path, start: start(), end: end(), prompt: prompt().trim() })
      setPrompt("")
      setOpen(false)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div data-component="media-video">
      <video
        ref={video}
        data-slot="tool-media-video"
        src={src()}
        title={props.title}
        controls
        preload="metadata"
        onLoadedMetadata={onMetadata}
        onTimeUpdate={onTimeUpdate}
      />
      <Show when={actionable()}>
        <Show
          when={open()}
          fallback={
            <button type="button" data-slot="media-video-toggle" onClick={() => setOpen(true)}>
              {i18n.t("ui.media.regenerate.open")}
            </button>
          }
        >
          <div data-slot="media-video-panel">
            <div
              ref={track}
              data-slot="media-video-track"
              onPointerDown={trackDown}
              role="slider"
              aria-label={i18n.t("ui.media.regenerate.open")}
              aria-valuemin={0}
              aria-valuemax={duration()}
              aria-valuenow={start()}
            >
              <div
                data-slot="media-video-selection"
                style={{ left: `${pct(start())}%`, width: `${Math.max(pct(end()) - pct(start()), 0)}%` }}
              />
              <div data-slot="media-video-handle" style={{ left: `${pct(start())}%` }} onPointerDown={drag("start")} />
              <div data-slot="media-video-handle" style={{ left: `${pct(end())}%` }} onPointerDown={drag("end")} />
            </div>
            <div data-slot="media-video-times">
              <span>{formatTime(start())}</span>
              <span>
                {i18n.t("ui.media.regenerate.duration", { duration: (end() - start()).toFixed(1) })}
              </span>
              <span>{formatTime(end())}</span>
            </div>
            <textarea
              data-slot="media-video-prompt"
              rows={2}
              value={prompt()}
              placeholder={i18n.t("ui.media.regenerate.placeholder")}
              onInput={(event) => setPrompt(event.currentTarget.value)}
            />
            <div data-slot="media-video-actions">
              <button type="button" onClick={preview}>
                {i18n.t("ui.media.regenerate.preview")}
              </button>
              <span data-slot="media-video-spacer" />
              <button type="button" onClick={() => setOpen(false)}>
                {i18n.t("ui.media.regenerate.cancel")}
              </button>
              <button type="button" data-slot="media-video-submit" disabled={busy()} onClick={() => void submit()}>
                {i18n.t("ui.media.regenerate.submit")}
              </button>
            </div>
            <Show when={failed()}>
              <div data-slot="media-video-error">{i18n.t("ui.media.regenerate.error")}</div>
            </Show>
          </div>
        </Show>
      </Show>
    </div>
  )
}
