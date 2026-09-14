import { authTokenFromCredentials } from "./server"

export function mediaContentURL(input: {
  url: string
  directory: string
  id: string
  username?: string
  password?: string
  preview?: "thumbnail"
}) {
  const url = new URL(`${input.url.replace(/\/+$/, "")}/media/content`)
  url.searchParams.set("directory", input.directory)
  url.searchParams.set("id", input.id)
  if (input.preview) url.searchParams.set("preview", input.preview)
  // Native image/video elements cannot set an Authorization header. Use the
  // server's existing query authentication so video Range requests also work.
  if (input.password)
    url.searchParams.set("auth_token", authTokenFromCredentials({ username: input.username, password: input.password }))
  return url.href
}

export function isServerContentURL(url: string, base: string, endpoint: "file" | "media") {
  const server = new URL(`${base.replace(/\/+$/, "")}/${endpoint}/content`)
  const resolved = new URL(url, server)
  return resolved.origin === server.origin && resolved.pathname === server.pathname
}
