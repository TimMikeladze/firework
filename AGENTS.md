<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Shaders are not compiled by the build

`next build` runs the vgpu WGSL loader, but the loader never validates: invalid WGSL
builds and ships. The gate is `bun run verify`, which resolves every shader in
`src/builder/shaders/` against a real device, runs the full emit → simulate → draw →
bloom → composite chain headlessly, and asserts on the pixels. Run it after touching any
`.wgsl` file or any uniform struct that mirrors one.

`bun run verify -- --pattern <id> --png out.png` renders a single burst pattern to a PNG,
which is the fastest way to check how a change actually looks without a browser.

Uniform structs are mirrored by hand between WGSL and `src/builder/renderer.ts`. Field
names must match the WGSL exactly — vgpu binds by name — and every `vec3f` needs its
padding field, or the values land at the wrong offsets.

# The audio clock owns show timing

A cue is the time a shell should *break*, not the time it launches. The renderer launches
each one `shellRiseTime(spec)` seconds early and hands the remaining time to the rocket as
its fuse, so a late frame still breaks on the beat.

Every scheduling decision reads `ShowAudio.songTime` (or `ShowAudio.now` for live input) —
the `AudioContext` clock, minus the device's output latency. The renderer's own `time`
accumulates `deltaTime` and drifts against it; using it for cue timing silently desyncs the
whole show. `requestAnimationFrame` only decides when the audio clock is sampled.

`buildShow()` in `src/builder/choreography.ts` is pure and seeded — same track, same shell,
same settings, same script — which is what `bun test` leans on. Keep it that way: no
`Date.now()`, no unseeded randomness, no reaching for the renderer.

# The social card is baked, not live

`public/og/night.png` is a committed frame of the real show, produced by
`bun run og` (`scripts/render-og.mjs`) through the same emit → sim → draw → bloom →
composite chain. `next build` never renders it, so touching a shader does not change the
card — re-run `bun run og` when you want it to.

`src/app/opengraph-image.tsx` composes the type over that plate with `next/og`, and
`twitter-image.tsx` re-exports it. Iterate with `bun run og:card <out.png>`, which calls
the route and writes its bytes; there is no need to run a build or a browser. Satori is
not a browser: every `div` with more than one child needs an explicit `display: flex`,
and the rail's bar widths are computed from the column width so the cue markers line up
with the bars.

The matrix helpers both scripts share live in `scripts/lib/mat4.mjs`, in plain ESM with no
dependencies so they still run under bare `node`.
