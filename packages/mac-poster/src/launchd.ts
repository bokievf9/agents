import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const LABEL = 'pro.firtech.mac-poster';
export const plistPath = (home = homedir()): string => join(home, 'Library', 'LaunchAgents', `${LABEL}.plist`);
/** Kuala Lumpur time = the Mac's local time. */
export const RUN_HOURS = [10, 14, 19];

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export interface PlistOpts {
  /** Absolute path of `node`. */
  node: string;
  /** Absolute path of `src/cli.ts`. */
  cli: string;
  /** The package folder (tsx is resolved from here). */
  cwd: string;
  logsDir: string;
  home: string;
  hours?: number[];
}

/** The LaunchAgent: `node --import tsx src/cli.ts instagram --jitter 10` at 10:00, 14:00 and 19:00 local time. */
export function plistXml(o: PlistOpts): string {
  const args = [o.node, '--import', 'tsx', o.cli, 'instagram', '--jitter', '10'];
  const hours = o.hours ?? RUN_HOURS;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args.map((a) => `    <string>${esc(a)}</string>`).join('\n')}
  </array>
  <key>WorkingDirectory</key><string>${esc(o.cwd)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>HOME</key><string>${esc(o.home)}</string>
  </dict>
  <key>StartCalendarInterval</key>
  <array>
${hours.map((h) => `    <dict><key>Hour</key><integer>${h}</integer><key>Minute</key><integer>0</integer></dict>`).join('\n')}
  </array>
  <key>StandardOutPath</key><string>${esc(join(o.logsDir, 'launchd.log'))}</string>
  <key>StandardErrorPath</key><string>${esc(join(o.logsDir, 'launchd.log'))}</string>
  <key>RunAtLoad</key><false/>
  <key>ProcessType</key><string>Interactive</string>
</dict>
</plist>
`;
}

const uid = () => (process.getuid ? process.getuid() : 501);

export function installLaunchd(o: PlistOpts): string {
  const file = plistPath(o.home);
  mkdirSync(join(o.home, 'Library', 'LaunchAgents'), { recursive: true });
  mkdirSync(o.logsDir, { recursive: true });
  if (existsSync(file)) {
    try {
      execFileSync('launchctl', ['bootout', `gui/${uid()}`, file], { stdio: 'ignore' });
    } catch {
      /* not loaded */
    }
  }
  writeFileSync(file, plistXml(o), { mode: 0o644 });
  execFileSync('launchctl', ['bootstrap', `gui/${uid()}`, file], { stdio: 'inherit' });
  return file;
}

export function uninstallLaunchd(home = homedir()): string | null {
  const file = plistPath(home);
  if (!existsSync(file)) return null;
  try {
    execFileSync('launchctl', ['bootout', `gui/${uid()}`, file], { stdio: 'ignore' });
  } catch {
    /* not loaded */
  }
  unlinkSync(file);
  return file;
}
