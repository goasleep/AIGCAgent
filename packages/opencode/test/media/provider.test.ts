import { describe, expect, test } from "bun:test"
import { Cause, Effect } from "effect"
import { createServer } from "node:http"
import { MediaProviderError, providerBaseURL, resolveProvider } from "@/media/provider"

describe("resolveProvider", () => {
  test("treats empty base URLs as defaults and trims compatible URLs", () => {
    expect(providerBaseURL("", "https://api.example/v1")).toBe("https://api.example/v1")
    expect(providerBaseURL("   ", "https://api.example/v1")).toBe("https://api.example/v1")
    expect(providerBaseURL(" https://api.example/v1/// ", "unused")).toBe("https://api.example/v1")
  })

  test("resolves provider aliases according to the requested media kind", async () => {
    expect((await Effect.runPromise(resolveProvider("agnes", {}, "image"))).id).toBe("agnes-image-2.1-flash")
    expect((await Effect.runPromise(resolveProvider("agnes", {}, "video"))).id).toBe("agnes-video-v2.0")
    expect((await Effect.runPromise(resolveProvider("h3"))).id).toBe("MiniMax-H3")
  })

  test("rejects a video-only Agnes model before making an image request", async () => {
    const provider = await Effect.runPromise(resolveProvider("agnes-video"))
    const result = await Effect.runPromiseExit(provider.submitImage({ prompt: "cat", size: "auto", quality: "medium" }))
    if (result._tag !== "Failure") throw new Error("expected wrong media kind")
    expect(String(Cause.squash(result.cause))).toContain("不支持图片生成")
  })

  test("does not silently discard unsupported video reference frames", async () => {
    const provider = await Effect.runPromise(resolveProvider("agnes-video", { agnes: { apiKey: "test-media-key" } }))
    const result = await Effect.runPromiseExit(
      provider.submitVideo({
        prompt: "cat",
        duration: 4,
        ratio: "16:9",
        first_frame: "data:image/png;base64,aW1hZ2U=",
      }),
    )
    if (result._tag !== "Failure") throw new Error("expected unsupported reference frame")
    expect(String(Cause.squash(result.cause))).toContain("参考帧")
  })
  test("defaults to openai when model is unset", async () => {
    const provider = await Effect.runPromise(resolveProvider(undefined))
    expect(provider.id).toBe("gpt-image-2")
  })

  test("uses Agnes when its configured key is available", async () => {
    const provider = await Effect.runPromise(resolveProvider(undefined, { agnes: { apiKey: "test-key" } }))
    expect(provider.id).toBe("agnes-image-2.1-flash")
  })

  test("keeps explicit GPT Image 2 selection even when only Agnes is configured", async () => {
    const provider = await Effect.runPromise(resolveProvider("gpt-image-2", { agnes: { apiKey: "test-key" } }))
    expect(provider.id).toBe("gpt-image-2")
    const exit = await Effect.runPromiseExit(
      provider.submitImage({ prompt: "cat", size: "1024x1024", quality: "medium" }),
    )
    if (exit._tag !== "Failure") throw new Error("expected missing OpenAI media key")
    expect(Cause.squash(exit.cause)).toBeInstanceOf(MediaProviderError)
    expect(String(Cause.squash(exit.cause))).toContain("media.openai_api_key")
  })

  test("does not use the inference environment key for OpenAI image generation", async () => {
    const provider = await Effect.runPromise(resolveProvider("gpt-image-2"))
    const exit = await Effect.runPromiseExit(
      provider.submitImage({ prompt: "cat", size: "1024x1024", quality: "medium" }),
    )
    if (exit._tag !== "Failure") throw new Error("expected missing dedicated media key")
    const error = Cause.squash(exit.cause)
    expect(error).toBeInstanceOf(MediaProviderError)
    expect((error as InstanceType<typeof MediaProviderError>).detail).toContain("media.openai_api_key")
  })

  test("uses a configured OpenAI-compatible base URL", async () => {
    const server = createServer((request, response) => {
      expect(request.url).toBe("/compatible/v1/images/generations")
      expect(request.headers.authorization).toBe("Bearer test-media-key")
      response
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ data: [{ b64_json: "aW1hZ2U=" }] }))
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("test server did not bind")
    const provider = await Effect.runPromise(
      resolveProvider("gpt-image-2", {
        openai: { apiKey: "test-media-key", baseUrl: `http://127.0.0.1:${address.port}/compatible/v1` },
      }),
    )
    try {
      expect(
        await Effect.runPromise(provider.submitImage({ prompt: "cat", size: "1024x1024", quality: "medium" })),
      ).toEqual({
        jobId: "inline:aW1hZ2U=",
      })
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
    }
  })

  test("uses the OpenAI image edits endpoint for source images", async () => {
    const server = createServer(async (request, response) => {
      expect(request.url).toBe("/v1/images/edits")
      expect(request.headers["content-type"]).toMatch(/^multipart\/form-data; boundary=/)
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      const body = Buffer.concat(chunks).toString()
      expect(body).toContain('name="image"')
      expect(body).toContain('name="prompt"')
      response
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ data: [{ b64_json: "ZWRpdA==" }] }))
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("test server did not bind")
    const provider = await Effect.runPromise(
      resolveProvider("gpt-image-2", {
        openai: { apiKey: "test-media-key", baseUrl: `http://127.0.0.1:${address.port}/v1` },
      }),
    )
    try {
      expect(
        await Effect.runPromise(
          provider.submitImage({
            prompt: "edit cat",
            image: "data:image/png;base64,aW1hZ2U=",
            size: "1024x1024",
            quality: "medium",
          }),
        ),
      ).toEqual({ jobId: "inline:ZWRpdA==" })
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
    }
  })

  test("routes Agnes image models and preserves inline image responses", async () => {
    const server = createServer((request, response) => {
      if (request.url !== "/images/generations") {
        response.writeHead(404).end()
        return
      }
      response
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ data: [{ url: "https://example.com/cat.png" }] }))
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("test server did not bind")
    const provider = await Effect.runPromise(
      resolveProvider("agnes-image-2.5-flash", {
        agnes: { apiKey: "test-key", baseUrl: `http://127.0.0.1:${address.port}` },
      }),
    )
    expect(provider.id).toBe("agnes-image-2.5-flash")
    try {
      const { jobId } = await Effect.runPromise(
        provider.submitImage({ prompt: "cat", size: "1024x1536", quality: "medium" }),
      )
      expect(jobId).toBe("https://example.com/cat.png")
      expect(await Effect.runPromise(provider.poll(jobId))).toEqual({
        state: "succeeded",
        url: "https://example.com/cat.png",
      })
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
    }
  })

  test("normalizes unavailable Agnes image 2.0 aliases", async () => {
    const provider = await Effect.runPromise(
      resolveProvider("agnes-image-2.0-flash", { agnes: { apiKey: "test-key" } }),
    )
    expect(provider.id).toBe("agnes-image-2.1-flash")
  })

  test("routes Agnes video models through create and video_id polling", async () => {
    const server = createServer((request, response) => {
      if (request.url === "/v1/videos") {
        response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ video_id: "video_test" }))
        return
      }
      if (request.url?.startsWith("/agnesapi?")) {
        response
          .writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify({ status: "completed", progress: 100, url: "https://example.com/cat.mp4" }))
        return
      }
      response.writeHead(404).end()
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("test server did not bind")
    const provider = await Effect.runPromise(
      resolveProvider("agnes-video-2.5-flash", {
        agnes: { apiKey: "test-key", baseUrl: `http://127.0.0.1:${address.port}/v1` },
      }),
    )
    try {
      expect(provider.id).toBe("agnes-video-v2.0")
      const { jobId } = await Effect.runPromise(provider.submitVideo({ prompt: "cat", duration: 4, ratio: "9:16" }))
      expect(jobId).toBe("video_test")
      expect(await Effect.runPromise(provider.poll(jobId))).toEqual({
        state: "succeeded",
        url: "https://example.com/cat.mp4",
      })
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
    }
  })

  test("falls back from a default Seedance video model to Agnes media credentials", async () => {
    const provider = await Effect.runPromise(resolveProvider("seedance-2-0", { agnes: { apiKey: "test-key" } }))
    expect(provider.id).toBe("agnes-video-v2.0")
  })

  test("routes the generic Agnes alias to the video provider", async () => {
    const provider = await Effect.runPromise(resolveProvider("agnes", { agnes: { apiKey: "test-key" } }, "video"))
    expect(provider.id).toBe("agnes-video-v2.0")
  })

  test("routes seedance models to ark with the configured model name", async () => {
    const provider = await Effect.runPromise(resolveProvider("seedance-1-0-pro"))
    expect(provider.id).toBe("seedance-1-0-pro")
  })

  test("routes wan models to dashscope", async () => {
    expect((await Effect.runPromise(resolveProvider("wan3.0-video"))).id).toBe("wan3.0-video")
    expect((await Effect.runPromise(resolveProvider("wan3.0-video-prime"))).id).toBe("wan3.0-video-prime")
    expect((await Effect.runPromise(resolveProvider("wan2.2-t2v-plus"))).id).toBe("wan2.2-t2v-plus")
  })

  test("routes minimax/hailuo models to minimax", async () => {
    expect((await Effect.runPromise(resolveProvider("MiniMax-H3"))).id).toBe("MiniMax-H3")
    expect((await Effect.runPromise(resolveProvider("hailuo-03"))).id).toBe("hailuo-03")
  })

  test("fails with a clear error for unknown models", async () => {
    const exit = await Effect.runPromiseExit(resolveProvider("some-unknown-model"))
    if (exit._tag !== "Failure") throw new Error("expected Failure")
    const error = Cause.squash(exit.cause)
    expect(error).toBeInstanceOf(MediaProviderError)
    expect((error as InstanceType<typeof MediaProviderError>).detail).toContain("some-unknown-model")
  })
})
