import { openDb } from '@fir/core';
import { RenderQueue } from '@fir/worker-content-maker';
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
const concurrency = Math.max(1, Number(process.env.RENDER_CONCURRENCY) || 2);

const log = (level: 'info' | 'warn' | 'error', msg: string, extra: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ t: new Date().toISOString(), level, svc: 'renderer', msg, ...extra }));

const db = openDb(join(dataDir, 'hq.db'));
db.pragma('busy_timeout = 5000');
const queue = new RenderQueue(db);
const stale = queue.recoverStale();
if (stale) log('warn', 'recovered jobs left running', { n: stale });

const bundle = new BundleCache((m) => log('info', m));
const tts = noTts ? null : ttsEnvFrom();
log('info', 'renderer started', { pollSeconds: pollMs / 1000, voice: tts?.voice ?? 'off', concurrency });

const ac = new AbortController();
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => ac.abort());

await runLoop(
  {
    db, queue, now: Date.now, timeoutMs, log,
    render: async (job, script) => {
      const out = join(dataDir, 'renders', String(job.itemId), 'reel.mp4');
      const r = await renderReel(script, bundle, { outFile: out, tts, concurrency, timeoutMs, jobKey: String(job.id), log: (m) => log('info', m, { job: job.id }) });
      log('info', 'reel written', { job: job.id, item: job.itemId, bytes: r.bytes, seconds: Math.round(r.seconds), voiced: r.voiced });
      return r.path;
    },
  },
  pollMs,
  ac.signal,
);
db.close();
