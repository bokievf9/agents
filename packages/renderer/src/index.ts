import os from 'node:os';
import { openDb } from '@fir/core';
import { RenderQueue } from '@fir/worker-content-maker';
import { utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BundleCache, renderReel } from './job.js';
import { runLoop } from './loop.js';
import { ttsEnvFrom } from './tts.js';

/**
 * The renderer service: polls `cm_render_jobs` in the HQ database, renders one reel at a time with Remotion + Piper and
 * writes `DATA_DIR/renders/<item>/reel.mp4`. One process only (compose runs exactly one container).
 */
const dataDir = process.env.DATA_DIR || './data';
const pollMs = Math.max(2, Number(process.env.RENDERER_POLL_SECONDS) || 20) * 1000;
const timeoutMs = (Number(process.env.RENDER_TIMEOUT_SECONDS) || 600) * 1000;
const noTts = process.env.RENDER_NO_TTS === '1';
// Remotion refuses a concurrency above the visible core count (the container is capped by `cpus:` in compose), so the
// wish from the env is clamped to what this machine actually has.
const cores = Math.max(1, typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length);
const concurrency = Math.min(Math.max(1, Number(process.env.RENDER_CONCURRENCY) || 1), cores);
/** `RENDER_SFX=off`: reels without the sound-effect layer. */
const sfx = (process.env.RENDER_SFX ?? 'on').toLowerCase() !== 'off';
/** `RENDER_FIRA=off`: reels without the Fira sticker (default on for Fir Tech's own channels). */
const fira = (process.env.RENDER_FIRA ?? 'on').toLowerCase() !== 'off';

const log = (level: 'info' | 'warn' | 'error', msg: string, extra: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ t: new Date().toISOString(), level, svc: 'renderer', msg, ...extra }));

const db = openDb(join(dataDir, 'hq.db'));
db.pragma('busy_timeout = 5000');
const queue = new RenderQueue(db);
const stale = queue.recoverStale();
if (stale) log('warn', 'recovered jobs left running', { n: stale });

const bundle = new BundleCache((m) => log('info', m));
const tts = noTts ? null : ttsEnvFrom();
log('info', 'renderer started', { pollSeconds: pollMs / 1000, voice: tts?.voice ?? 'off', concurrency, sfx, fira });

// Heartbeat for the Docker healthcheck and the HQ monitoring: touched every 30 s, also during a long render.
const beatFile = join(dataDir, 'renderer.heartbeat');
const beat = () => {
  try {
    const now = new Date();
    try { utimesSync(beatFile, now, now); } catch { writeFileSync(beatFile, String(now.getTime())); }
  } catch (e) {
    log('warn', 'heartbeat file not written', { err: e instanceof Error ? e.message : String(e) });
  }
};
beat();
setInterval(beat, 30_000).unref();

const ac = new AbortController();
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => ac.abort());

await runLoop(
  {
    db, queue, now: Date.now, timeoutMs, log,
    render: async (job, script) => {
      const out = join(dataDir, 'renders', String(job.itemId), 'reel.mp4');
      const r = await renderReel(script, bundle, { outFile: out, tts, concurrency, timeoutMs, jobKey: String(job.id), sfx, fira, log: (m) => log('info', m, { job: job.id }) });
      log('info', 'reel written', { job: job.id, item: job.itemId, bytes: r.bytes, seconds: Math.round(r.seconds), voiced: r.voiced });
      return r.path;
    },
  },
  pollMs,
  ac.signal,
);
db.close();
