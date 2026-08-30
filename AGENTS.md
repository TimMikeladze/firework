<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Shaders are not compiled by the build

`next build` runs the vgpu WGSL loader, but the loader never validates: invalid WGSL
builds and ships. The gate is `bun run verify`, which resolves every shader in
`src/builder/shaders/` against a real device, runs the full emit → simulate → reflect →
water → draw → bloom → composite chain headlessly, and asserts on the pixels. Run it
after touching any `.wgsl` file or any uniform struct that mirrors one.

`bun run verify -- --pattern <id> --png out.png` renders a single burst pattern to a PNG,
which is the fastest way to check how a change actually looks without a browser.

Uniform structs are mirrored by hand between WGSL and `src/builder/renderer.ts`. Field
names must match the WGSL exactly — vgpu binds by name — and every `vec3f` needs its
padding field, or the values land at the wrong offsets. `scripts/verify-pipeline.mjs` and
`scripts/render-og.mjs` mirror the same structs a third and fourth time; a field added to
`SkyParams` has to land in all four or the shader silently reads zero. `SkyParams` ends in
two `array<vec4f, 4>` fields (`lights`, `lightColors`); the JS side hands them over as
four-element arrays of four-element arrays, and `LIGHTS` in `sky.wgsl` must stay equal to
`WATER_LIGHTS` in the renderer.

`bun run verify -- --light 0` turns the point lights off, which isolates the mirror
target's contribution to the water; `--waves` and `--reflection` cover the other knobs.

# The water reflects a pass, not a trick

The reflection is a real pass. `sparks.wgsl` draws every star twice: once as itself, and
once flipped through the water plane into the `mirror` target with the camera untouched —
which is the virtual image a flat mirror shows, so the water samples it at its own screen
pixel. That pass has to run *before* the sky pass that reads it, and it has to run even
when nothing is alive, or a finished burst stays in the water.

`sky.wgsl` intersects the view ray with the plane, parallax-corrects it onto the swell,
and then looks the reflection up where the facet's reflected ray actually lands: the ray
is folded back through the plane, run down to the depth of the break's virtual image, and
projected with `viewProj` — the same camera the mirror pass drew with. That is why
`SkyParams` carries both `invViewProj` and `viewProj`. The blur is the same projection
done again with the normal tilted by the roughness, so its size and direction on screen
are the real ones rather than a constant.

The wave maths lives in `water.wgsl`, a pure module with no bindings. Several things there
are load-bearing and look like tuning: octaves finer than the pixel footprint are faded
out and their slope energy handed back as `variance`, which `seaAlpha` turns into GGX
roughness on top of a Cox–Munk floor (drop the fade and the horizon becomes a shimmering
noise band; drop the floor and near water has no sparkle at all); every octave is cut into
wave groups by two slow envelopes (drop those and each octave is a ridge the eye follows
to the horizon); octave directions fan out around `WIND` with a spread that widens toward
the short end (drop the spread and the sea is stripes); and `seaGlint` is sized to the
pixel footprint in both screen directions, so it neither tiles up close nor aliases far
away.

The long shimmering path under a burst is a GGX specular from each recent break as a point
light, multiplied by the glint noise — not a blur of the reflection. The renderer keeps the
last `WATER_LIGHTS` breaks in `waterLights`, each with an intensity that follows the spark
burn curve so the path dies with the stars; a new break has to be pushed there, and
`scripts/render-og.mjs` does the same for its cue sheet. On glassy water the mirror target
already is the reflection, so the point-light lobe is faded in with roughness to stop it
drawing a second, airbrushed copy of the break.

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
