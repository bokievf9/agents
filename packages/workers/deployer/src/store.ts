import { migrate, type Db } from '@fir/core';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS dp_targets (
  project_id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,
  location TEXT NOT NULL,
  url TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL
);
`;

/** ours: our server (a path under /opt/...); client: the client's own server. */
export type TargetKind = 'ours' | 'client';

export interface Target {
  projectId: number;
  kind: TargetKind;
  /** Server path or host, no credentials ever. */
  location: string;
  url: string;
}

export class DeployStore {
  constructor(private readonly db: Db, private readonly now: () => number) {
    migrate(db, SCHEMA);
  }

  set(t: Target): void {
    this.db
      .prepare(
        `INSERT INTO dp_targets (project_id, kind, location, url, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(project_id) DO UPDATE SET kind = excluded.kind, location = excluded.location, url = excluded.url, updated_at = excluded.updated_at`,
      )
      .run(t.projectId, t.kind, t.location, t.url, this.now());
  }

  get(projectId: number): Target | undefined {
    const r = this.db.prepare('SELECT * FROM dp_targets WHERE project_id = ?').get(projectId) as
      | { project_id: number; kind: string; location: string; url: string }
      | undefined;
    return r ? { projectId: r.project_id, kind: r.kind === 'client' ? 'client' : 'ours', location: r.location, url: r.url } : undefined;
  }
}

/** `/target` arguments: "<project> ours|client <path or host> [url]". Credentials in the text are refused. */
export function parseTarget(arg: string): { ref: string; kind: TargetKind; location: string; url: string } | string {
  const parts = arg.trim().split(/\s+/);
  const kindIdx = parts.findIndex((p) => /^(ours|client|наш|клиент)/i.test(p));
  if (kindIdx < 1 || parts.length < kindIdx + 2) return 'Формат: /target <проект> ours|client <путь или хост> [url]';
  const location = parts[kindIdx + 1]!;
  const url = parts[kindIdx + 2] ?? '';
  if (/password|token|secret|пароль|токен|\S@\S/i.test(`${location} ${url}`)) return 'Пароли и токены сюда не пишем: только путь или хост.';
  if (url && !/^https?:\/\/\S+$/.test(url)) return 'url должен начинаться с https://';
  return { ref: parts.slice(0, kindIdx).join(' '), kind: /^(client|клиент)/i.test(parts[kindIdx]!) ? 'client' : 'ours', location, url };
}
