"use client";

import { useEffect, useRef } from "react";

interface Props {
  /** Peak envelope, 0..1 per bucket. */
  data: Float32Array | number[] | null;
  /** 0..1 playback/analysis position; draws a progress split when set. */
  progress?: number;
  className?: string;
  color?: string;
  dimColor?: string;
  height?: number;
}

/**
 * Small canvas waveform. Used for the import preview during analysis and as the
 * thumbnail in the song list.
 */
export default function Waveform({
  data,
  progress,
  className,
  color = "rgba(255,210,140,0.9)",
  dimColor = "rgba(255,255,255,0.18)",
  height = 48,
}: Props) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    if (!data || data.length === 0) {
      // Flat line placeholder while decoding hasn't produced samples yet.
      ctx.fillStyle = dimColor;
      ctx.fillRect(0, h / 2 - 0.5, w, 1);
      return;
    }

    const n = data.length;
    const mid = h / 2;
    // One column per pixel; each column takes the peak of the buckets it covers.
    const cols = Math.max(1, Math.floor(w));
    const per = n / cols;
    const cut = progress === undefined ? cols : Math.round(progress * cols);

    for (let i = 0; i < cols; i++) {
      let peak = 0;
      const start = Math.floor(i * per);
      const end = Math.min(n, Math.floor((i + 1) * per) + 1);
      for (let j = start; j < end; j++) {
        const v = Math.abs(data[j] ?? 0);
        if (v > peak) peak = v;
      }
      const amp = Math.max(0.5, peak * mid * 1.6);
      ctx.fillStyle = i <= cut ? color : dimColor;
      ctx.fillRect(i, mid - amp, 1, amp * 2);
    }
  }, [data, progress, color, dimColor]);

  return (
    <canvas ref={ref} className={className} style={{ height, width: "100%" }} />
  );
}
