import { expect, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import { createServer, type ServerResponse } from "node:http"
import { createMediaTasks, type MediaTask } from "../src/utils/media-tasks"

const runningTask = (id: string, progress: number | null = null): MediaTask => ({
  id,
  kind: "video",
  status: "running",
  title: `Generating video (${id})`,
  progress,
  started_at: Date.now() - 5_000,
})

const finishedTask = (id: string, status: MediaTask["status"], completedAt: number): MediaTask => ({
  id,
  kind: "image",
  status,
  title: `Image (${id})`,
  progress: null,
  asset_id: `med_${id}`,
  started_at: completedAt - 60_000,
  completed_at: completedAt,
})

async function setup() {
  type Request = { method: string; url: URL; response: ServerResponse }
  const pending: Request[] = []
  const waiting: ((request: Request) => void)[] = []
  const requests: { method: string; url: URL }[] = []
  const items: MediaTask[] = []
  const deleted: string[] = []
  const server = createServer((request, response) => {
    response.setHeader("Access-Control-Allow-Origin", "*")
    if (request.method === "OPTIONS") return response.writeHead(204).end()
    const url = new URL(request.url, "http://localhost")
    requests.push({ method: request.method!, url })
    if (request.method === "DELETE") {
      const id = url.searchParams.get("id") ?? ""
      deleted.push(id)
      const index = items.findIndex((task) => task.id === id)
      if (index >= 0) items[index] = { ...items[index]!, status: "cancelled", completed_at: Date.now() }
      return response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({}))
    }
    const resolve = waiting.shift()
    const pendingRequest = { method: request.method!, url, response }
    if (resolve) return resolve(pendingRequest)
    pending.push(pendingRequest)
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Expected TCP server")
  const root = createRoot((dispose) => {
    const [source, setSource] = createSignal({
      url: `http://127.0.0.1:${address.port}`,
      directory: "/proj",
    })
    return { tasks: createMediaTasks(source), source, setSource, dispose }
  })
  return {
    items,
    deleted,
    requests,
    ...root,
    next: () =>
      pending.length ? Promise.resolve(pending.shift()!) : new Promise<Request>((resolve) => waiting.push(resolve)),
    replyJson: (body: unknown) => (request: Request) =>
      request.response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(body)),
    [Symbol.dispose]() {
      root.dispose()
      server.closeAllConnections()
      server.close()
    },
  }
}

test("surfaces running tasks, briefly keeps finished ones and cancels through the API", async () => {
  using api = await setup()
  const first = await api.next()
  first.response.writeHead(200, { "Content-Type": "application/json" }).end(
    JSON.stringify({
      items: [
        runningTask("med_job1", 40),
        finishedTask("med_old", "completed", Date.now() - 10 * 60_000),
        finishedTask("med_new", "error", Date.now() - 1_000),
      ],
    }),
  )
  await new Promise((resolve) => setTimeout(resolve, 0))
  const shown = api.tasks.tasks()
  // 运行中置顶；过期终态不显示，新鲜终态短暂保留
  expect(shown.map((task) => task.id)).toEqual(["med_job1", "med_new"])
  expect(api.tasks.running()).toBe(true)
  expect(shown[0]?.progress).toBe(40)

  // DELETE 由测试服务器直接应答，不进 pending 队列；cancel 内部会等列表刷新返回
  const cancelling = api.tasks.cancel("med_job1")
  const second = await api.next()
  expect(second.url.pathname).toBe("/media/tasks")
  second.response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ items: [] }))
  await cancelling
  expect(api.deleted).toEqual(["med_job1"])
  expect(api.tasks.tasks()).toEqual([])
  expect(api.tasks.running()).toBe(false)
})
