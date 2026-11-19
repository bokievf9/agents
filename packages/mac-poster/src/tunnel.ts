import { spawn, type ChildProcess } from 'node:child_process';
import { createConnection } from 'node:net';
import type { Config } from './config.js';

/** `ssh -N -L <local>:127.0.0.1:<remote> -i <key> <target>`: non-interactive, fails fast when the port cannot be forwarded. */
export function sshArgs(c: Pick<Config, 'localPort' | 'remotePort' | 'sshKey' | 'sshTarget'>): string[] {
  return [
    '-N', '-L', `127.0.0.1:${c.localPort}:127.0.0.1:${c.remotePort}`, '-i', c.sshKey,
    '-o', 'ExitOnForwardFailure=yes', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', '-o', 'ServerAliveInterval=30', '-o', 'ServerAliveCountMax=3',
    c.sshTarget,
  ];
}

/** Does something accept connections on 127.0.0.1:port? */
export function portOpen(port: number, timeoutMs = 1000): Promise<boolean> {
  return new Promise((res) => {
    const s = createConnection({ host: '127.0.0.1', port });
    const done = (v: boolean) => {
      s.destroy();
      res(v);
    };
    s.setTimeout(timeoutMs, () => done(false));
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}

export interface Tunnel {
  /** True when an existing tunnel on the port was reused (and is left running). */
  reused: boolean;
  close(): void;
}

export interface TunnelDeps {
  probe?: (port: number) => Promise<boolean>;
  spawnSsh?: (args: string[]) => ChildProcess;
  sleep?: (ms: number) => Promise<void>;
  waitMs?: number;
}

/** Reuses a tunnel already listening on the local port, else starts `ssh` for this run and waits until the port answers. */
export async function openTunnel(c: Config, d: TunnelDeps = {}): Promise<Tunnel> {
  const probe = d.probe ?? ((p: number) => portOpen(p));
  const sleep = d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  if (await probe(c.localPort)) return { reused: true, close: () => undefined };
  const child = (d.spawnSsh ?? ((args) => spawn('ssh', args, { stdio: ['ignore', 'ignore', 'pipe'] })))(sshArgs(c));
  let stderr = '';
  let exited: number | null = null;
  child.stderr?.on('data', (b: Buffer) => (stderr = (stderr + b.toString()).slice(-500)));
  child.once('exit', (code) => (exited = code ?? -1));
  child.once('error', (e) => {
    stderr += e.message;
    exited = -1;
  });
  const close = () => {
    if (exited === null) child.kill('SIGTERM');
  };
  const deadline = Date.now() + (d.waitMs ?? 20_000);
  while (Date.now() < deadline) {
    if (exited !== null) throw new Error(`ssh-туннель не поднялся (код ${exited}): ${stderr.trim() || 'нет вывода'}`);
    if (await probe(c.localPort)) return { reused: false, close };
    await sleep(300);
  }
  close();
  throw new Error(`ssh-туннель не ответил за ${Math.round((d.waitMs ?? 20_000) / 1000)} с: ${stderr.trim() || 'нет вывода'}`);
}
