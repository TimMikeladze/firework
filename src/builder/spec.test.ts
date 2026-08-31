import { describe, expect, test } from "bun:test";
import { layerRadius, shellCaliber } from "@/components/builder/BreakChart";
import { PRESETS } from "./presets";
import { randomShell } from "./random";
import {
  defaultLayer,
  defaultShell,
  hexToLinear,
  parseShell,
  shellDuration,
  shellParticleCount,
} from "./spec";

describe("parseShell", () => {
  test("round-trips a shell through JSON", () => {
    const shell = defaultShell({ name: "Round trip" });
    const parsed = parseShell(JSON.parse(JSON.stringify(shell)));
    expect(parsed).toEqual(shell);
  });

  test("round-trips every stock shell", () => {
    for (const preset of PRESETS) {
      expect(parseShell(JSON.parse(JSON.stringify(preset)))).toEqual(preset);
    }
  });

  test("falls back to the default shell for junk", () => {
    const fallback = defaultShell();
    for (const junk of [null, undefined, 42, "nope", []]) {
      const parsed = parseShell(junk);
      expect(parsed.layers.length).toBe(1);
      expect(parsed.physics).toEqual(fallback.physics);
    }
  });

  test("clamps values that would break the renderer", () => {
    const parsed = parseShell({
      name: "x".repeat(500),
      launch: { height: 1e9, tilt: -1e9, flash: 5 },
      physics: { gravity: -100, turbulence: Number.NaN },
      look: { exposure: 0, bloom: 99, waves: 4, chop: -1, moonAngle: 720 },
      layers: [{ count: 1e9, life: -3, size: 0, drag: "nope", pattern: "wat" }],
      audio: { enabled: true, boom: 0.5, crackle: 0.5, voice: "kaboom" },
    });

    expect(parsed.name.length).toBe(60);
    expect(parsed.launch.height).toBeLessThanOrEqual(90);
    expect(parsed.launch.tilt).toBeGreaterThanOrEqual(-35);
    expect(parsed.launch.flash).toBe(1);
    expect(parsed.physics.gravity).toBe(0);
    // NaN is not a usable number, so the default stands in.
    expect(parsed.physics.turbulence).toBe(defaultShell().physics.turbulence);
    expect(parsed.look.exposure).toBeGreaterThanOrEqual(0.2);
    expect(parsed.look.bloom).toBe(2);
    expect(parsed.look.waves).toBe(1);
    expect(parsed.look.chop).toBe(0);
    expect(parsed.look.moonAngle).toBe(180);
    expect(parsed.layers[0].count).toBeLessThanOrEqual(20000);
    expect(parsed.layers[0].life).toBeGreaterThanOrEqual(0.15);
    // An unknown pattern falls back rather than reaching the GPU as `undefined`.
    expect(parsed.layers[0].pattern).toBe("sphere");
    // Same for a voice the sound design does not have.
    expect(parsed.audio.voice).toBe("auto");
  });

  test("a shell saved before the water had a sea state still loads", () => {
    // Older saves have no `look.waves`; the field has to default rather than
    // reach the shader as undefined and flatten the sea to glass.
    const parsed = parseShell({
      look: { bloom: 1.2, exposure: 1, reflection: 0.6, haze: 0.4 },
    });
    expect(parsed.look.waves).toBe(defaultShell().look.waves);
    expect(parsed.look.reflection).toBe(0.6);
    // And older saves have no break voice either.
    expect(parsed.audio.voice).toBe("auto");
  });

  test("a shell saved before the moon and the chop still loads", () => {
    // Same story for the later fields: an old save gets the default moon and
    // sea confusion rather than a moonless, glassy, or NaN-driven sky.
    const parsed = parseShell({
      look: { bloom: 1, exposure: 1, reflection: 0.6, waves: 0.4, haze: 0.4 },
    });
    const base = defaultShell().look;
    expect(parsed.look.chop).toBe(base.chop);
    expect(parsed.look.moon).toBe(base.moon);
    expect(parsed.look.moonSize).toBe(base.moonSize);
    expect(parsed.look.moonHeight).toBe(base.moonHeight);
    expect(parsed.look.moonAngle).toBe(base.moonAngle);
    expect(parsed.look.moonPhase).toBe(base.moonPhase);
  });

  test("defaultShell merges a partial look over the defaults", () => {
    // Presets and the random generator hand over only the look fields they
    // care about; the rest have to come from the defaults, not go missing.
    const shell = defaultShell({ look: { waves: 0.9 } });
    expect(shell.look.waves).toBe(0.9);
    expect(shell.look.moon).toBe(defaultShell().look.moon);
    expect(shell.look.chop).toBe(defaultShell().look.chop);
  });

  test("keeps at most four layers", () => {
    const parsed = parseShell({
      layers: Array.from({ length: 9 }, () => defaultLayer()),
    });
    expect(parsed.layers.length).toBe(4);
  });
});

