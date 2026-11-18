import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ClipScript } from './schema';
import { buildTimeline } from './timing';
import { audioSeconds, detectTools, ensureDir, pickEngine, synthesize, voiceFile } from './tts';
import type { ClipProps } from './remotion/Clip';

const entry = join(dirname(fileURLToPath(import.meta.url)), 'remotion', 'index.ts');

export interface RenderResult {
  out: string;
  seconds: number;
  bytes: number;
  engine: string;
}

export function loadScript(path: string): { script: ClipScript; baseDir: string } {
  const script = ClipScript.parse(JSON.parse(readFileSync(path, 'utf8')));
  return { script, baseDir: dirname(resolve(path)) };
}

export async function renderClip(script: ClipScript, baseDir: string, out: string, log: (m: string) => void = console.log): Promise<RenderResult> {
  const tools = await detectTools();
  if (!tools.ffmpeg || !tools.ffprobe) throw new Error('ffmpeg and ffprobe are required (brew install ffmpeg)');
  const engine = await pickEngine();
  log(`voice engine: ${engine}`);

  const work = mkdtempSync(join(tmpdir(), 'fir-clip-'));
  const pub = ensureDir(join(work, 'public'));
  try {
    // 1. Voice per scene, plus the CTA line.
    const voices: string[] = [];
    const seconds: number[] = [];
    for (const [i, s] of script.scenes.entries()) {
      const name = `v${i}`;
      await synthesize(s.voice, voiceFile(pub, name), engine, script.voice);
      voices.push(`${name}.mp3`);
      seconds.push(await audioSeconds(voiceFile(pub, name)));
    }
    await synthesize(script.cta, voiceFile(pub, 'cta'), engine, script.voice);
    const ctaSec = await audioSeconds(voiceFile(pub, 'cta'));

    // 2. Optional images and music into the public dir.
    const abs = (p: string) => (isAbsolute(p) ? p : resolve(baseDir, p));
    const images = script.scenes.map((s, i) => {
      if (!s.image) return null;
      const src = abs(s.image);
      if (!existsSync(src)) throw new Error(`scene ${i + 1}: image not found: ${src}`);
      const name = `img${i}${extname(src)}`;
      copyFileSync(src, join(pub, name));
      return name;
    });
    let music: string | null = null;
    if (script.music) {
      const src = abs(script.music);
      if (!existsSync(src)) throw new Error(`music not found: ${src}`);
      music = `music${extname(src)}`;
      copyFileSync(src, join(pub, music));
    }

    // 3. Timeline and render.
    const timeline = buildTimeline(seconds, ctaSec);
    log(`scenes: ${seconds.map((s) => s.toFixed(1)).join(', ')} s; cta ${ctaSec.toFixed(1)} s; total ${(timeline.totalFrames / timeline.fps).toFixed(1)} s`);
    const props: ClipProps = { script, timeline, assets: { voices, ctaVoice: 'cta.mp3', images, music } };

    const { bundle } = await import('@remotion/bundler');
    const { ensureBrowser, renderMedia, selectComposition } = await import('@remotion/renderer');
    await ensureBrowser();
    log('bundling');
    const serveUrl = await bundle({ entryPoint: entry, publicDir: pub });
    const composition = await selectComposition({ serveUrl, id: 'Clip', inputProps: props as unknown as Record<string, unknown> });
    ensureDir(dirname(resolve(out)));
    let last = -1;
    await renderMedia({
      composition,
      serveUrl,
      codec: 'h264',
      crf: 18,
      outputLocation: resolve(out),
      inputProps: props as unknown as Record<string, unknown>,
      onProgress: ({ progress }) => {
        const pct = Math.floor(progress * 10) * 10;
        if (pct !== last) {
          last = pct;
          log(`render ${pct}%`);
        }
      },
    });
    const bytes = statSync(resolve(out)).size;
    return { out: resolve(out), seconds: timeline.totalFrames / timeline.fps, bytes, engine };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

export const defaultOut = (script: ClipScript, file: string) => resolve(process.cwd(), 'out', 'clips', `${script.slug ?? basename(file, extname(file))}.mp4`);
