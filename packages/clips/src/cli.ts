import { resolve } from 'node:path';
import { loadScript, renderClip } from './render';

// pnpm runs scripts in the package dir; INIT_CWD is where the user typed the command.
const cwd = process.env.INIT_CWD ?? process.cwd();
const [fileArg, outArg] = process.argv.slice(2);
const file = fileArg && resolve(cwd, fileArg);
const out = outArg && resolve(cwd, outArg);
if (!file || !out) {
  console.error('Usage: pnpm --filter @fir/clips render <script.json> <out.mp4>');
  process.exit(2);
}
try {
  const { script, baseDir } = loadScript(file);
  const r = await renderClip(script, baseDir, out);
  console.log(`done: ${r.out}\nduration: ${r.seconds.toFixed(1)} s, size: ${(r.bytes / 1024 / 1024).toFixed(2)} MB, voice: ${r.engine}`);
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
}
