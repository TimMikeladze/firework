"use client";

/**
 * The hand-held desk: one bottom sheet that carries every panel the wide
 * layout floats over the water.
 *
 * Three snap heights — peek (just the tab strip), half, and full — so the sky
 * is never buried under the controls. The grip drags between them and a tap
 * cycles them; a tab press opens the sheet, and pressing the active tab again
 * puts it away. Drag writes the height straight to the element and only
 * commits a snap on release, so the desk does not re-render per pixel.
 */

import {
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useRef,
} from "react";

export type SheetSnap = "peek" | "half" | "full";

export interface SheetTab<T extends string> {
  id: T;
  label: string;
}

/** Height of the tab strip, which is all a peeked sheet shows. */
const PEEK = 48;
/** Sky kept clear above a full sheet, for the masthead and a bit of water. */
const TOP_RESERVE = 104;
/** Pointer travel below which a grip press is a tap, not a drag. */
const TAP_SLOP = 6;

function snapHeights(viewport: number): Record<SheetSnap, number> {
  const full = Math.max(PEEK + 120, viewport - TOP_RESERVE);
  return {
    peek: PEEK,
    half: Math.min(full, Math.max(PEEK + 80, Math.round(viewport * 0.46))),
    full,
  };
}

export function Sheet<T extends string>({
  snap,
  onSnap,
  tabs,
  tab,
  onTab,
  actions,
  children,
}: {
  snap: SheetSnap;
  onSnap: (snap: SheetSnap) => void;
  tabs: readonly SheetTab<T>[];
  tab: T;
  onTab: (tab: T) => void;
  /** Buttons at the right end of the tab strip. */
  actions?: ReactNode;
  children: ReactNode;
}) {
  const sheetRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ startY: number; startHeight: number } | null>(null);

  /**
   * The space the sheet may grow into: whatever the parent column leaves
   * once the dock below it has taken its share.
   */
  const available = useCallback(() => {
    const sheet = sheetRef.current;
    const column = sheet?.parentElement;
    const main = column?.parentElement;
    if (!sheet || !column || !main) return 600;
    const dock = column.offsetHeight - sheet.offsetHeight;
    return main.clientHeight - dock;
  }, []);

  const apply = useCallback(
    (next: SheetSnap) => {
      const sheet = sheetRef.current;
      if (!sheet) return;
      sheet.style.height = `${snapHeights(available())[next]}px`;
    },
    [available],
  );

  // Follow the snap state, and re-fit when the viewport turns or the
  // browser chrome comes and goes.
  useEffect(() => {
    apply(snap);
    const refit = () => apply(snap);
    window.addEventListener("resize", refit);
    window.visualViewport?.addEventListener("resize", refit);
    return () => {
      window.removeEventListener("resize", refit);
      window.visualViewport?.removeEventListener("resize", refit);
    };
  }, [snap, apply]);

  const onGripDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const sheet = sheetRef.current;
    if (!sheet) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { startY: event.clientY, startHeight: sheet.offsetHeight };
    sheet.style.transition = "none";
  };

  const onGripMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const sheet = sheetRef.current;
    const state = drag.current;
    if (!sheet || !state) return;
    const heights = snapHeights(available());
    const next = Math.max(
      heights.peek,
      Math.min(
        heights.full,
        state.startHeight + (state.startY - event.clientY),
      ),
    );
    sheet.style.height = `${next}px`;
  };

  const onGripUp = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const sheet = sheetRef.current;
    const state = drag.current;
    drag.current = null;
    if (!sheet || !state) return;
    sheet.style.transition = "";

    const travel = state.startY - event.clientY;
    if (Math.abs(travel) < TAP_SLOP) {
      // A tap steps through the sizes; from full it puts the sheet away.
      const cycle: Record<SheetSnap, SheetSnap> = {
        peek: "half",
        half: "full",
        full: "peek",
      };
      const next = cycle[snap];
      onSnap(next);
      apply(next);
      return;
    }

    const heights = snapHeights(available());
    const height = state.startHeight + travel;
    let best: SheetSnap = "peek";
    for (const candidate of ["peek", "half", "full"] as const) {
      if (
        Math.abs(heights[candidate] - height) < Math.abs(heights[best] - height)
      ) {
        best = candidate;
      }
    }
    onSnap(best);
    apply(best);
  };

  const open = snap !== "peek";

  return (
    <div
      ref={sheetRef}
      className="border-seam bg-panel flex flex-col overflow-hidden rounded-t-[14px] border-x border-t backdrop-blur-md transition-[height] duration-300 ease-[cubic-bezier(0.16,1,0.3,1)]"
      style={{ height: PEEK }}
    >
      <div className="flex shrink-0 flex-col" style={{ height: PEEK }}>
        {/* Grip: the whole strip drags, the bar is just where to aim. */}
        <button
          type="button"
          aria-label={open ? "Resize or close the panel" : "Open the panel"}
          onPointerDown={onGripDown}
          onPointerMove={onGripMove}
          onPointerUp={onGripUp}
          onPointerCancel={() => {
            drag.current = null;
            if (sheetRef.current) sheetRef.current.style.transition = "";
            apply(snap);
          }}
          onClick={(event) => {
            // Pointer presses are handled on release above; this is the
            // keyboard's path in (detail is 0 for a synthesised click).
            if (event.detail === 0) onSnap(open ? "peek" : "half");
          }}
          className="flex h-[14px] w-full shrink-0 cursor-grab touch-none items-center justify-center active:cursor-grabbing"
        >
          <span className="bg-seam-bright block h-[4px] w-9 rounded-full" />
        </button>

        <div className="flex min-h-0 flex-1 items-center gap-1 px-2 pb-1">
          <div
            role="tablist"
            className="flex min-w-0 flex-1 gap-1"
            aria-label="Desk panels"
          >
            {tabs.map((entry) => {
              const active = entry.id === tab;
              return (
                <button
                  key={entry.id}
                  type="button"
                  role="tab"
                  aria-selected={active && open}
                  onClick={() => {
                    if (!open) {
                      onTab(entry.id);
                      onSnap("half");
                    } else if (active) {
                      onSnap("peek");
                    } else {
                      onTab(entry.id);
                    }
                  }}
                  className={`eyebrow h-full min-h-[30px] flex-1 rounded-[4px] text-[12px] transition-colors ${
                    active && open
                      ? "bg-ember/18 text-gold"
                      : active
                        ? "text-paper"
                        : "text-ash active:bg-riser"
                  }`}
                >
                  {entry.label}
                </button>
              );
            })}
          </div>
          {actions}
        </div>
      </div>

      <div
        className={`panel-scroll min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 pt-1 pb-4 ${
          open ? "" : "invisible"
        }`}
        aria-hidden={!open}
      >
        {children}
      </div>
    </div>
  );
}
