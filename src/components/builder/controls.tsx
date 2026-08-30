"use client";

/** The instrument set: every control on the firing desk is built from these. */

import { type ReactNode, useId } from "react";

export function Eyebrow({ children }: { children: ReactNode }) {
  return <span className="eyebrow text-ash text-[11px]">{children}</span>;
}

/** A hairline seam between control groups, the way panel sections are divided. */
export function Seam() {
  return <div className="bg-seam h-px w-full" />;
}

export function Lamp({ on, live }: { on: boolean; live?: boolean }) {
  return (
    <span
      aria-hidden
      className={`inline-block size-[7px] rounded-full transition-colors ${
        on ? "bg-lamp" : "bg-seam-bright"
      } ${on && live ? "lamp-live" : ""}`}
      style={on && !live ? { boxShadow: "0 0 8px 1px #ff8a3d99" } : undefined}
    />
  );
}

export interface SliderProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  /** Appended to the readout, e.g. `m`, `s`, `×`. */
  unit?: string;
  /** Decimal places in the readout. Defaults to 2 for sub-unit steps. */
  precision?: number;
  onChange: (value: number) => void;
}

export function Slider({
  label,
  value,
  min,
  max,
  step = 0.01,
  unit,
  precision,
  onChange,
}: SliderProps) {
  const id = useId();
  const digits = precision ?? (step >= 1 ? 0 : step >= 0.1 ? 1 : 2);
  const fill = ((value - min) / (max - min)) * 100;

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between gap-2">
        <label htmlFor={id} className="text-ash text-[11px] tracking-wide">
          {label}
        </label>
        <span className="readout text-paper text-[11px]">
          {value.toFixed(digits)}
          {unit ? <span className="text-ash">{unit}</span> : null}
        </span>
      </div>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        style={{ "--fill": `${fill}%` } as React.CSSProperties}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </div>
  );
}

export interface SegmentedProps<T extends string> {
  label?: string;
  value: T;
  options: readonly T[];
  /** Renders the display text for an option; defaults to the value itself. */
  format?: (option: T) => string;
  onChange: (value: T) => void;
}

export function Segmented<T extends string>({
  label,
  value,
  options,
  format,
  onChange,
}: SegmentedProps<T>) {
  return (
    <div className="flex flex-col gap-1.5">
      {label ? (
        <span className="text-ash text-[11px] tracking-wide">{label}</span>
      ) : null}
      <div className="border-seam flex flex-wrap gap-px overflow-hidden rounded-[3px] border">
        {options.map((option) => {
          const active = option === value;
          return (
            <button
              key={option}
              type="button"
              aria-pressed={active}
              onClick={() => onChange(option)}
              className={`grow px-2 py-1 text-[11px] whitespace-nowrap transition-colors ${
                active
                  ? "bg-ember/18 text-gold"
                  : "text-ash hover:bg-riser hover:text-paper"
              }`}
            >
              {format ? format(option) : option}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function ColorField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const id = useId();
  return (
    <div className="flex items-center justify-between gap-2">
      <label htmlFor={id} className="text-ash text-[11px] tracking-wide">
        {label}
      </label>
      <div className="flex items-center gap-2">
        <span className="readout text-ash text-[10px] uppercase">{value}</span>
        <input
          id={id}
          type="color"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          className="h-6 w-9 rounded-[3px]"
        />
      </div>
    </div>
  );
}

export function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className="group flex items-center gap-2 text-[11px]"
    >
      <span
        className={`border-seam-bright flex h-[14px] w-[26px] items-center rounded-full border px-[2px] transition-colors ${
          checked ? "bg-ember/30" : "bg-riser"
        }`}
      >
        <span
          className={`size-[8px] rounded-full transition-transform ${
            checked ? "bg-gold translate-x-[12px]" : "bg-seam-bright"
          }`}
        />
      </span>
      <span className={checked ? "text-paper" : "text-ash"}>{label}</span>
    </button>
  );
}

export function DeskButton({
  children,
  onClick,
  tone = "quiet",
  title,
  disabled,
}: {
  children: ReactNode;
  onClick: () => void;
  tone?: "quiet" | "primary" | "danger";
  title?: string;
  disabled?: boolean;
}) {
  const tones = {
    quiet: "border-seam text-ash hover:border-seam-bright hover:text-paper",
    primary: "border-ember/60 bg-ember/15 text-gold hover:bg-ember/25",
    danger: "border-seam text-ash hover:border-ember/60 hover:text-ember",
  } as const;

  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={`rounded-[3px] border px-2.5 py-1 text-[11px] transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${tones[tone]}`}
    >
      {children}
    </button>
  );
}

/** A masthead credit link. Underlined on hover so it reads as a link, not a label. */
export function Credit({
  href,
  children,
}: {
  href: string;
  children: ReactNode;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="hover:text-gold underline decoration-transparent underline-offset-2 transition-colors hover:decoration-current"
    >
      {children}
    </a>
  );
}
