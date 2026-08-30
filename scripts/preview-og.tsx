/**
 * Renders the social card to a file so it can be looked at without a build.
 *
 * It calls the route itself, so what lands on disk is byte-for-byte what
 * `next build` will bake into `/opengraph-image`.
 *
 *   bun scripts/preview-og.tsx [out.png]
 */

import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import Image from "../src/app/opengraph-image";

const out = resolve(process.argv[2] ?? "public/og/card-preview.png");
const response = await Image();
const bytes = Buffer.from(await response.arrayBuffer());
await writeFile(out, bytes);
console.log(`wrote ${out} — ${(bytes.length / 1024).toFixed(0)} KB`);
