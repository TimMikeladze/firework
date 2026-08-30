"use client";

/**
 * The break chart — a pyrotechnician's schematic of the shell, drawn live from
 * the same numbers the GPU gets.
 *
 * Three readings in one figure: the altitude column on the left (where it
 * breaks), the schematic in the middle (what the break looks like head-on, at
 * its true relative size), and the fuse strip underneath (when each layer
 * ignites). Nothing here is decorative — every mark is a value you can drag.
 */

import { useMemo } from "react";
import type { BurstLayer, ShellSpec } from "@/builder/spec";
import { shellDuration } from "@/builder/spec";

const VIEW = 200;
const CENTER = VIEW / 2;

/**
 * Radius a layer's sparks actually reach, in world units.
 *
 * With exponential drag, distance converges to v/k; the `1 - e^(-kt)` term is
 * how far along that limit the sparks get before they burn out. This is the
 * same integral the sim performs, so the chart matches what you see fired.
 */
export function layerRadius(layer: BurstLayer, globalDrag: number): number {
  const k = Math.max(0.05, layer.drag + globalDrag);
  const reach = (layer.speed / k) * (1 - Math.exp(-k * layer.life));
  return reach + layer.startRadius;
}

/** Trade-magazine convention: shell calibre scales with how wide it breaks. */
export function shellCaliber(radius: number): number {
  return Math.max(2, Math.min(16, Math.round((radius / 4.6) * 2) / 2));
}

function hash(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0xffffffff;
  };
}

function seedOf(text: string): number {
  let value = 2166136261;
  for (let i = 0; i < text.length; i++) {
    value ^= text.charCodeAt(i);
    value = Math.imul(value, 16777619);
  }
  return value >>> 0;
}

/** Unit-space marks for one layer, in the plane the schematic looks at. */
function layerMarks(layer: BurstLayer): { x: number; y: number; r: number }[] {
  const random = hash(seedOf(layer.id + layer.pattern));
  const marks: { x: number; y: number; r: number }[] = [];
  const push = (x: number, y: number, r = 1) => marks.push({ x, y, r });
  const TAU = Math.PI * 2;

  switch (layer.pattern) {
    case "ring": {
      for (let i = 0; i < 56; i++) {
        const a = (i / 56) * TAU;
        push(Math.cos(a), Math.sin(a) * 0.26);
      }
      break;
    }
    case "double-ring": {
      for (let i = 0; i < 40; i++) {
        const a = (i / 40) * TAU;
        push(Math.cos(a), Math.sin(a) * 0.26);
        push(Math.cos(a) * 0.26, Math.sin(a));
      }
      break;
    }
    case "palm": {
      for (let frond = 0; frond < 7; frond++) {
        const a = -Math.PI * 0.12 - (frond / 6) * Math.PI * 0.76;
        for (let step = 1; step <= 9; step++) {
          const t = step / 9;
          push(
            Math.cos(a) * t,
            Math.sin(a) * t - t * t * 0.18,
            t > 0.85 ? 1.6 : 0.8,
          );
        }
      }
      break;
    }
    case "willow": {
      for (let i = 0; i < 46; i++) {
        const a = (i / 46) * TAU;
        const droop = Math.max(0, Math.sin(a)) * 0.25;
        push(Math.cos(a) * 0.9, Math.sin(a) * 0.75 - droop - 0.1);
      }
      break;
    }
    case "crossette": {
      for (let cluster = 0; cluster < 5; cluster++) {
        const a = (cluster / 5) * TAU + 0.4;
        for (let i = 0; i < 9; i++) {
          push(
            Math.cos(a) * 0.88 + (random() - 0.5) * 0.3,
            Math.sin(a) * 0.88 + (random() - 0.5) * 0.3,
          );
        }
      }
      break;
    }
    case "star": {
      for (let i = 0; i < 70; i++) {
        const a = (i / 70) * TAU;
        const radius = 0.55 + 0.45 * Math.cos(a * 5);
        push(Math.cos(a) * radius, Math.sin(a) * radius);
      }
      break;
    }
    case "heart": {
      for (let i = 0; i < 70; i++) {
        const t = (i / 70) * TAU;
        const x = 16 * Math.sin(t) ** 3;
        const y =
          13 * Math.cos(t) -
          5 * Math.cos(2 * t) -
          2 * Math.cos(3 * t) -
          Math.cos(4 * t);
        push(x / 17, -y / 17);
      }
      break;
    }
    case "spiral": {
      for (let i = 0; i < 76; i++) {
        const t = i / 76;
        const a = t * TAU * 2.6;
        push(Math.cos(a) * t, Math.sin(a) * t);
      }
      break;
    }
    case "strobe": {
      for (let i = 0; i < 30; i++) {
        const a = random() * TAU;
        const radius = 0.25 + random() * 0.75;
        push(Math.cos(a) * radius, Math.sin(a) * radius, 1.7);
      }
      break;
    }
    case "cone": {
      for (let i = 0; i < 60; i++) {
        const a = -Math.PI / 2 + (random() - 0.5) * 0.8;
        const radius = 0.3 + random() * 0.7;
        push(Math.cos(a) * radius, Math.sin(a) * radius);
      }
      break;
    }
    default: {
      for (let i = 0; i < 84; i++) {
        const a = (i / 84) * TAU;
        const radius = 0.84 + random() * 0.16;
        push(Math.cos(a) * radius, Math.sin(a) * radius);
      }
    }
  }
  return marks;
}

