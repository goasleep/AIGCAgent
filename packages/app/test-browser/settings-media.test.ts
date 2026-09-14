import { describe, expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { createServer } from "node:http"
import { json } from "node:stream/consumers"
import { createOpencodeClient } from "@opencode-ai/sdk/v2/client"
import type { Config } from "@opencode-ai/sdk/v2/client"
import { createMediaSettingsController, type MediaSettings } from "../src/components/settings-media-state"

async function setup(initial: Partial<MediaSettings> = {}) {
  const stored = { media: { ...initial } }
  const requests: Partial<MediaSettings>[] = []
  const behavior = { readStatus: 200, writeStatus: 200, ignoreWrites: false, reads: 0 }
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, PATCH, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  }
  const server = createServer(async (request, response) => {
    if (request.url !== "/global/config") {
      response.writeHead(404).end()
      return
    }
    if (request.method === "OPTIONS") {
      response.writeHead(204, headers).end()
      return
    }
    if (request.method === "GET") {
      behavior.reads++
      response
        .writeHead(behavior.readStatus, { ...headers, "Content-Type": "application/json" })
        .end(JSON.stringify(stored))
      return
    }
    const body: { media: Partial<MediaSettings> } = await json(request)
    requests.push(body.media)
    if (behavior.writeStatus >= 400) {
      response.writeHead(behavior.writeStatus, { ...headers, "Content-Type": "application/json" }).end("{}")
      return
    }
    if (!behavior.ignoreWrites) Object.assign(stored.media, body.media)
    response.writeHead(200, { ...headers, "Content-Type": "application/json" }).end(JSON.stringify(stored))
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Expected a TCP test server")
  const sdk = createOpencodeClient({ baseUrl: `http://127.0.0.1:${address.port}` })
  const disposals: (() => void)[] = []
  const open = () =>
    createRoot((dispose) => {
      disposals.push(dispose)
      const controller = createMediaSettingsController({
        read: () => sdk.global.config.get({ throwOnError: true }).then((response) => response.data),
        write: (media) => {
          const config: Config & { media: Partial<MediaSettings> } = { media }
          return sdk.global.config.update({ config }, { throwOnError: true })
        },
      })
      return { controller, dispose }
    })
  return {
    stored,
    requests,
    behavior,
    open,
    [Symbol.dispose]() {
      disposals.forEach((dispose) => dispose())
      server.closeAllConnections()
      server.close()
    },
  }
}

describe("media settings persistence", () => {
  test("saves the OpenAI media key and model independently and restores configured status", async () => {
    using api = await setup({ agnes_api_key: "existing-agnes-key", image_model: "agnes-image-2.5-flash" })
    const first = api.open()
    await first.controller.load()
    first.controller.change("openai_api_key", "  test-openai-media-key  ")
    first.controller.change("openai_base_url", "https://image-proxy.example/v1")
    first.controller.change("image_model", "gpt-image-2")
    expect(await first.controller.save()).toBe(true)
    expect(api.requests).toEqual([
      {
        openai_api_key: "test-openai-media-key",
        openai_base_url: "https://image-proxy.example/v1",
        image_model: "gpt-image-2",
      },
    ])
    expect(api.stored.media.agnes_api_key).toBe("existing-agnes-key")
    first.dispose()

    const second = api.open()
    await second.controller.load()
    expect(second.controller.configured("openai_api_key")).toBe(true)
    expect(second.controller.state.form.openai_api_key).toBe("")
    expect(second.controller.state.form.image_model).toBe("gpt-image-2")
    expect(second.controller.state.form.openai_base_url).toBe("https://image-proxy.example/v1")
    expect(second.controller.canSave()).toBe(false)
  })

  test("reads the saved key again after the form is closed and reopened", async () => {
    using api = await setup()
    const first = api.open()
    await first.controller.load()
    expect(first.controller.configured("agnes_api_key")).toBe(false)
    first.controller.change("agnes_api_key", "test-agnes-key")
    expect(await first.controller.save()).toBe(true)
    expect(first.controller.state.form.agnes_api_key).toBe("")
    expect(first.controller.configured("agnes_api_key")).toBe(true)
    first.dispose()

    const second = api.open()
    expect(second.controller.state.ready).toBe(false)
    await second.controller.load()
    expect(second.controller.configured("agnes_api_key")).toBe(true)
    expect(second.controller.state.form.agnes_api_key).toBe("")
    expect(second.controller.canSave()).toBe(false)
    expect(api.behavior.reads).toBe(3)
  })

  test("saves only edits and keeps previously configured keys when drafts are blank", async () => {
    using api = await setup({ agnes_api_key: "existing-key", ark_api_key: "ark-key" })
    const { controller } = api.open()
    await controller.load()
    controller.change("agnes_base_url", "https://example.com/v1")
    controller.change("ark_api_key", "   ")
    expect(await controller.save()).toBe(true)
    expect(api.requests).toEqual([{ agnes_base_url: "https://example.com/v1" }])
    expect(api.stored.media.agnes_api_key).toBe("existing-key")
    expect(api.stored.media.ark_api_key).toBe("ark-key")
    expect(controller.configured("agnes_api_key")).toBe(true)
  })

  test("keeps the draft and reports a verification error when an older server ignores a key", async () => {
    using api = await setup()
    api.behavior.ignoreWrites = true
    const { controller } = api.open()
    await controller.load()
    controller.change("agnes_api_key", "test-new-key")
    expect(await controller.save()).toBe(false)
    expect(controller.state.error).toBe("verify")
    expect(controller.state.success).toBe(false)
    expect(controller.configured("agnes_api_key")).toBe(false)
    expect(controller.state.form.agnes_api_key).toBe("test-new-key")
    expect(controller.canSave()).toBe(true)
  })

  test("confirms key replacement only after a successful readback", async () => {
    using api = await setup({ minimax_api_key: "old-key" })
    const { controller } = api.open()
    await controller.load()
    controller.change("minimax_api_key", "  replacement-key  ")
    expect(await controller.save()).toBe(true)
    expect(api.requests).toEqual([{ minimax_api_key: "replacement-key" }])
    expect(controller.state.form.minimax_api_key).toBe("")
    expect(controller.state.saved.minimax_api_key).toBe("replacement-key")
  })

  test("shows a load failure without treating it as an unconfigured form, and supports retry", async () => {
    using api = await setup({ agnes_api_key: "existing-key" })
    api.behavior.readStatus = 503
    const { controller } = api.open()
    await controller.load()
    expect(controller.state.error).toBe("load")
    expect(controller.state.ready).toBe(false)
    controller.change("agnes_api_key", "ignored-edit")
    expect(controller.state.form.agnes_api_key).toBe("")
    expect(await controller.save()).toBe(false)
    expect(api.requests).toEqual([])

    api.behavior.readStatus = 200
    await controller.load()
    expect(controller.state.error).toBeUndefined()
    expect(controller.configured("agnes_api_key")).toBe(true)
  })

  test("retains edits and never reports success after a rejected save", async () => {
    using api = await setup()
    api.behavior.writeStatus = 400
    const { controller } = api.open()
    await controller.load()
    controller.change("agnes_api_key", "new-key")
    expect(await controller.save()).toBe(false)
    expect(controller.state.error).toBe("save")
    expect(controller.state.form.agnes_api_key).toBe("new-key")
    expect(controller.state.success).toBe(false)
    expect(api.behavior.reads).toBe(1)
  })

  test("does not confirm a save if reading the persisted config fails", async () => {
    using api = await setup()
    const { controller } = api.open()
    await controller.load()
    api.behavior.readStatus = 503
    controller.change("agnes_api_key", "new-key")
    expect(await controller.save()).toBe(false)
    expect(controller.state.error).toBe("verify")
    expect(controller.state.success).toBe(false)
  })

  test("prevents editing and duplicate saves while a save is pending", async () => {
    using api = await setup()
    const { controller } = api.open()
    await controller.load()
    controller.change("agnes_api_key", "new-key")
    const saving = controller.save()
    controller.change("agnes_api_key", "unsaved-other-key")
    expect(await controller.save()).toBe(false)
    expect(await saving).toBe(true)
    expect(api.requests).toEqual([{ agnes_api_key: "new-key" }])
  })
})
