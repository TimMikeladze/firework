"use client";

/** The rack: stock shells to start from, and the ones you have saved. */

import type { ShellSpec } from "@/builder/spec";
import { DeskButton, Eyebrow } from "./controls";

function ShellRow({
  shell,
  active,
  onLoad,
  onDelete,
}: {
  shell: ShellSpec;
  active: boolean;
  onLoad: () => void;
  onDelete?: () => void;
}) {
  const lead = shell.layers.find((layer) => layer.enabled) ?? shell.layers[0];
  const layerCount = shell.layers.filter((layer) => layer.enabled).length;

  return (
    <div
      className={`group pointer-coarse:py-2 flex items-center gap-2 rounded-[3px] border px-2 py-1.5 transition-colors ${
        active
          ? "border-ember/50 bg-ember/10"
          : "border-transparent hover:border-seam hover:bg-riser/70"
      }`}
    >
      <span
        aria-hidden
        className="size-3 shrink-0 rounded-full"
        style={{
          background: `radial-gradient(circle at 35% 35%, ${lead?.colorA ?? "#fff"}, ${
            lead?.colorB ?? "#f60"
          })`,
          boxShadow: `0 0 8px ${lead?.colorA ?? "#fff"}55`,
        }}
      />
      <button
        type="button"
        onClick={onLoad}
        className="pointer-coarse:min-h-10 min-w-0 flex-1 text-left"
        title={`Load ${shell.name}`}
      >
        <span className="text-paper block truncate text-[12px]">
          {shell.name}
        </span>
        <span className="text-ash readout block text-[10px]">
          {layerCount} layer{layerCount === 1 ? "" : "s"} ·{" "}
          {shell.launch.height.toFixed(0)}m
        </span>
      </button>
      {onDelete ? (
        <button
          type="button"
          onClick={onDelete}
          title={`Delete ${shell.name}`}
          // Revealed on hover where there is a pointer to hover with; always
          // there under a finger, which cannot.
          className="text-ash hover:text-ember pointer-coarse:min-h-10 pointer-coarse:min-w-10 pointer-coarse:text-[16px] px-1 text-[13px] opacity-70 transition group-hover:opacity-100 focus-visible:opacity-100 [@media(hover:hover)]:opacity-0"
        >
          ×
        </button>
      ) : null}
    </div>
  );
}

export function ShellRack({
  presets,
  saved,
  activeId,
  onLoad,
  onDelete,
  onImport,
  onExport,
}: {
  presets: readonly ShellSpec[];
  saved: readonly ShellSpec[];
  activeId: string;
  onLoad: (shell: ShellSpec) => void;
  onDelete: (id: string) => void;
  onImport: () => void;
  onExport: () => void;
}) {
  return (
    <div className="flex h-full flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        <Eyebrow>Stock fireworks</Eyebrow>
        <div className="flex flex-col gap-0.5">
          {presets.map((shell) => (
            <ShellRow
              key={shell.id}
              shell={shell}
              active={shell.id === activeId}
              onLoad={() => onLoad(shell)}
            />
          ))}
        </div>
      </div>

      <div className="bg-seam h-px" />

      <div className="flex min-h-0 flex-1 flex-col gap-1.5">
        <div className="flex items-center justify-between">
          <Eyebrow>Your rack</Eyebrow>
          <span className="readout text-ash text-[10px]">{saved.length}</span>
        </div>
        {saved.length === 0 ? (
          <p className="text-ash text-[11px] leading-relaxed">
            Nothing saved yet. Tune a firework and press Save to keep it here.
          </p>
        ) : (
          <div className="panel-scroll flex flex-col gap-0.5 overflow-y-auto">
            {saved.map((shell) => (
              <ShellRow
                key={shell.id}
                shell={shell}
                active={shell.id === activeId}
                onLoad={() => onLoad(shell)}
                onDelete={() => onDelete(shell.id)}
              />
            ))}
          </div>
        )}
      </div>

      <div className="flex gap-2">
        <DeskButton onClick={onExport}>Copy JSON</DeskButton>
        <DeskButton onClick={onImport}>Paste JSON</DeskButton>
      </div>
    </div>
  );
}
