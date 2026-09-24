import { createEffect, createMemo, createResource, onCleanup, type Accessor } from "solid-js"
import type { MediaSource } from "./media-library"
import { readMediaResponse } from "./media-response"

export type MediaTaskKind = "image" | "video" | "process"
export type MediaTaskStatus = "running" | "completed" | "error" | "cancelled"

export type MediaTask = {
  id: string
  kind: MediaTaskKind
  status: MediaTaskStatus
  title?: string
  progress: number | null
  provider_job_id?: string
  asset_id?: string
  started_at: number
  completed_at?: number
  error?: string
  metadata?: Record<string, unknown>
}

type Loaded = { source: MediaSource; items: MediaTask[] }

/** 有任务在跑时快轮询追进度；空闲时慢轮询兜住别处（如会话页）发起的生成 */
const ACTIVE_INTERVAL_MS = 3000
const IDLE_INTERVAL_MS = 12000
/** 终态任务保留 90s，给用户看到「完成/失败」的反馈 */
const FINISHED_TTL_MS = 90_000

const readTasks = async (response: Response) => readMediaResponse<{ items: MediaTask[] }>(response, "tasks")

export function createMediaTasks(input: Accessor<MediaSource>) {
  const source = createMemo(input, undefined, {
    equals: (a, b) => a.url === b.url && a.directory === b.directory && a.authorization === b.authorization,
  })
  const [tasks, { refetch }] = createResource<Loaded, MediaSource>(source, async (snapshot) => {
    if (!snapshot.directory) return { source: snapshot, items: [] }
    const query = new URLSearchParams({ directory: snapshot.directory })
    const response = await fetch(`${snapshot.url}/media/tasks?${query}`, {
      headers: snapshot.authorization ? { Authorization: snapshot.authorization } : {},
    })
    if (!response.ok) throw new Error(`media tasks ${response.status}`)
    const body = await readTasks(response)
    return { source: snapshot, items: body.items }
  })

  const page = createMemo(() => {
    const value = tasks.latest
    return value?.source === source() ? value.items : []
  })
  // 运行中的排前面，终态只短暂保留，避免长期堆积历史任务
  const visible = createMemo(() => {
    const now = Date.now()
    const active = page().filter((task) => task.status === "running")
    const finished = page()
      .filter((task) => task.status !== "running" && now - (task.completed_at ?? task.started_at) < FINISHED_TTL_MS)
      .toSorted((a, b) => (b.completed_at ?? 0) - (a.completed_at ?? 0))
      .slice(0, 3)
    return [...active, ...finished]
  })
  const running = createMemo(() => page().some((task) => task.status === "running"))

  let timer: ReturnType<typeof setInterval> | undefined
  const schedule = () => {
    if (timer) clearInterval(timer)
    timer = setInterval(() => void refetch(), running() ? ACTIVE_INTERVAL_MS : IDLE_INTERVAL_MS)
  }
  createEffect(() => {
    // 依赖 running()：轮询节奏随是否有活跃任务切换
    void running()
    schedule()
  })
  onCleanup(() => {
    if (timer) clearInterval(timer)
  })

  const cancel = async (id: string) => {
    const snapshot = source()
    const query = new URLSearchParams({ directory: snapshot.directory, id })
    await fetch(`${snapshot.url}/media/task?${query}`, {
      method: "DELETE",
      headers: snapshot.authorization ? { Authorization: snapshot.authorization } : {},
    })
    await refetch()
  }

  return { tasks: visible, running, refetch, cancel }
}
