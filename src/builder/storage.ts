/**
 * Saved shells live in localStorage. The key carries a version so a future
 * format change can be ignored rather than crash — `parseShell` already clamps
 * anything it does not recognise.
 */

import { parseShell, type ShellSpec } from "./spec";

const KEY = "fireworks-builder/shells@1";
const LAST_KEY = "fireworks-builder/last@1";

export function loadSavedShells(): ShellSpec[] {
  if (typeof localStorage === "undefined") return [];
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map(parseShell);
  } catch {
    return [];
  }
}

function persist(shells: ShellSpec[]): ShellSpec[] {
  if (typeof localStorage !== "undefined") {
    try {
      localStorage.setItem(KEY, JSON.stringify(shells));
    } catch {
      // Quota or a private window — the session still works, just unsaved.
    }
  }
  return shells;
}

/** Inserts or replaces by id, newest first. */
export function saveShell(spec: ShellSpec): ShellSpec[] {
  const shells = loadSavedShells().filter((shell) => shell.id !== spec.id);
  shells.unshift(spec);
  return persist(shells.slice(0, 60));
}

export function deleteShell(id: string): ShellSpec[] {
  return persist(loadSavedShells().filter((shell) => shell.id !== id));
}

/** The shell the user had open, restored on the next visit. */
export function rememberLast(spec: ShellSpec): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(LAST_KEY, JSON.stringify(spec));
  } catch {
    // Ignored: losing the draft is not worth interrupting the session.
  }
}

export function loadLast(): ShellSpec | null {
  if (typeof localStorage === "undefined") return null;
  try {
    const raw = localStorage.getItem(LAST_KEY);
    return raw ? parseShell(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}
