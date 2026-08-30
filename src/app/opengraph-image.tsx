import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ImageResponse } from "next/og";

/**
 * The social card.
 *
 * The background is not artwork — it is one frame of the real show, rendered
 * headlessly by `bun run og` through the same shader chain the browser runs.
 * Everything below is the firing desk laid back over it: the signage wordmark,
 * one line of copy, and the cue rail the whole app is built around.
 *
 * Composed at build time, so the route costs nothing at request time.
 */

export const alt =
  "A golden peony, a sapphire break and a crimson ring over dark water, with the firework.sh cue rail beneath them";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

// Straight out of globals.css — the card and the app share one palette.
const VOID = "#08090b";
const PAPER = "#e9e7e2";
const ASH = "#8b929c";
const EMBER = "#ff6a1f";
const GOLD = "#ffc24a";

/**
 * Where the playhead sits, as a fraction of the rail. Chosen so the lit cue
 * lands directly under the shell breaking above it — the whole point of the
 * app, said once, without a caption.
 */
const PLAYHEAD = 0.55;
const BARS = 104;
/** The rail spans the type column exactly, so percentages line up with bars. */
const RAIL = size.width - 64 * 2;
const BAR_GAP = 3;
const BAR_WIDTH = (RAIL - BAR_GAP * (BARS - 1)) / BARS;

/**
 * The waveform under the cues. A deterministic envelope that looks like a song
 * rather than like noise — a slow arrangement curve under a faster beat — so
 * the rail reads as music at a glance even though nothing here analyses audio.
 */
const WAVEFORM = Array.from({ length: BARS }, (_, index) => {
  const t = index / (BARS - 1);
  const arrangement = 0.45 + 0.4 * Math.sin(t * Math.PI * 1.6 - 0.5);
  const beat = 0.5 + 0.5 * Math.sin(index * 2.1);
  const detail = 0.5 + 0.5 * Math.sin(index * 5.7 + 1.3);
  const level = Math.min(
    1,
    Math.max(0.08, arrangement * (0.55 + 0.45 * beat * detail)),
  );
  return {
    id: `bar-${index}`,
    height: Math.round(5 + level * 33),
    played: t <= PLAYHEAD,
  };
});

/** Cue positions along the rail. The fourth one is the shell breaking above. */
const CUES = [0.07, 0.19, 0.34, PLAYHEAD, 0.71, 0.86, 0.94];

const font = (file: string) =>
  readFile(join(process.cwd(), "src/app/fonts", file));

export default async function Image() {
  const [plate, signage, body, mono] = await Promise.all([
    readFile(join(process.cwd(), "public/og/night.png")),
    font("BigShoulders-ExtraBold.ttf"),
    font("Archivo-Regular.ttf"),
    font("DMMono-Medium.ttf"),
  ]);

  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        position: "relative",
        backgroundColor: VOID,
        fontFamily: "Archivo",
        // The plate travels inline: satori has no loader and no network.
        backgroundImage: `url(data:image/png;base64,${plate.toString("base64")})`,
        backgroundSize: `${size.width}px ${size.height}px`,
      }}
    >
      {/* Night has to win under the type, or the reflections eat the wordmark. */}
      <div
        style={{
          position: "absolute",
          background:
            "linear-gradient(to top, rgba(8,9,11,0.93) 0%, rgba(8,9,11,0) 100%)",
          top: "26%",
          bottom: 0,
          left: 0,
          right: 0,
        }}
      />
      <div
        style={{
          position: "absolute",
          inset: 0,
          background:
            "linear-gradient(to right, rgba(8,9,11,0.55) 0%, rgba(8,9,11,0) 48%)",
        }}
      />

      <div
        style={{
          position: "absolute",
          left: 64,
          right: 64,
          bottom: 44,
          display: "flex",
          flexDirection: "column",
        }}
      >
        <div
          style={{
            fontFamily: "BigShoulders",
            fontSize: 18,
            letterSpacing: "0.22em",
            color: "#a6acb6",
            textTransform: "uppercase",
          }}
        >
          Shell designer · WebGPU · Beat-synced
        </div>

        {/* Signage for the firework, a terminal face for the shell it lives at. */}
        <div
          style={{
            display: "flex",
            alignItems: "flex-end",
            marginTop: 10,
            marginBottom: 10,
          }}
        >
          <div
            style={{
              fontFamily: "BigShoulders",
              fontSize: 96,
              lineHeight: 0.82,
              letterSpacing: "-0.005em",
              color: PAPER,
            }}
          >
            firework
          </div>
          <div
            style={{
              fontFamily: "DMMono",
              fontSize: 40,
              lineHeight: 1,
              color: EMBER,
              paddingLeft: 0,
              paddingBottom: 3,
            }}
          >
            .sh
          </div>
        </div>

        <div
          style={{
            fontSize: 27,
            lineHeight: 1.3,
            color: "#d3d6db",
            maxWidth: 720,
          }}
        >
          Design the shell. Fire it over the water, on the beat.
        </div>

        {/* The cue rail: the song, the cues written against it, and the shell
            breaking right now — directly under the break in the sky. */}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            marginTop: 30,
          }}
        >
          <div
            style={{
              position: "relative",
              display: "flex",
              alignItems: "flex-end",
              height: 38,
              gap: BAR_GAP,
            }}
          >
            {WAVEFORM.map((bar) => (
              <div
                key={bar.id}
                style={{
                  width: BAR_WIDTH,
                  height: bar.height,
                  borderRadius: 1,
                  background: bar.played
                    ? "rgba(255,194,74,0.5)"
                    : "rgba(233,231,226,0.16)",
                }}
              />
            ))}
          </div>

          <div
            style={{
              position: "relative",
              display: "flex",
              height: 16,
              marginTop: 8,
              borderTop: `1px solid rgba(58,65,76,0.9)`,
            }}
          >
            {CUES.map((at) => {
              const live = at === PLAYHEAD;
              return (
                <div
                  key={at}
                  style={{
                    position: "absolute",
                    left: `${at * 100}%`,
                    top: live ? -5 : -4,
                    width: live ? 10 : 7,
                    height: live ? 10 : 7,
                    marginLeft: live ? -5 : -3.5,
                    background: live ? GOLD : EMBER,
                    transform: "rotate(45deg)",
                    boxShadow: live
                      ? `0 0 16px 3px rgba(255,194,74,0.75)`
                      : "none",
                  }}
                />
              );
            })}
          </div>

          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              marginTop: 6,
              fontFamily: "DMMono",
              fontSize: 16,
              letterSpacing: "0.06em",
              color: ASH,
            }}
          >
            <div style={{ display: "flex", gap: 18 }}>
              <div style={{ display: "flex", color: GOLD }}>00:12.480</div>
              <div style={{ display: "flex" }}>CUE 04 — GOLDEN PEONY</div>
            </div>
            <div style={{ display: "flex" }}>03:41</div>
          </div>
        </div>
      </div>
    </div>,
    {
      ...size,
      fonts: [
        { name: "BigShoulders", data: signage, style: "normal", weight: 800 },
        { name: "Archivo", data: body, style: "normal", weight: 400 },
        { name: "DMMono", data: mono, style: "normal", weight: 500 },
      ],
    },
  );
}
