import { expect } from "bun:test"
import { Clock, Effect, Fiber, Ref } from "effect"
import { TestClock } from "effect/testing"
import { pollUntilDone, resolveProvider } from "../../src/media/provider"
import { it } from "../lib/effect"

it.effect("observes already completed image jobs without sleeping", () =>
  Effect.gen(function* () {
    const provider = yield* resolveProvider("gpt-image-2")
    const observed = yield* Ref.make(-1)
    const start = yield* Clock.currentTimeMillis
    const fiber = yield* pollUntilDone(provider, "inline:aW1hZ2U=", () =>
      Clock.currentTimeMillis.pipe(Effect.flatMap((time) => Ref.set(observed, time - start))),
    ).pipe(Effect.forkChild)
    yield* TestClock.adjust("5 seconds")
    expect(yield* Fiber.join(fiber)).toEqual({ state: "succeeded", url: "data:image/png;base64,aW1hZ2U=" })
    expect(yield* Ref.get(observed)).toBe(0)
  }),
)

it.effect("backs off only while a job is unfinished", () =>
  Effect.gen(function* () {
    const provider = yield* resolveProvider("gpt-image-2")
    const polls = yield* Ref.make<number[]>([])
    const start = yield* Clock.currentTimeMillis
    const fiber = yield* pollUntilDone(
      {
        ...provider,
        poll: () =>
          Effect.gen(function* () {
            const time = yield* Clock.currentTimeMillis
            const times = yield* Ref.updateAndGet(polls, (values) => [...values, time - start])
            return times.length === 3
              ? { state: "succeeded" as const, url: "https://example.com/done.mp4" }
              : { state: "running" as const }
          }),
      },
      "job",
    ).pipe(Effect.forkChild)
    yield* TestClock.adjust("13 seconds")
    expect((yield* Fiber.join(fiber)).state).toBe("succeeded")
    expect(yield* Ref.get(polls)).toEqual([0, 5_000, 12_500])
  }),
)
