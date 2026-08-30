/**
 * Umami page analytics — optional, and off unless configured.
 *
 * The whole feature hangs off one variable: with no `NEXT_PUBLIC_UMAMI_WEBSITE_ID`
 * nothing renders, no third-party script is fetched, and the app behaves exactly
 * as it did before. Local development, forks, and anyone running the show off a
 * clone stay free of a dependency on someone else's analytics instance.
 *
 * The values are read as literal `process.env.NEXT_PUBLIC_*` property accesses
 * at the call site, because that is the only form Next inlines into the client
 * bundle at build time — a dynamic lookup (`process.env[name]`) reaches the
 * browser as `undefined`. Being build-time inlined also means changing them on
 * Vercel needs a redeploy, not just a restart.
 */

/** The instance this project ships against; override with the script URL var. */
const DEFAULT_SCRIPT_URL = "https://linesofcode-umami.vercel.app/script.js";

export interface UmamiConfig {
  /** The website's UUID in the Umami dashboard. */
  websiteId: string;
  /** Absolute URL of the tracker script. */
  scriptUrl: string;
  /**
   * Comma-separated hostnames the tracker will report from. Left unset, every
   * deployment counts — including each Vercel preview URL, which pollutes the
   * numbers for the domain people actually visit.
   */
  domains?: string;
}

export interface UmamiEnv {
  websiteId?: string;
  scriptUrl?: string;
  domains?: string;
}

/**
 * Accepts either the script URL or the instance's origin, since the dashboard
 * shows the former and people remember the latter.
 */
function normalizeScriptUrl(value: string): string {
  const trimmed = value.replace(/\/+$/, "");
  return trimmed.endsWith(".js") ? trimmed : `${trimmed}/script.js`;
}

/** Returns null when analytics is not configured, which is a valid state. */
export function resolveUmamiConfig(env: UmamiEnv): UmamiConfig | null {
  const websiteId = env.websiteId?.trim();
  if (!websiteId) return null;

  const scriptUrl = env.scriptUrl?.trim();
  const domains = env.domains?.trim();

  return {
    websiteId,
    scriptUrl: scriptUrl ? normalizeScriptUrl(scriptUrl) : DEFAULT_SCRIPT_URL,
    ...(domains ? { domains } : {}),
  };
}

/** The configuration this build was compiled with, or null when it has none. */
export const umamiConfig = resolveUmamiConfig({
  websiteId: process.env.NEXT_PUBLIC_UMAMI_WEBSITE_ID,
  scriptUrl: process.env.NEXT_PUBLIC_UMAMI_SCRIPT_URL,
  domains: process.env.NEXT_PUBLIC_UMAMI_DOMAINS,
});

interface UmamiTracker {
  track: (event: string, data?: Record<string, unknown>) => void;
}

/**
 * Records a custom event, and does nothing when analytics is off or the script
 * has not loaded yet. Callers should never have to check either.
 */
export function trackEvent(event: string, data?: Record<string, unknown>) {
  if (!umamiConfig || typeof window === "undefined") return;
  const umami = (window as { umami?: UmamiTracker }).umami;
  umami?.track(event, data);
}
