import Script from "next/script";
import { umamiConfig } from "@/analytics/umami";

/**
 * Loads the Umami tracker, or renders nothing when it is not configured.
 *
 * `afterInteractive` keeps a third-party request off the critical path: this
 * page spends its first seconds compiling shaders and warming a WebGPU device,
 * and a page view recorded a moment late still counts.
 */
export function UmamiAnalytics() {
  if (!umamiConfig) return null;

  return (
    <Script
      src={umamiConfig.scriptUrl}
      strategy="afterInteractive"
      data-website-id={umamiConfig.websiteId}
      {...(umamiConfig.domains ? { "data-domains": umamiConfig.domains } : {})}
    />
  );
}
