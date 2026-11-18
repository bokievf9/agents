import { fileURLToPath } from 'node:url';
import { loadSendEnv, parseSendArgs, sendVideo } from './send';

// pnpm runs scripts in the package dir; INIT_CWD is where the user typed the command.
try {
  const { file, caption } = parseSendArgs(process.argv.slice(2), process.env.INIT_CWD ?? process.cwd());
  const env = loadSendEnv(process.env, fileURLToPath(new URL('..', import.meta.url)));
  const id = await sendVideo(env, file, caption);
  console.log(`sent: ${file}\nmessage: ${id}`);
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
}
