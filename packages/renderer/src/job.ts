import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { WebpackOverrideFn } from '@remotion/bundler';
import { FONT_DIR, type ReelScript } from '@fir/worker-content-maker';
import { firaAvailable, prepareFira } from './fira-files.js';
import type { FiraBrand } from './fira-spec.js';
import type { ReelProps } from './props.js';
import { planSfx, prepareSfx, sfxAvailable } from './sfx.js';
import { speakable, synthesize, type TtsEnv } from './tts.js';
import { buildTimeline, estimateVoiceSec, type SceneInput } from './timing.js';

const REMOTION_DIR = join(dirname(fileURLToPath(import.meta.url)), 'remotion');
/** Source run (tsx, dev) bundles the .ts entry; the built image bundles the compiled .js one. */
const ENTRY = join(REMOTION_DIR, existsSync(join(REMOTION_DIR, 'index.ts')) ? 'index.ts' : 'index.js');

/** NodeNext sources import `./Reel.js`; webpack must find `Reel.tsx` for it. */
export const aliasJs: WebpackOverrideFn = (config) => ({ ...config, resolve: { ...config.resolve, extensionAlias: { '.js': ['.tsx', '.ts', '.js'] } } });

export interface RenderOptions {
  /** `DATA_DIR/renders/<item>/reel.mp4`. */
  outFile: string;
  /** Piper settings; null: no voice (`RENDER_NO_TTS=1`), the scene lengths come from the script. */
  tts: TtsEnv | null;
  concurrency: number;
  timeoutMs: number;
  /** Unique per job: names the folder of the job's WAV files inside the bundle. */
  jobKey: string;
  /** `false`: no sound effects under the voice (whoosh on scene changes, pop on text, hit on the final card). Default on. */
  sfx?: boolean;
  /** The turtle sticker: default on (when the PNG files are there) with the caption's first line as the bubble; `false` (or `RENDER_FIRA=off`) none; an object overrides parts. */
  fira?: FiraBrand;
  log?: (msg: string) => void;
}

export interface RenderResult {
  path: string;
  bytes: number;
  seconds: number;
  voiced: boolean;
}

/** Copies the brand fonts into a public dir (the bundle serves them as `fonts/*`). */
export function prepareFonts(publicDir: string): void {
  const dst = join(publicDir, 'fonts');
  mkdirSync(dst, { recursive: true });
  for (const f of readdirSync(FONT_DIR)) if (/\.(woff2?|ttf)$/.test(f)) copyFileSync(join(FONT_DIR, f), join(dst, f));
}

/** The Remotion bundle, built once per process and reused by every job (webpack is the memory-hungry step). */
export class BundleCache {
  private serveUrl: Promise<string> | null = null;
  constructor(private readonly log: (m: string) => void = () => {}) {}

  get(): Promise<string> {
    this.serveUrl ??= this.build().catch((e) => {
      this.serveUrl = null;
      throw e;
    });
    return this.serveUrl;
  }

  private async build(): Promise<string> {
    const { bundle } = await import('@remotion/bundler');
    const root = join(tmpdir(), 'fir-reel-bundle');
    rmSync(root, { recursive: true, force: true });
    const publicDir = join(root, 'public-src');
    prepareFonts(publicDir);
    prepareSfx(publicDir);
    prepareFira(publicDir);
    this.log('bundling composition');
    return bundle({ entryPoint: ENTRY, publicDir, outDir: join(root, 'bundle'), webpackOverride: aliasJs });
  }
}

/** Folder inside the bundle where a job's audio goes; `staticFile('jobs/<key>/v0.wav')` reads it. */
const jobDir = (serveUrl: string, key: string) => join(serveUrl, 'public', 'jobs', key);

