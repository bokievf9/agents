import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { wavSeconds } from './wav.js';

export interface TtsEnv {
  /** Piper executable (`piper` from the piper-tts package). */
  piperBin: string;
  voicesDir: string;
  /** Voice name without extension, e.g. `ru_RU-denis-medium`; the model is `<voicesDir>/<voice>.onnx`. */
  voice: string;
  timeoutMs: number;
}

export function ttsEnvFrom(env: NodeJS.ProcessEnv = process.env): TtsEnv {
  return {
    piperBin: env.PIPER_BIN || 'piper',
    voicesDir: env.PIPER_VOICES_DIR || '/opt/piper/voices',
    voice: env.PIPER_VOICE || 'ru_RU-denis-medium',
    timeoutMs: 60_000,
  };
}

/** Text as it should be spoken: web handles and the domain are spelled out so the Russian voice does not stumble. */
export function speakable(text: string): string {
  return text
    .replace(/@firtech_bot/gi, 'бот фир тек')
    .replace(/firtech\.pro/gi, 'фир тек точка про')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/[#*_`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Synthesises `text` into a WAV with Piper (text on stdin) and returns its length in seconds. */
export function synthesize(text: string, outFile: string, env: TtsEnv): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(env.piperBin, ['--model', join(env.voicesDir, `${env.voice}.onnx`), '--output_file', outFile], { stdio: ['pipe', 'ignore', 'pipe'] });
    let err = '';
    child.stderr.on('data', (d: Buffer) => (err = (err + d.toString()).slice(-600)));
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('piper timed out'));
    }, env.timeoutMs);
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(new Error(`piper did not start: ${e.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`piper exited with ${code}: ${err.trim().split('\n').at(-1) ?? ''}`));
      try {
        resolve(wavSeconds(readFileSync(outFile)));
      } catch (e) {
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
    child.stdin.end(`${text}\n`);
  });
}
