// Rasterises the committed Fira SVGs (assets/fira/svg/<emotion>-<accessory>.svg, copied from firtech's
// fira-fallback7 by scripts/fira-export-svg.tsx) to transparent 1024 px PNGs in assets/fira/. No firtech checkout is needed at build time.
// Usage: node scripts/fira-assets.mjs
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { URL, fileURLToPath } from 'node:url';
import process from 'node:process';
import { Resvg } from '@resvg/resvg-js';

const root = fileURLToPath(new URL('../assets/fira/', import.meta.url));
const svgDir = join(root, 'svg');
mkdirSync(root, { recursive: true });
let n = 0;
for (const f of readdirSync(svgDir).filter((x) => x.endsWith('.svg')).sort()) {
  const png = new Resvg(readFileSync(join(svgDir, f)), { fitTo: { mode: 'width', value: 1024 }, font: { loadSystemFonts: true } }).render().asPng();
  writeFileSync(join(root, f.replace(/\.svg$/, '.png')), png);
  n++;
}
process.stdout.write(`fira assets: ${n} PNG files in ${root}` + '\n');
