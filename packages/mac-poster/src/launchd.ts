import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const LABEL = 'pro.firtech.mac-poster';
export const REACH_LABEL = 'pro.firtech.reach';
export const plistPath = (home = homedir(), label = LABEL): string => join(home, 'Library', 'LaunchAgents', `${label}.plist`);
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

/** The reach agent: every 15 minutes, `node --import tsx src/cli.ts reach`. */
export const REACH_INTERVAL_S = 900;

function plistWith(o: PlistOpts, label: string, command: string[], schedule: string): string {
  const args = [o.node, '--import', 'tsx', o.cli, ...command];
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key>
  <array>
${args.map((a) => `    <string>${esc(a)}</string>`).join('\n')}
  </array>
  <key>WorkingDirectory</key><string>${esc(o.cwd)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${esc(join(o.home, '.local', 'bin'))}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>HOME</key><string>${esc(o.home)}</string>
  </dict>
${schedule}
  <key>StandardOutPath</key><string>${esc(join(o.logsDir, 'launchd.log'))}</string>
  <key>StandardErrorPath</key><string>${esc(join(o.logsDir, 'launchd.log'))}</string>
  <key>RunAtLoad</key><false/>
  <key>ProcessType</key><string>Interactive</string>
</dict>
</plist>
`;
}

/** The Instagram LaunchAgent: `node --import tsx src/cli.ts instagram --jitter 10` at 10:00, 14:00 and 19:00 local time. */
export function plistXml(o: PlistOpts): string {
  const hours = o.hours ?? RUN_HOURS;
  const schedule = `  <key>StartCalendarInterval</key>
  <array>
${hours.map((h) => `    <dict><key>Hour</key><integer>${h}</integer><key>Minute</key><integer>0</integer></dict>`).join('\n')}
  </array>`;
  return plistWith(o, LABEL, ['instagram', '--jitter', '10'], schedule);
}

/** The Agent Reach LaunchAgent (`pro.firtech.reach`): `reach` every 15 minutes, no run at load (the first one is `reach:now`). */
export function reachPlistXml(o: PlistOpts): string {
  return plistWith(o, REACH_LABEL, ['reach'], `  <key>StartInterval</key><integer>${REACH_INTERVAL_S}</integer>`);
}

const uid = () => (process.getuid ? process.getuid() : 501);

export function installLaunchd(o: PlistOpts, which: 'instagram' | 'reach' = 'instagram'): string {
  const file = plistPath(o.home, which === 'reach' ? REACH_LABEL : LABEL);
  mkdirSync(join(o.home, 'Library', 'LaunchAgents'), { recursive: true });
  mkdirSync(o.logsDir, { recursive: true });
  if (existsSync(file)) {
    try {
      execFileSync('launchctl', ['bootout', `gui/${uid()}`, file], { stdio: 'ignore' });
    } catch {
      /* not loaded */
    }
  }
  writeFileSync(file, which === 'reach' ? reachPlistXml(o) : plistXml(o), { mode: 0o644 });
  execFileSync('launchctl', ['bootstrap', `gui/${uid()}`, file], { stdio: 'inherit' });
  return file;
}

export function uninstallLaunchd(home = homedir(), which: 'instagram' | 'reach' = 'instagram'): string | null {
  const file = plistPath(home, which === 'reach' ? REACH_LABEL : LABEL);
  if (!existsSync(file)) return null;
  try {
    execFileSync('launchctl', ['bootout', `gui/${uid()}`, file], { stdio: 'ignore' });
  } catch {
    /* not loaded */
  }
  unlinkSync(file);
  return file;
}
