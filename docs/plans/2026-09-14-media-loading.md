# Media library loading implementation plan

**Goal:** Show existing media promptly, reduce preview transfer size, and remove the artificial delay after synchronous image generation.

**Architecture:** Serve 640px JPEG previews through the existing authenticated content endpoint using `preview=thumbnail`. Generate previews in a detached background job as soon as each generated or processed asset is ingested, and retain the same on-demand endpoint as a cache-miss fallback. The existing FFmpeg service deduplicates concurrent work and reuses disk output. Keep list metadata independent of image loading and retain it during refresh. Reuse middleware's instance identity for asset ownership; add private HTTP caching after ownership checks.

**Tech stack:** Solid resources/stores, Effect services/cache, existing FFmpeg, typed HttpApi, Bun tests.

## Design choices

- On-demand disk previews also cover historical assets without a migration or blocking ingestion. Atomic writes prevent clients seeing partial JPEGs. Cache paths are versioned; failures fall back to original images. Video originals keep Range support and are loaded only when played.
- A resource owns list data instead of copying it to a separate signal. Stable request parameters prevent redundant fetches; obsolete requests are aborted and stale pagination cannot overwrite another project/filter or a refreshed page.
- The server still authenticates and checks ownership before every cached response. Instance identity is reused only when it matches the requested directory. No unbounded project/asset cache is introduced.
- Poll immediately, then retain existing backoff for unfinished jobs. Provider execution time and durable video download remain unchanged.

## Implementation and verification

1. `packages/opencode/src/media/provider.ts`: move the delay after terminal-state checks; test immediate success and unfinished-job backoff with Effect TestClock.
2. `packages/opencode/src/media/preview.ts`: bounded/deduplicated FFmpeg previews, atomic disk cache. Add real FFmpeg image/video tests for dimensions, cache reuse, invalid input and original preservation.
3. `packages/opencode/src/server/routes/instance/httpapi/media.ts`, `server.ts`, and `media/library.ts`: wire preview service, reuse instance context, preserve authentication/Range and add conditional cache responses. Extend real-socket route tests for previews, unauthorized access, cross-project isolation and 304/Range.
4. `packages/app/src/utils/media-library.ts`, `media-url.ts`, and `pages/media.tsx`: resource-owned list data, independent stats, thumbnail URLs with fallback, async decoding, video posters and no preload. Browser-condition tests cover late/stale responses and refresh/pagination.
5. Run focused Bun tests from the owning packages, `bun typecheck` from app/opencode, and `bun run generate` from client. Inspect generated changes and verify preview transfer size on a local fixture. Do not restart the user's running app or server.

## Acceptance

- Cards do not wait for media downloads; background refresh retains existing cards.
- Six visible cards request small previews; idle video does not fetch its original body.
- Completed image jobs do not wait five seconds; unfinished jobs retain bounded polling.
- Preview/HTTP caches preserve auth, project boundaries, deletion behavior and full-file playback.

The user authorized design and execution together. Work is performed in the current workspace to preserve the existing uncommitted media implementation; no automatic commits or application restarts are needed.

## Verification results

- 44 media tests pass, including actual FFmpeg preview generation, concurrent cache access, source changes, invalid inputs, immediate completion, backoff, eager preview-job scheduling after image/video ingest, and video cancellation. The existing >30-second video test now models elapsed provider time instead of assuming a particular number of polling sleeps; it still exercises a real wait of about 39 seconds.
- 8 HTTP integration tests pass over real sockets/Web handlers, including authentication, project isolation, conditional 304 responses, Range 206 responses, cached preview deletion and normal CRUD.
- 4 browser-condition state tests and 4 URL/response tests pass. Coverage includes equivalent inputs, refresh retention, unchanged card identity, stale project/filter responses, pagination deduplication, and forced refresh after deletion. Expected failed/aborted requests produce Happy DOM console diagnostics while these regression tests pass.
- `bun typecheck` passes in both `packages/app` and `packages/opencode`. `bun run generate` succeeds in `packages/client` with no generated client changes. `git diff --check` is clean.
- An isolated Vite fixture rendered the real MediaPage in Chromium via agent-browser. With stats resolved but list held pending, it showed six skeletons and no empty-library message. After list release, network capture showed exactly six preview requests and zero original video requests. Clicking play requested the original video using Range; dispatching an image error exercised the original-image fallback successfully.
- Browser fixture image size: 162,820 bytes original versus 34,514 bytes JPEG preview (about 79% smaller). This is a synthetic test fixture, not a measurement of the user's production load time.
- The user's running application/server was not restarted, as required by `packages/app/AGENTS.md`.
