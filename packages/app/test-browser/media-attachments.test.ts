import { expect, test } from "bun:test"
import { createServer } from "node:http"
import { buffer } from "node:stream/consumers"
import { createRoot } from "solid-js"
import { createPromptState } from "../src/context/prompt-state"
import { attachMediaAssets, encodeMediaAttachment } from "../src/components/prompt-input/media-attachments"
import { buildRequestParts } from "../src/components/prompt-input/build-request-parts"
import { extractPromptFromParts } from "../src/utils/prompt"
import { createDraftStore, createLegacyBlobReference } from "../src/utils/draft-store"
import { uploadMediaFile } from "../src/utils/media-upload"
import type { MediaAsset } from "../src/utils/media-library"

const asset = (kind: "image" | "video"): MediaAsset => ({
  id: `med_${kind}`,
  path: `.opencode/media/2026-09/${kind}.${kind === "image" ? "png" : "mp4"}`,
  kind,
  mime: kind === "image" ? "image/png" : "video/mp4",
  bytes: 3,
  width: null,
  height: null,
  duration_ms: null,
  source: "upload",
  model: null,
  prompt: null,
  cost_usd_estimate: null,
  time_created: 1,
  params: { filename: kind === "image" ? "photo.png" : "clip.mp4" },
})

async function setup() {
  const requests: { method?: string; url?: string; authorization?: string; body: string }[] = []
  const behavior = { fail: false }
  const server = createServer(async (request, response) => {
    response.setHeader("Access-Control-Allow-Origin", "*")
    response.setHeader("Access-Control-Allow-Headers", "Authorization,Content-Type")
    response.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
    if (request.method === "OPTIONS") return response.writeHead(204).end()
    const body = await buffer(request)
    requests.push({
      method: request.method,
      url: request.url,
      authorization: request.headers.authorization,
      body: body.toString(),
    })
    if (behavior.fail)
      return response
        .writeHead(400, { "Content-Type": "application/json" })
        .end(JSON.stringify({ message: "Invalid media" }))
    if (request.method === "GET") return response.writeHead(200, { "Content-Type": "image/png" }).end("png")
    response
      .writeHead(200, { "Content-Type": "application/json" })
      .end(JSON.stringify({ asset: asset(body.includes("clip.mp4") ? "video" : "image") }))
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Expected TCP server")
  return {
    requests,
    behavior,
    source: { url: `http://127.0.0.1:${address.port}`, directory: "/project", authorization: "Basic test" },
    [Symbol.dispose]() {
      server.closeAllConnections()
      server.close()
    },
  }
}

test("uploads multipart files with credentials and keeps failed uploads out of the draft", async () => {
  using api = await setup()
  const progress: number[] = []
  const uploaded = await uploadMediaFile({
    source: api.source,
    file: new File(["png"], "photo.png", { type: "image/png" }),
    onProgress: (value) => progress.push(value),
  }).promise
  expect(uploaded.id).toBe("med_image")
  expect(api.requests[0]).toMatchObject({ method: "POST", authorization: "Basic test" })
  expect(api.requests[0]?.body).toContain('filename="photo.png"')
  expect(api.requests[0]?.url).toContain("directory=%2Fproject")
  expect(progress[0]).toBe(0)
  api.behavior.fail = true
  await expect(
    uploadMediaFile({
      source: api.source,
      file: new File(["bad"], "bad.png", { type: "image/png" }),
      onProgress: () => {},
    }).promise,
  ).rejects.toThrow("Invalid media")
})

test("selected images and videos preserve the captured draft and serialize media bytes", async () => {
  using api = await setup()
  await createRoot(async (dispose) => {
    const first = createPromptState({ prompt: "Edit these" })
    const second = createPromptState({ prompt: "Another session" })
    const target = first.capture()
    await attachMediaAssets({ assets: [asset("image"), asset("video")], source: api.source, target })
    await attachMediaAssets({ assets: [asset("video")], source: api.source, target })
    const images = first.current().filter((part) => part.type === "image")
    expect(images).toHaveLength(2)
    expect(second.current()).toHaveLength(1)
    expect(api.requests).toHaveLength(2)
    // Happy DOM cannot fetch blob: URLs; use supported data: representations for the bytes.
    const encoded = await Promise.all(
      images.map((image) =>
        encodeMediaAttachment(
          image.mime.startsWith("image/") || image.mime.startsWith("video/")
            ? { ...image, blob: createLegacyBlobReference("data:image/png;base64,cG5n") }
            : image,
        ),
      ),
    )
    expect(encoded[0]?.uri).toStartWith("data:image/png;base64,")
    expect(encoded[1]?.uri).toStartWith("data:video/mp4;base64,")
    expect(encoded[1]).toMatchObject({ asset_id: "med_video", path: asset("video").path, mime: "video/mp4" })
    const parts = buildRequestParts({
      prompt: first.current(),
      images: images.map((image, index) => ({ ...image, dataUrl: encoded[index]!.uri })),
      context: [],
      text: "Edit these",
      sessionID: "ses_media",
      messageID: "msg_media",
      sessionDirectory: "/project",
    })
    expect(parts.requestParts.filter((part) => part.type === "file")).toHaveLength(2)
    expect(
      parts.requestParts.some(
        (part) => part.type === "text" && part.text.includes("med_video") && part.text.includes(asset("video").path),
      ),
    ).toBe(true)
    const restored = extractPromptFromParts(parts.optimisticParts, { directory: "/project" })
    expect(restored.filter((part) => part.type === "image").map((part) => part.media?.asset_id)).toEqual([
      "med_image",
      "med_video",
    ])
    expect(restored[0]).toMatchObject({ type: "text", content: "Edit these" })
    api.behavior.fail = true
    await expect(
      attachMediaAssets({ assets: [{ ...asset("image"), id: "missing" }], source: api.source, target }),
    ).rejects.toThrow("Media content unavailable")
    expect(first.current()).toHaveLength(3)
    dispose()
  })
})

test("media asset IDs and paths survive persisted draft storage", async () => {
  const documents = new Map<string, string>()
  const blobs = new Map<string, Blob>()
  const storage = createDraftStore({
    get: async (key) => documents.get(key) ?? null,
    set: async (key, value) => {
      documents.set(key, value)
    },
    remove: async (key) => {
      documents.delete(key)
    },
    putBlob: async (blob) => {
      const id = String(blobs.size)
      blobs.set(id, blob)
      return id
    },
    getBlob: async (id) => blobs.get(id) ?? null,
  })
  using api = await setup()
  await createRoot(async (dispose) => {
    const prompt = createPromptState()
    await attachMediaAssets({
      assets: [asset("video")],
      source: api.source,
      target: prompt.capture(),
      store: storage,
    })
    await storage.setItem("draft", JSON.stringify(prompt.current()))
    const restored = JSON.parse((await storage.getItem("draft"))!)
    expect(restored[1].media).toEqual({ asset_id: "med_video", path: asset("video").path, directory: "/project" })
    expect(restored[1].blob.url).toStartWith("blob:")
    dispose()
  })
})
