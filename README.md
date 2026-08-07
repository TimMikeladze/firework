# Pulse Show

A browser rhythm game where hitting notes in time with the music launches synchronized
fireworks over a night skyline. Inspired by *Boom Boom Rocket*: the show is the reward,
and it looks good whether or not you're good at it.

## Playing

- **D F J K** — four launch tubes. Tap zones appear on touch devices.
- **Esc** — pause.
- Notes scroll down to the hit line. Perfect and Good both launch a shell; a miss
  fizzles at the pad instead of ending the run.
- Combos escalate the show: bigger shells, layered secondary bursts, and a screen-wide
  finale every 25 hits.
- **Hard mode** (opt-in, in Settings) adds a health bar you can fail out of. Off by
  default — the sky should never go dark.

## Bring your own music

Drop an mp3, wav, ogg, or m4a onto the page, or use **Import your music** on the song
select screen. The file is decoded and analyzed entirely in the browser and is never
uploaded anywhere.

Analysis runs spectral flux onset detection over an STFT, picks peaks with an adaptive
local threshold, estimates tempo from an inter-onset-interval histogram, and segments the
track by windowed energy into intro / verse / build / chorus / drop / outro. Those
sections drive the palette and burst scale, so the show follows the song's structure.

Imported tracks are cached in IndexedDB (file plus analysis), so replaying one is instant
and changing difficulty just re-derives the note pattern — no second analysis pass.

## Timing

Every gameplay decision reads `AudioContext.currentTime`. `requestAnimationFrame` only
decides *when* that clock is sampled — it never advances it, so visuals and hit windows
can't drift apart. Pause suspends the whole audio context, freezing scheduled events and
the clock together. A calibration offset in Settings shifts the hit windows if your
output has latency.

The bundled demo track is synthesized in the browser rather than shipped as an audio
file: drums, bass, pad, and arp are all scheduled against a single start time on the
audio clock, and the hand-authored chart sits on the same BPM grid.

## Rendering

Canvas2D with a hand-rolled particle engine — flat typed arrays and a free list, so the
hot loop never allocates. Additive blending, gravity and drag on falling embers, six
burst shapes (peony, chrysanthemum, willow, palm, ring, crossette) chosen by combo and
song intensity. The backdrop is a three-layer parallax skyline over a mirrored water
strip; both are baked once per resize.

## Development

```bash
bun install
bun run dev      # http://localhost:3000
bun run build
bun run lint     # biome
```

Built with Next.js 16, React 19, and Tailwind 4. The whole game runs client-side; the
server only ships the shell.
