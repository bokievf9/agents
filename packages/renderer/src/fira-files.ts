import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FIRA_MANIFEST } from './fira-spec.js';

/** `assets/` of the package (next to `src` and `dist`). */
export const ASSETS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets');
export const FIRA_DIR = join(ASSETS_DIR, 'fira');

/** True when all 16 PNG files of the turtle are present. */
export const firaAvailable = (dir: string = FIRA_DIR): boolean => FIRA_MANIFEST.every((f) => existsSync(join(dir, f.replace(/^fira\//, ''))));

/** Copies the turtle PNG files into a public dir (the bundle serves them as `fira/*`). */
export function prepareFira(publicDir: string, dir: string = FIRA_DIR): void {
  const dst = join(publicDir, 'fira');
  mkdirSync(dst, { recursive: true });
  for (const f of FIRA_MANIFEST) {
    const name = f.replace(/^fira\//, '');
    if (existsSync(join(dir, name))) copyFileSync(join(dir, name), join(dst, name));
  }
}
