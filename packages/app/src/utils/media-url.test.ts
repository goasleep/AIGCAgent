import { describe, expect, test } from "bun:test"
import { isServerContentURL, mediaContentURL } from "./media-url"

describe("media URLs", () => {
  test("encodes directories and credentials for native image and video requests", () => {
    const url = new URL(
      mediaContentURL({
        url: "http://localhost:4096/",
        directory: "/tmp/a b/中文%20",
        id: "med_one",
        password: "secret",
      }),
    )
    expect(url.pathname).toBe("/media/content")
    expect(url.searchParams.get("directory")).toBe("/tmp/a b/中文%20")
    expect(url.searchParams.get("auth_token")).toBe(btoa("opencode:secret"))
    expect(
      new URL(mediaContentURL({ url: "http://localhost:4096", directory: "/tmp", id: "med_one" })).searchParams.has(
        "auth_token",
      ),
    ).toBe(false)
  })

  test("never authenticates external or lookalike content URLs", () => {
    const base = "http://localhost:4096/proxy"
    expect(isServerContentURL(`${base}/file/content?path=a`, base, "file")).toBe(true)
    expect(isServerContentURL("https://example.com/file/content?path=a", base, "file")).toBe(false)
    expect(isServerContentURL(`${base}/file/content-evil?path=a`, base, "file")).toBe(false)
    expect(isServerContentURL(`${base}/media/content?id=a`, base, "media")).toBe(true)
  })

  test("requests cached previews independently of full media content", () => {
    const input = { url: "http://localhost:4096", directory: "/tmp", id: "med_one", password: "secret" }
    const preview = new URL(mediaContentURL({ ...input, preview: "thumbnail" }))
    expect(preview.searchParams.get("preview")).toBe("thumbnail")
    expect(preview.searchParams.get("auth_token")).toBe(btoa("opencode:secret"))
    expect(new URL(mediaContentURL(input)).searchParams.has("preview")).toBe(false)
  })
})
