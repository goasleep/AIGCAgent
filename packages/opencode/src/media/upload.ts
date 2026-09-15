import path from "node:path"
import { open, stat } from "node:fs/promises"

export const MAX_UPLOAD_BYTES = 250 * 1024 * 1024
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024

const formats: Record<string, { mime: string; kind: "image" | "video" }> = {
  ".png": { mime: "image/png", kind: "image" },
  ".jpg": { mime: "image/jpeg", kind: "image" },
  ".jpeg": { mime: "image/jpeg", kind: "image" },
  ".gif": { mime: "image/gif", kind: "image" },
  ".webp": { mime: "image/webp", kind: "image" },
  ".mp4": { mime: "video/mp4", kind: "video" },
  ".mov": { mime: "video/quicktime", kind: "video" },
  ".webm": { mime: "video/webm", kind: "video" },
  ".mkv": { mime: "video/x-matroska", kind: "video" },
}

export async function validateMediaUpload(input: { path: string; name: string; contentType: string }) {
  const format = formats[path.extname(input.name).toLowerCase()]
  if (!format) throw new Error("Unsupported media file extension")
  const declared = input.contentType.split(";", 1)[0]?.toLowerCase()
  if (declared && declared !== "application/octet-stream" && declared !== format.mime) {
    throw new Error("File extension and MIME type do not match")
  }
  const size = (await stat(input.path)).size
  if (size === 0) throw new Error("The media file is empty")
  if (size > (format.kind === "image" ? MAX_IMAGE_BYTES : MAX_UPLOAD_BYTES)) {
    throw new Error(format.kind === "image" ? "Images must be 20 MB or smaller" : "Videos must be 250 MB or smaller")
  }
  const file = await open(input.path, "r")
  const header = Buffer.alloc(64)
  await file.read(header, 0, header.length, 0).finally(() => file.close())
  const signature =
    format.mime === "image/png"
      ? header.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))
      : format.mime === "image/jpeg"
        ? header.subarray(0, 3).equals(Buffer.from("ffd8ff", "hex"))
        : format.mime === "image/gif"
          ? /^GIF8[79]a/.test(header.toString("ascii", 0, 6))
          : format.mime === "image/webp"
            ? header.toString("ascii", 0, 4) === "RIFF" && header.toString("ascii", 8, 12) === "WEBP"
            : format.mime === "video/mp4" || format.mime === "video/quicktime"
              ? ["ftyp", "moov", "mdat", "wide"].includes(header.toString("ascii", 4, 8))
              : header.subarray(0, 4).equals(Buffer.from("1a45dfa3", "hex"))
  if (!signature) throw new Error("File contents do not match the media type")
  return format
}
