import { execFile } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

export type TtsEngine = 'edge-tts' | 'say';

async function has(cmd: string): Promise<boolean> {
  try {
    await run('which', [cmd]);
    return true;
  } catch {
    return false;
  }
}

/** Required: ffmpeg and ffprobe. Voice: edge-tts when installed, else macOS `say`. */
export async function detectTools(): Promise<{ ffmpeg: boolean; ffprobe: boolean; edgeTts: boolean; say: boolean }> {
  const [ffmpeg, ffprobe, edgeTts, say] = await Promise.all([has('ffmpeg'), has('ffprobe'), has('edge-tts'), has('say')]);
  return { ffmpeg, ffprobe, edgeTts, say };
}

export async function pickEngine(): Promise<TtsEngine> {
  const forced = process.env.CLIPS_TTS;
  if (forced === 'edge-tts' || forced === 'say') return forced;
  if (await has('edge-tts')) return 'edge-tts';
  if (await has('say')) return 'say';
  throw new Error('No TTS available: install edge-tts (pipx install edge-tts) or run on macOS (say)');
}

/** Voice-over text to an mp3 file. */
export async function synthesize(text: string, out: string, engine: TtsEngine, voice?: string): Promise<void> {
  if (engine === 'edge-tts') {
    // The Microsoft service sometimes answers "No audio was received" for one voice and one text
    // (seen with ru-RU-DmitryNeural on ordinary sentences) while another voice works, so try the
    // requested voice, then the alternate, then fall back to macOS `say` so a clip is never blocked.
    const primary = voice ?? 'ru-RU-SvetlanaNeural';
    const alternate = primary === 'ru-RU-SvetlanaNeural' ? 'ru-RU-DmitryNeural' : 'ru-RU-SvetlanaNeural';
    for (const v of [primary, alternate]) {
      try {
        await run('edge-tts', ['--voice', v, '--rate=+5%', '--text', text, '--write-media', out]);
        return;
      } catch (err) {
        process.stderr.write(`edge-tts ${v} failed, trying next: ${String((err as Error).message).split('\n')[0].slice(0, 120)}\n`);
      }
    }
    if (!(await has('say'))) throw new Error('edge-tts failed for every voice and `say` is unavailable');
  }
  const aiff = out.replace(/\.mp3$/, '.aiff');
  await run('say', ['-v', voice ?? 'Milena', '-o', aiff, '--', text]);
  await run('ffmpeg', ['-y', '-loglevel', 'error', '-i', aiff, '-ar', '44100', '-ac', '1', '-b:a', '128k', out]);
}

export async function audioSeconds(file: string): Promise<number> {
  const { stdout } = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file]);
  const sec = Number.parseFloat(stdout.trim());
  if (!Number.isFinite(sec) || sec <= 0) throw new Error(`ffprobe gave no duration for ${file}`);
  return sec;
}

export function ensureDir(dir: string): string {
  mkdirSync(dir, { recursive: true });
  return dir;
}

export const voiceFile = (dir: string, name: string) => join(dir, `${name}.mp3`);