describe("colour conversion", () => {
  test("maps hex to linear light", () => {
    expect(hexToLinear("#000000")).toEqual([0, 0, 0]);
    expect(hexToLinear("#ffffff")).toEqual([1, 1, 1]);
    const [r, g, b] = hexToLinear("#ff0000");
    expect(r).toBe(1);
    expect(g).toBe(0);
    expect(b).toBe(0);
    // Mid grey is far darker in linear light than its 0.5 sRGB value suggests.
    const [mid] = hexToLinear("#808080");
    expect(mid).toBeGreaterThan(0.2);
    expect(mid).toBeLessThan(0.25);
  });

  test("falls back to white for anything unparseable", () => {
    expect(hexToLinear("not a colour")).toEqual([1, 1, 1]);
  });
});

describe("shell summaries", () => {
  test("counts only live layers", () => {
    const shell = defaultShell({
      layers: [
        defaultLayer({ count: 1000 }),
        defaultLayer({ count: 500, enabled: false }),
      ],
    });
    expect(shellParticleCount(shell)).toBe(1000);
  });

  test("duration covers the last layer's fuse and burn", () => {
    const shell = defaultShell({
      layers: [defaultLayer({ delay: 1.5, life: 2, lifeJitter: 0 })],
    });
    expect(shellDuration(shell)).toBeCloseTo(3.5, 5);
  });
});

describe("break chart maths", () => {
  test("radius grows with speed and shrinks with drag", () => {
    const base = defaultLayer({ speed: 16, drag: 1, life: 2, startRadius: 0 });
    const faster = { ...base, speed: 24 };
    const draggier = { ...base, drag: 3 };
    expect(layerRadius(faster, 0.3)).toBeGreaterThan(layerRadius(base, 0.3));
    expect(layerRadius(draggier, 0.3)).toBeLessThan(layerRadius(base, 0.3));
  });

  test("start radius offsets the reach", () => {
    const base = defaultLayer({ startRadius: 0 });
    const offset = { ...base, startRadius: 5 };
    expect(layerRadius(offset, 0.3) - layerRadius(base, 0.3)).toBeCloseTo(5, 5);
  });

  test("calibre stays inside the range a rack can hold", () => {
    expect(shellCaliber(0)).toBe(2);
    expect(shellCaliber(1e6)).toBe(16);
    expect(shellCaliber(23)).toBeGreaterThan(shellCaliber(9));
  });
});

describe("randomShell", () => {
  test("always produces a spec the parser accepts unchanged", () => {
    for (let i = 0; i < 40; i++) {
      const shell = randomShell();
      expect(parseShell(JSON.parse(JSON.stringify(shell)))).toEqual(shell);
      expect(shell.layers.length).toBeGreaterThanOrEqual(1);
      expect(shellParticleCount(shell)).toBeGreaterThan(0);
    }
  });
});
