import { expect, test } from "bun:test"
import { open } from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "../fixture/fixture"
import { MAX_IMAGE_BYTES, MAX_UPLOAD_BYTES, validateMediaUpload } from "../../src/media/upload"

test("checks signatures, MIME declarations and image/video size limits before ingest", async () => {
  await using directory = await tmpdir()
  const file = path.join(directory.path, "image.png")
  await Bun.write(file, Buffer.from("89504e470d0a1a0a", "hex"))
  expect(await validateMediaUpload({ path: file, name: "image.png", contentType: "application/octet-stream" })).toEqual(
    { kind: "image", mime: "image/png" },
  )
  await expect(validateMediaUpload({ path: file, name: "image.png", contentType: "video/mp4" })).rejects.toThrow("MIME")
  await expect(validateMediaUpload({ path: file, name: "image.mp4", contentType: "video/mp4" })).rejects.toThrow(
    "contents",
  )
  await expect(validateMediaUpload({ path: file, name: "image.exe", contentType: "image/png" })).rejects.toThrow(
    "extension",
  )
  const handle = await open(file, "r+")
  await handle.truncate(MAX_IMAGE_BYTES + 1)
  await expect(validateMediaUpload({ path: file, name: "image.png", contentType: "image/png" })).rejects.toThrow(
    "20 MB",
  )
  await handle.truncate(MAX_UPLOAD_BYTES + 1)
  await handle.close()
  await expect(validateMediaUpload({ path: file, name: "video.mp4", contentType: "video/mp4" })).rejects.toThrow(
    "250 MB",
  )
})
