// Copies the brand fonts of the content-maker into .public/fonts for Remotion Studio and the sample render.
import { copyFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { URL, fileURLToPath } from 'node:url';

const src = fileURLToPath(new URL('../../workers/content-maker/assets/fonts/', import.meta.url));
const dst = fileURLToPath(new URL('../.public/fonts/', import.meta.url));
mkdirSync(dst, { recursive: true });
for (const f of readdirSync(src)) if (/\.(woff2?|ttf)$/.test(f)) copyFileSync(join(src, f), join(dst, f));