export function BreakChart({ spec }: { spec: ShellSpec }) {
  const layers = spec.layers.filter((layer) => layer.enabled);

  const drawn = useMemo(() => {
    return layers.map((layer) => ({
      layer,
      radius: layerRadius(layer, spec.physics.drag),
      marks: layerMarks(layer),
    }));
  }, [layers, spec.physics.drag]);

  const maxRadius = Math.max(1, ...drawn.map((entry) => entry.radius));
  const caliber = shellCaliber(maxRadius);
  const duration = shellDuration(spec);
  const apex = spec.launch.height;

  return (
    <div className="flex max-w-[300px] gap-3">
      {/* Altitude column: where the shell breaks, against the water line. */}
      <div className="flex w-9 shrink-0 flex-col items-center justify-between py-1">
        <span className="readout text-gold text-[10px]">
          {apex.toFixed(0)}m
        </span>
        <div className="border-seam relative w-px flex-1 border-l">
          <span
            className="bg-ember absolute -left-[3px] size-[7px] rounded-full"
            style={{
              top: `${Math.max(0, Math.min(100, 100 - (apex / 90) * 100))}%`,
            }}
          />
        </div>
        <span className="text-ash text-[9px] tracking-wide">WATER</span>
      </div>

      <div className="min-w-0 flex-1">
        <svg
          viewBox={`0 0 ${VIEW} ${VIEW}`}
          className="border-seam bg-void/60 w-full rounded-[3px] border"
          role="img"
          aria-label={`Break schematic: ${layers.length} layer${
            layers.length === 1 ? "" : "s"
          }, about ${(maxRadius * 2).toFixed(0)} metres across`}
        >
          <title>Break schematic</title>
          {/* Scale rings at a quarter and half of the widest break. */}
          {[0.5, 1].map((fraction) => (
            <circle
              key={fraction}
              cx={CENTER}
              cy={CENTER}
              r={CENTER * 0.86 * fraction}
              fill="none"
              stroke="#262b33"
              strokeDasharray="2 4"
            />
          ))}

          {drawn.map(({ layer, radius, marks }) => {
            const scale = (radius / maxRadius) * CENTER * 0.86;
            // Rounded, because Math.cos differs in the last ULP between Node
            // and V8 — enough to trip React's hydration check on the server
            // render of a stock shell.
            const at = (value: number) =>
              (Math.round(value * 100) / 100).toFixed(2);
            return (
              <g key={layer.id}>
                {marks.map((mark, index) => (
                  <circle
                    key={`${layer.id}-${index}`}
                    cx={at(CENTER + mark.x * scale)}
                    cy={at(CENTER + mark.y * scale)}
                    r={0.9 * mark.r}
                    fill={index % 3 === 0 ? layer.colorB : layer.colorA}
                    opacity={0.92}
                  />
                ))}
              </g>
            );
          })}
        </svg>

        {/* Fuse strip: layers are a genuine sequence, so they are numbered. */}
        <div className="mt-2 flex flex-col gap-1">
          <div className="border-seam bg-void/60 relative h-4 rounded-[2px] border">
            {drawn.map(({ layer }, index) => (
              <span
                key={layer.id}
                className="absolute top-1/2 h-2 w-px -translate-y-1/2"
                style={{
                  left: `${Math.min(97, (layer.delay / Math.max(0.4, duration)) * 100)}%`,
                  background: layer.colorA,
                  boxShadow: `0 0 6px ${layer.colorA}`,
                }}
                title={`${index + 1}. ${layer.name} at +${layer.delay.toFixed(2)}s`}
              />
            ))}
          </div>
          <div className="text-ash flex justify-between text-[10px]">
            <span className="readout">break</span>
            <span className="readout">
              {caliber.toFixed(1)}&Prime; · {(maxRadius * 2).toFixed(0)}m wide
            </span>
            <span className="readout">+{duration.toFixed(1)}s</span>
          </div>
        </div>
      </div>
    </div>
  );
}