/** Voice per scene, timeline, props. Exported separately so the sample and tests can build props without Chrome. */
export async function buildProps(script: ReelScript, opts: { tts: TtsEnv | null; dir: string; rel: string; sfx?: boolean; fira?: FiraBrand; log?: (m: string) => void }): Promise<{ props: ReelProps; voiced: boolean }> {
  const log = opts.log ?? (() => {});
  const useVoice = opts.tts !== null && script.lang === 'ru';
  if (opts.tts !== null && !useVoice) log('English script: no voice (only the Russian Piper voice is installed), subtitles from the script timing');
  const audio: (string | null)[] = [];
  const scenes: SceneInput[] = [];
  mkdirSync(opts.dir, { recursive: true });
  for (const [i, s] of script.scenes.entries()) {
    if (useVoice) {
      const sec = await synthesize(speakable(s.voice), join(opts.dir, `v${i}.wav`), opts.tts!);
      scenes.push({ voiceSec: sec });
      audio.push(`${opts.rel}/v${i}.wav`);
    } else {
      scenes.push({ voiceSec: opts.tts === null ? estimateVoiceSec(s.voice) : null });
      audio.push(null);
    }
  }
  const ctaText = speakable(script.cta);
  let ctaSec: number | null = null;
  let ctaAudio: string | null = null;
  if (useVoice && ctaText) {
    ctaSec = await synthesize(ctaText, join(opts.dir, 'cta.wav'), opts.tts!);
    ctaAudio = `${opts.rel}/cta.wav`;
  }
  const timeline = buildTimeline(scenes, ctaSec, script.durationSec);
  const withSfx = opts.sfx !== false && sfxAvailable();
  if (opts.sfx !== false && !withSfx) log('sound effects are missing (assets/sfx), rendering without them');
  const props: ReelProps = {
    hook: script.hook,
    cta: script.cta,
    scenes: script.scenes.map((s, i) => ({ subtitle: s.subtitle, voice: s.voice, audio: audio[i]! })),
    ctaAudio,
    timeline,
    sfx: withSfx ? planSfx(timeline) : [],
  };
  const fira = opts.fira ?? true;
  if (fira && firaAvailable()) props.brand = { fira: fira === true ? { ...(script.caption ? { bubble: script.caption } : {}) } : fira };
  else if (fira) log('Fira assets are missing (assets/fira, run `pnpm --filter renderer fira:assets`), rendering without the sticker');
  return { props, voiced: useVoice };
}

/** Renders one reel to `opts.outFile` (through a temporary name, so a half-written file is never picked up). */
export async function renderReel(script: ReelScript, bundleCache: BundleCache, opts: RenderOptions): Promise<RenderResult> {
  const log = opts.log ?? (() => {});
  const serveUrl = await bundleCache.get();
  const dir = jobDir(serveUrl, opts.jobKey);
  try {
    const { props, voiced } = await buildProps(script, { tts: opts.tts, dir, rel: `jobs/${opts.jobKey}`, ...(opts.sfx === false ? { sfx: false } : {}), ...(opts.fira !== undefined ? { fira: opts.fira } : {}), log });
    const { ensureBrowser, makeCancelSignal, renderMedia, selectComposition } = await import('@remotion/renderer');
    await ensureBrowser();
    const inputProps = props as unknown as Record<string, unknown>;
    const composition = await selectComposition({ serveUrl, id: 'Reel', inputProps });
    mkdirSync(dirname(opts.outFile), { recursive: true });
    const tmp = `${opts.outFile}.part.mp4`;
    const { cancelSignal, cancel } = makeCancelSignal();
    const timer = setTimeout(cancel, opts.timeoutMs);
    let last = -1;
    try {
      await renderMedia({
        composition, serveUrl, inputProps, codec: 'h264', videoBitrate: '3M', audioBitrate: '128k', outputLocation: tmp,
        concurrency: opts.concurrency, cancelSignal,
        onProgress: ({ progress }) => {
          const pct = Math.floor(progress * 4) * 25;
          if (pct !== last) {
            last = pct;
            log(`render ${pct}%`);
          }
        },
      });
    } finally {
      clearTimeout(timer);
    }
    renameSync(tmp, opts.outFile);
    return { path: opts.outFile, bytes: statSync(opts.outFile).size, seconds: props.timeline.totalFrames / props.timeline.fps, voiced };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
