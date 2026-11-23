import { statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseReel } from '@fir/worker-content-maker';
import { readFileSync } from 'node:fs';
import { BundleCache, renderReel } from './job.js';
import { SAMPLE_SCRIPT } from './sample-script.js';
import { ttsEnvFrom } from './tts.js';

/**
 * `pnpm --filter renderer render:sample [out.mp4] [script.txt]`: renders the sample reel (or a content-maker text file)
 * on this machine. `RENDER_NO_TTS=1` skips the voice; otherwise Piper must be installed (`PIPER_BIN`, `PIPER_VOICES_DIR`).
 */
const out = resolve(process.argv[2] ?? join(fileURLToPath(new URL('../out/', import.meta.url)), 'sample.mp4'));
const script = process.argv[3] ? (parseReel(readFileSync(resolve(process.argv[3]), 'utf8')) ?? SAMPLE_SCRIPT) : SAMPLE_SCRIPT;
const tts = process.env.RENDER_NO_TTS === '1' ? null : ttsEnvFrom();
const log = (m: string) => console.log(m);
const t0 = Date.now();
log(`voice: ${tts ? tts.voice : 'off (RENDER_NO_TTS=1)'}`);
const r = await renderReel(script, new BundleCache(log), { outFile: out, tts, concurrency: Number(process.env.RENDER_CONCURRENCY) || 1, timeoutMs: 600_000, jobKey: 'sample', sfx: (process.env.RENDER_SFX ?? 'on').toLowerCase() !== 'off', fira: (process.env.RENDER_FIRA ?? 'on').toLowerCase() !== 'off', log });
console.log(`done: ${r.path}\n  ${(statSync(r.path).size / 1e6).toFixed(2)} MB, video ${r.seconds.toFixed(1)} s, voiced ${r.voiced}, rendered in ${Math.round((Date.now() - t0) / 1000)} s`);
