"use client";

/** One break layer: what it looks like, how it flies, and when it lights. */

import { useState } from "react";
import {
  type BurstLayer,
  type BurstPattern,
  COLOR_MODES,
  type ColorMode,
  PATTERNS,
} from "@/builder/spec";
import {
  ColorField,
  DeskButton,
  Lamp,
  Segmented,
  Slider,
  Toggle,
} from "./controls";

const PATTERN_LABELS: Record<BurstPattern, string> = {
  sphere: "Peony",
  ring: "Ring",
  "double-ring": "Rings",
  palm: "Palm",
  willow: "Willow",
  crossette: "Crossette",
  star: "Star",
  heart: "Heart",
  spiral: "Spiral",
  cone: "Comet",
  strobe: "Strobe",
  triangle: "Triangle",
};

const COLOR_MODE_LABELS: Record<ColorMode, string> = {
  solid: "Solid",
  fade: "Fade",
  bicolor: "Two-tone",
  rainbow: "Rainbow",
};

export function LayerEditor({
  layer,
  index,
  canDelete,
  onChange,
  onDuplicate,
  onDelete,
}: {
  layer: BurstLayer;
  index: number;
  canDelete: boolean;
  onChange: (next: BurstLayer) => void;
  onDuplicate: () => void;
  onDelete: () => void;
}) {
  const [open, setOpen] = useState(index === 0);
  const set = <K extends keyof BurstLayer>(key: K, value: BurstLayer[K]) =>
    onChange({ ...layer, [key]: value });

  return (
    <section className="border-seam bg-riser/60 rounded-[4px] border">
      <header className="flex items-center gap-2 px-2.5 py-2">
        <Lamp on={layer.enabled} />
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          className="flex min-w-0 flex-1 items-baseline gap-2 text-left"
        >
          <span className="readout text-ash text-[10px]">{index + 1}</span>
          <span className="text-paper truncate text-[12px]">{layer.name}</span>
          <span className="text-ash shrink-0 text-[10px]">
            {PATTERN_LABELS[layer.pattern]}
          </span>
        </button>
        <span className="readout text-ash text-[10px]">
          {layer.delay > 0 ? `+${layer.delay.toFixed(2)}s` : "on break"}
        </span>
      </header>

      {open ? (
        <div className="border-seam flex flex-col gap-3 border-t px-2.5 py-3">
          <div className="flex items-center justify-between gap-2">
            <input
              value={layer.name}
              onChange={(event) => set("name", event.target.value.slice(0, 40))}
              aria-label="Layer name"
              className="border-seam text-paper focus:border-ember/60 min-w-0 flex-1 rounded-[3px] border bg-transparent px-2 py-1 text-[12px] outline-none"
            />
            <Toggle
              label="Live"
              checked={layer.enabled}
              onChange={(value) => set("enabled", value)}
            />
          </div>

          <Segmented
            label="Pattern"
            value={layer.pattern}
            options={PATTERNS}
            format={(pattern) => PATTERN_LABELS[pattern]}
            onChange={(pattern) => set("pattern", pattern)}
          />

          <Segmented
            label="Colour"
            value={layer.colorMode}
            options={COLOR_MODES}
            format={(mode) => COLOR_MODE_LABELS[mode]}
            onChange={(mode) => set("colorMode", mode)}
          />

          {layer.colorMode === "rainbow" ? (
            <p className="text-ash text-[11px]">
              Rainbow cycles the hue across the break; the swatches below are
              ignored.
            </p>
          ) : (
            <div className="flex flex-col gap-1.5">
              <ColorField
                label={
                  layer.colorMode === "bicolor" ? "First colour" : "Ignition"
                }
                value={layer.colorA}
                onChange={(value) => set("colorA", value)}
              />
              {layer.colorMode === "solid" ? null : (
                <ColorField
                  label={
                    layer.colorMode === "bicolor" ? "Second colour" : "Burnout"
                  }
                  value={layer.colorB}
                  onChange={(value) => set("colorB", value)}
                />
              )}
            </div>
          )}

          <div className="flex flex-col gap-2.5">
            <Slider
              label="Stars"
              value={layer.count}
              min={50}
              max={12000}
              step={50}
              onChange={(value) => set("count", Math.round(value))}
            />
            <Slider
              label="Break speed"
              value={layer.speed}
              min={1}
              max={40}
              step={0.5}
              unit=" m/s"
              onChange={(value) => set("speed", value)}
            />
            <Slider
              label="Speed spread"
              value={layer.speedJitter}
              min={0}
              max={1}
              step={0.01}
              onChange={(value) => set("speedJitter", value)}
            />
            <Slider
              label="Burn time"
              value={layer.life}
              min={0.2}
              max={7}
              step={0.05}
              unit="s"
              onChange={(value) => set("life", value)}
            />
            <Slider
              label="Burn spread"
              value={layer.lifeJitter}
              min={0}
              max={1}
              step={0.01}
              onChange={(value) => set("lifeJitter", value)}
            />
            <Slider
              label="Star size"
              value={layer.size}
              min={0.02}
              max={0.4}
              step={0.005}
              precision={3}
              onChange={(value) => set("size", value)}
            />
          </div>

          <div className="bg-seam h-px" />

          <div className="flex flex-col gap-2.5">
            <Slider
              label="Air drag"
              value={layer.drag}
              min={0}
              max={4}
              step={0.05}
              onChange={(value) => set("drag", value)}
            />
            <Slider
              label="Weight"
              value={layer.gravity}
              min={-0.5}
              max={2.5}
              step={0.05}
              unit="×"
              onChange={(value) => set("gravity", value)}
            />
            <Slider
              label="Twinkle"
              value={layer.sparkle}
              min={0}
              max={1}
              step={0.01}
              onChange={(value) => set("sparkle", value)}
            />
            <Slider
              label="Crackle"
              value={layer.glitter}
              min={0}
              max={1}
              step={0.01}
              onChange={(value) => set("glitter", value)}
            />
            <Slider
              label="Tail"
              value={layer.stretch}
              min={0}
              max={1}
              step={0.01}
              onChange={(value) => set("stretch", value)}
            />
            <Slider
              label="Swirl"
              value={layer.spin}
              min={-8}
              max={8}
              step={0.1}
              precision={1}
              onChange={(value) => set("spin", value)}
            />
          </div>

          <div className="bg-seam h-px" />

          <div className="flex flex-col gap-2.5">
            <Slider
              label="Fuse delay"
              value={layer.delay}
              min={0}
              max={3}
              step={0.05}
              unit="s"
              onChange={(value) => set("delay", value)}
            />
            <Slider
              label="Start radius"
              value={layer.startRadius}
              min={0}
              max={25}
              step={0.5}
              unit=" m"
              precision={1}
              onChange={(value) => set("startRadius", value)}
            />
            <Slider
              label="Launch drift"
              value={layer.inherit}
              min={0}
              max={1}
              step={0.01}
              onChange={(value) => set("inherit", value)}
            />
          </div>

          <div className="flex gap-2 pt-1">
            <DeskButton onClick={onDuplicate}>Duplicate</DeskButton>
            <DeskButton tone="danger" onClick={onDelete} disabled={!canDelete}>
              Remove
            </DeskButton>
          </div>
        </div>
      ) : null}
    </section>
  );
}
