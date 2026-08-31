import type { Metadata, Viewport } from "next";
import { Archivo, Big_Shoulders, DM_Mono } from "next/font/google";
import "./globals.css";
import { UmamiAnalytics } from "@/components/UmamiAnalytics";

/** Signage condensed — panel headers and control labels. */
const bigShoulders = Big_Shoulders({
  variable: "--font-big-shoulders",
  subsets: ["latin"],
});

/** Industrial grotesk — everything you read as a sentence. */
const archivo = Archivo({
  variable: "--font-archivo",
  subsets: ["latin"],
});

/** Instrument readouts, so numbers hold their columns while you drag a slider. */
const dmMono = DM_Mono({
  variable: "--font-dm-mono",
  subsets: ["latin"],
  weight: ["400", "500"],
});

export const metadata: Metadata = {
  metadataBase: new URL("https://firework.sh"),
  title: "firework.sh",
  description:
    "A fireworks studio in the browser — design the burst, the colours, the physics, the timing, and fire it over the water, choreographed to your music.",
  authors: [{ name: "Tim Mikeladze", url: "https://linesofcode.dev" }],
  creator: "Tim Mikeladze",
  openGraph: {
    type: "website",
    url: "https://firework.sh",
    siteName: "firework.sh",
    title: "firework.sh",
    description:
      "A fireworks studio in the browser — design the burst, the colours, the physics, the timing, and fire it over the water, choreographed to your music.",
  },
  twitter: {
    card: "summary_large_image",
    site: "@linesofcode",
    creator: "@linesofcode",
    title: "firework.sh",
    description:
      "A fireworks studio in the browser — design the burst, the colours, the physics, the timing, and fire it over the water, choreographed to your music.",
  },
};

export const viewport: Viewport = {
  themeColor: "#08090b",
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  // Let the desk paint under the notch and the home indicator; the dock pads
  // itself with the safe-area insets.
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${bigShoulders.variable} ${archivo.variable} ${dmMono.variable} h-full antialiased`}
    >
      <body className="bg-void text-paper h-full overflow-hidden">
        {children}
        <UmamiAnalytics />
      </body>
    </html>
  );
}
