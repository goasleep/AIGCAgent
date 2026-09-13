import { describe, expect, test } from "bun:test"
import { Cause, Effect } from "effect"
import { MediaProviderError, resolveProvider } from "@/media/provider"

describe("resolveProvider", () => {
  test("defaults to openai when model is unset", async () => {
    const provider = await Effect.runPromise(resolveProvider(undefined))
    expect(provider.id).toBe("gpt-image-2")
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
