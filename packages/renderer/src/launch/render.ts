import { copyFileSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BundleCache } from '../job.js';
import { synthesize, ttsEnvFrom, type TtsEnv } from '../tts.js';
import { COPY, VO_IDS, launchSpeakable, parseLaunchScript, type Lang } from './copy.js';
import { VOICE_OFFSET, VOICE_TAIL, beatsOf, totalFramesOf, voiceRoom, type LaunchProps, type LaunchVoice, type Variant } from './plan.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const scriptPath = (lang: Lang): string => join(ROOT, 'scripts', `launch-${lang}.txt`);
export const compositionId = (v: Variant): string => (v === 'film' ? 'LaunchFilm' : 'LaunchTeaser');

export function readLaunchScript(lang: Lang): Record<string, string> {
  const vo = parseLaunchScript(readFileSync(scriptPath(lang), 'utf8'));
  for (const id of VO_IDS) if (!vo[id]) vo[id] = COPY[lang].vo[id];
  return vo;
}

/** Voice for every beat of a variant: Piper at normal speed, re-run faster (down to 0.8) when the line does not fit its beat. */
export async function synthLaunchVoice(variant: Variant, lang: Lang, vo: Record<string, string>, tts: TtsEnv, dir: string, rel: string, log: (m: string) => void): Promise<Record<string, LaunchVoice>> {
  mkdirSync(dir, { recursive: true });
  const out: Record<string, LaunchVoice> = {};
  for (const b of beatsOf(variant)) {
    const text = launchSpeakable(vo[b.vo]!, lang);
    const file = join(dir, `${b.id}.wav`);
    let sec = await synthesize(text, file, tts);
    const room = voiceRoom(b) / 30;
    let scale = 1;
    if (sec > room) {
      scale = Math.max(0.8, Math.round((room / sec) * 0.97 * 100) / 100);
      sec = await synthesize(text, file, tts, scale);
    }
    const note = sec > room ? ` OVERRUNS its beat by ${(sec - room).toFixed(2)} s` : '';
    log(`voice ${b.id}: ${sec.toFixed(2)} s of ${room.toFixed(2)} s${scale < 1 ? ` (length-scale ${scale})` : ''}${note}`);
    out[b.id] = { src: `${rel}/${b.id}.wav`, frames: Math.min(Math.ceil(sec * 30), voiceRoom(b) + VOICE_TAIL - 2) };
  }
  return out;
}

export interface LaunchRender {
  variant: Variant;
  lang: Lang;
  outFile: string;
  tts: TtsEnv | null;
  musicFile?: string | undefined;
  musicVolume?: number;
  concurrency?: number;
  log?: (m: string) => void;
}

export async function renderLaunch(bundle: BundleCache, o: LaunchRender): Promise<{ path: string; seconds: number; bytes: number; voiced: boolean }> {
  const log = o.log ?? (() => {});
  const serveUrl = await bundle.get();
  const key = `launch-${o.variant}-${o.lang}`;
  const dir = join(serveUrl, 'public', 'jobs', key);
  try {
    const vo = readLaunchScript(o.lang);
    const voice = o.tts ? await synthLaunchVoice(o.variant, o.lang, vo, o.tts, dir, `jobs/${key}`, log) : {};
    let musicPath: string | null = null;
    if (o.musicFile) {
      mkdirSync(join(serveUrl, 'public', 'music'), { recursive: true });
      copyFileSync(o.musicFile, join(serveUrl, 'public', 'music', basename(o.musicFile)));
      musicPath = `music/${basename(o.musicFile)}`;
    }
    const props: LaunchProps = { lang: o.lang, vo, voice, sfx: (process.env.RENDER_SFX ?? 'on').toLowerCase() !== 'off', musicPath, musicVolume: o.musicVolume ?? 0.35, captions: true };
    const { ensureBrowser, renderMedia, selectComposition } = await import('@remotion/renderer');
    await ensureBrowser();
    const inputProps = props as unknown as Record<string, unknown>;
    const composition = await selectComposition({ serveUrl, id: compositionId(o.variant), inputProps });
    mkdirSync(dirname(o.outFile), { recursive: true });
    const tmp = `${o.outFile}.part.mp4`;
    let last = -1;
    await renderMedia({
      composition, serveUrl, inputProps, codec: 'h264', videoBitrate: '4M', audioBitrate: '192k', outputLocation: tmp, concurrency: o.concurrency ?? 2,
      onProgress: ({ progress }) => {
        const pct = Math.floor(progress * 4) * 25;
        if (pct !== last) {
          last = pct;
          log(`${key} render ${pct}%`);
        }
      },
    });
    const { renameSync } = await import('node:fs');
    renameSync(tmp, o.outFile);
    return { path: o.outFile, seconds: totalFramesOf(o.variant) / 30, bytes: statSync(o.outFile).size, voiced: o.tts !== null };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Used by tests: first frame of the voice of a beat. */
export const voiceStart = (b: { kind: keyof typeof VOICE_OFFSET; start: number }): number => b.start + VOICE_OFFSET[b.kind];

// ---- CLI: `pnpm --filter renderer render:launch [--lang ru|en] [--out dir] [--music file] [--only film|teaser]` -------------------
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = (n: string) => {
    const i = process.argv.indexOf(`--${n}`);
    return i >= 0 ? process.argv[i + 1] : undefined;
  };
  const lang = (arg('lang') ?? 'ru') as Lang;
  const outDir = resolve(arg('out') ?? join(ROOT, 'out'));
  const musicFile = arg('music') ?? process.env.LAUNCH_MUSIC;
  const only = arg('only') as Variant | undefined;
  const log = (m: string) => console.log(m);
  // Only a Russian Piper voice ships; an English one is used when PIPER_VOICE_EN names an installed model.
  const voiceName = lang === 'en' ? process.env.PIPER_VOICE_EN : undefined;
  const base = ttsEnvFrom();
  const tts: TtsEnv | null = process.env.RENDER_NO_TTS === '1' || (lang === 'en' && !voiceName) ? null : { ...base, voice: voiceName ?? base.voice };
  log(`lang ${lang}, voice: ${tts ? tts.voice : lang === 'en' ? 'off (no English Piper voice, set PIPER_VOICE_EN)' : 'off (RENDER_NO_TTS=1)'}, music: ${musicFile ?? 'none'}`);
  const bundle = new BundleCache(log);
  for (const variant of (only ? [only] : ['film', 'teaser']) as Variant[]) {
    const outFile = join(outDir, variant === 'film' ? `launch-${lang}.mp4` : `launch-teaser-${lang}.mp4`);
    const t0 = Date.now();
    const r = await renderLaunch(bundle, { variant, lang, outFile, tts, musicFile: musicFile ? resolve(musicFile) : undefined, concurrency: Number(process.env.RENDER_CONCURRENCY) || 2, log });
    log(`done ${r.path}: ${(r.bytes / 1e6).toFixed(2)} MB, ${r.seconds.toFixed(1)} s, voiced ${r.voiced}, rendered in ${Math.round((Date.now() - t0) / 1000)} s`);
  }
}
