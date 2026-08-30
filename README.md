# firework.sh

Design a firework shell at **[firework.sh](https://firework.sh)** — pattern, colours,
physics, fuse timing — and fire it over the water. The whole show is simulated and drawn
on the GPU with WebGPU, so a break can carry tens of thousands of stars and still hold
60 fps while you drag a slider.

Then hand it a track and the desk stops firing at random: it choreographs the whole song
and breaks every shell on the beat, whether the music is a file you dropped, a tab you are
sharing, or whatever the microphone can hear.

The rhythm game this repo started as still lives at [`/show`](#pulse-show).

```bash
bun install
bun run dev       # http://localhost:3000
```

Needs a WebGPU browser: current Chrome or Edge, or Safari 26.

## Using the desk

- **Fire** (or `Space`) launches the shell you are editing. Clicking the water launches it
  at that spot; dragging orbits the camera.
- **Auto** fires on a timer, in shells per minute. `A` toggles it.
- **Roll** (`R`) generates a plausible random shell and fires it.
- **H** hides the desk, `M` mutes, **Freeze** pauses the simulation without clearing it.
- **Save** puts the current shell in your rack (localStorage). **Copy JSON** / **Paste
  JSON** move a design between machines.
- **P** plays or pauses a loaded track. Auto-fire stands down while a show is running.

The break chart at the top of the shell card is a live schematic: the altitude column on
the left is where the shell breaks, the scatter in the middle is the break at its true
relative size, and the strip underneath is the fuse chain. It reads the same numbers the
GPU does, so it updates as you drag.

## Firing to music

The deck along the bottom takes four sources:

- **Demo track** — a 62-second track synthesized in the browser. No files, no network.
- **Load file** (or drop an mp3/wav/ogg/m4a anywhere on the page) — decoded and analysed
  in the tab; nothing is uploaded.
- **Listen to a tab** — share a tab with "Also share tab audio" ticked and the show fires
  to whatever it plays. Spotify in another tab, a YouTube set, a video call.
- **Microphone** — fires to the room. Reports are muted automatically, or the desk would
  hear its own booms as beats.

A cue is a *break* time, not a launch time. Every shell leaves the mortar
`shellRiseTime()` seconds early — the lift is solved back from the authored apex height —
so the flower opens on the beat instead of the mortar firing on it. Timing reads
`AudioContext`'s clock, corrected for the device's output latency; `requestAnimationFrame`
only decides when that clock is sampled.

**A loaded track is choreographed up front.** The analysis ([`src/audio/analysis.ts`](src/audio/analysis.ts))
gives onsets, their strength, a spectral tilt, a tempo, and an energy segmentation;
[`src/builder/choreography.ts`](src/builder/choreography.ts) cuts that into a script:

- Bass hits break low and wide, cymbals break high and tight, and the loudest onsets get a
  pistil and — in a chorus or a drop — a delayed crossette crown.
- Sections set the spacing and the palette: a verse gets a shell every couple of beats, a
  drop gets one on nearly every onset. Section climbs get a sweep across the water, and
  the last bars get a finale.
- A live star budget scales breaks down rather than letting a dense passage outrun the
  particle pool.

The strip under the transport draws that script — the track's envelope, the sections, and
a tick for every scheduled break — so the whole show is readable before it plays, and
clicking it seeks.

**A live source cannot be choreographed**, because a shell needs a couple of seconds in
the air and live audio has no future to read. [`src/builder/live.ts`](src/builder/live.ts)
tracks the beat instead: spectral flux onsets feed a least-squares fit over recent
grid-consistent hits, which predicts beats three seconds out to well inside 30 ms. Each
beat is decided at the moment its shell has to launch, so the design still reads the music
as it sounds now.

Three controls apply to both: **Show density** (how much of the track gets a shell),
**Follow my shell's colours** (use the edited palette instead of the section palettes),
and **Sync offset** (±250 ms of audio/visual calibration).

## Anatomy of a shell

A `ShellSpec` ([`src/builder/spec.ts`](src/builder/spec.ts)) is the whole design, and it is
also the save format. It has four parts:

- **Lift** — break height, tilt, fuse, the rising trail, and the break flash. Height is
  solved back into a lift impulse, so a 40 m shell really does top out at 40 m.
- **Layers** — up to four breaks, each with a pattern (peony, ring, palm, willow,
  crossette, star, heart, spiral, strobe, comet, double ring), a star count, speed, burn
  time, colours, and its own drag/gravity/twinkle/crackle/tail. A layer's `delay` and
  `startRadius` are what make pistils, secondary breaks, and crossette splits.
- **Night air** — gravity, air drag, wind, turbulence. Shared by every layer.
- **Camera and sound** — bloom, exposure, the water mirror, haze, and the synthesized
  report and crackle.

## How it runs

The CPU owns the handful of rising shells, because the break has to be scheduled
somewhere and kinematics for a dozen objects is free. Everything else is GPU-side:

1. **Emit** ([`emit.wgsl`](src/builder/shaders/emit.wgsl)) — one dispatch per layer writes
   its stars straight into the particle buffer. A 10,000-star break costs one uniform
   write and one dispatch; no particle data ever crosses the bus.
2. **Simulate** ([`sim.wgsl`](src/builder/shaders/sim.wgsl)) — gravity, wind, exponential
   drag, and a turbulence field, over the live window only.
3. **Draw** ([`sparks.wgsl`](src/builder/shaders/sparks.wgsl)) — one instanced draw of
   camera-facing quads, additively, into an HDR target. Instances past the live count are
   the same stars mirrored in the water.
4. **Composite** — bright pass, separable blur, then a hue-preserving tonemap
   ([`composite.wgsl`](src/builder/shaders/composite.wgsl)) so a gold shell stays gold
   instead of clipping to white.

The particle pool is a ring buffer. Slots are handed out in order and every layer knows
how long its stars burn, so the live set is always one contiguous window — the simulation
and the draw never touch a dead slot, and an idle sky costs almost nothing.

## Verifying

`next build` never compiles WGSL, so the shaders have their own gate. `bun run verify`
resolves and validates every shader against a real device, runs the exact
emit → simulate → draw → bloom → composite chain the browser runs, and asserts on the
pixels that come back:

```bash
bun run verify                                   # pass/fail on a headless frame
bun run verify -- --pattern 4 --png willow.png   # render one pattern and look at it
bun test                                         # specs, chart maths, choreography, beat tracking
bun run lint
```

`bun test` covers the parts that have to be right and cannot be eyeballed: that every cue
launches exactly its rise time before its break, that the script stays inside the particle
pool, and that the live beat tracker predicts beats seconds ahead of the music.

`--pattern` takes a pattern id from `PATTERN_IDS`; `--count` and `--steps` set the star
count and how far to simulate before the capture.

## Pulse Show

The original rhythm game is still at `/show`: hit notes in time with the music and the
hits launch the fireworks. It brings its own Canvas2D particle engine, onset detection,
and demo track — see [`src/game`](src/game) and [`src/components/PulseShow.tsx`](src/components/PulseShow.tsx).

- **D F J K** — four launch tubes; tap zones on touch devices. **Esc** pauses.
- Drop an mp3/wav/ogg/m4a on the page to play your own music. Analysis (spectral flux
  onset detection, tempo from an inter-onset-interval histogram, energy-based sectioning)
  lives in [`src/audio/analysis.ts`](src/audio/analysis.ts), shared with the builder's
  synced show. It runs entirely in the browser and is cached in IndexedDB. Nothing is
  uploaded.
- Every gameplay decision reads `AudioContext.currentTime`;
  `requestAnimationFrame` only decides when that clock is sampled.

## Stack

Next.js 16, React 19, Tailwind 4, and [vgpu](https://www.npmjs.com/package/vgpu) for
WebGPU. Shaders live in `.wgsl` files and are resolved by vgpu's loader, registered for
both Turbopack and webpack in [`next.config.ts`](next.config.ts). Everything runs
client-side; the server only ships the shell.

## Credits

Built by [Tim Mikeladze](https://linesofcode.dev) —
[GitHub](https://github.com/TimMikeladze) · [@linesofcode](https://x.com/linesofcode).
