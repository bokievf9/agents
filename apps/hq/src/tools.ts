import { createTools, type CrmReader, type LlmClient, type Messenger, type QuotaBook, type ToolFetch, type Tools, type ToolsConfig } from '@fir/core';
import type { Hq } from '@fir/hq';
import { PublishStore } from '@fir/worker-publisher';
import { SIZES, renderFrame, type Frame } from '@fir/worker-content-maker';
import { z } from 'zod';
import { createCrm } from './admin-crm.js';
import type { Config } from './config.js';

/**
 * The app side of the agents' toolbox (`docs/tools.md`): the keys from the HQ config, and the adapters core cannot have itself
 * (the content-maker PNG renderer, the Shell CRM views, the Publisher's YouTube quota). One `AppTools` per process; every head
 * builds a toolbox per worker run with `toolsFor`.
 */
export interface AppTools {
  config: ToolsConfig;
  renderPng?: (frame: unknown) => Promise<Uint8Array>;
  crm?: CrmReader;
  youtubeQuota?: QuotaBook;
  /** The company's model client (only `enabled` is read, for the listing; calls use the head's task-metered one). */
  llm?: LlmClient;
  /** Tests: the fake network every toolbox of the app uses. */
  fetch?: ToolFetch;
  lookup?: (host: string) => Promise<string[]>;
  sleep?: (ms: number) => Promise<void>;
}

const frameSchema = z.object({
  kind: z.enum(Object.keys(SIZES) as [keyof typeof SIZES, ...(keyof typeof SIZES)[]]),
  title: z.string().max(200),
  lines: z.array(z.string().max(300)).max(4),
  index: z.number().int().positive().optional(),
  total: z.number().int().positive().optional(),
});

/** `media.png`: a validated frame through the content-maker renderer (satori + resvg). */
export async function renderPngFrame(frame: unknown): Promise<Uint8Array> {
  const parsed = frameSchema.safeParse(frame);
  if (!parsed.success) throw new Error(`frame: ${parsed.error.issues[0]?.message ?? 'invalid'}`);
  return renderFrame(parsed.data as Frame);
}

/** The process-wide adapters and keys, from the HQ config. */
export function appTools(hq: Hq, llm: LlmClient, cfg: Pick<Config, 'dataDir' | 'rendersDir' | 'knowledgeDir' | 'mediaSecret' | 'igPublicBase' | 'braveSearchKey' | 'resendApiKey' | 'emailFrom' | 'gscServiceAccountJson' | 'gscSiteUrl' | 'youtubeApiKey' | 'youtubeChannelId' | 'ytOauthClientJson' | 'ytRefreshToken' | 'trongridApiKey' | 'toncenterApiKey'> & Partial<Pick<Config, 'selfIps'>> & Partial<Pick<Config, 'openverseClientId' | 'openverseClientSecret'>>): AppTools {
  // read-only views of the Shell CRM: no hooks, so nothing a tool does can write through it
  const crm = createCrm(hq.db, hq.now);
  const quota = new PublishStore(hq.db);
  return {
    config: {
      dataDir: cfg.dataDir, rendersDir: cfg.rendersDir, knowledgeDir: cfg.knowledgeDir, mediaSecret: cfg.mediaSecret, mediaBase: cfg.igPublicBase, selfIps: cfg.selfIps,
      braveSearchKey: cfg.braveSearchKey, resendApiKey: cfg.resendApiKey, emailFrom: cfg.emailFrom, gscServiceAccountJson: cfg.gscServiceAccountJson, gscSiteUrl: cfg.gscSiteUrl,
      youtubeApiKey: cfg.youtubeApiKey, youtubeChannelId: cfg.youtubeChannelId, ytOauthClientJson: cfg.ytOauthClientJson, ytRefreshToken: cfg.ytRefreshToken,
      trongridApiKey: cfg.trongridApiKey, toncenterApiKey: cfg.toncenterApiKey, openverseClientId: cfg.openverseClientId, openverseClientSecret: cfg.openverseClientSecret,
    },
    renderPng: renderPngFrame,
    crm: (panel, query) => crm.handle('GET', [panel], new URLSearchParams(query), null).body,
    youtubeQuota: { used: (d) => quota.quotaUsed(d), add: (d, n) => quota.addQuota(d, n) },
    llm,
  };
}

export interface ToolsFor {
  agentId: string;
  dept: string;
  taskId?: number | null;
  /** The task-metered client the head already gives the worker. */
  llm?: LlmClient;
  /** The head's messenger (the owner channel over the `OutboxMessenger`) and the owner's chat. */
  messenger?: Messenger;
  ownerId?: number;
}

/** A worker run's toolbox: the agent, its department and task, HQ as the journal, the shared database and the app's keys. */
export function toolsFor(hq: Hq, app: AppTools | undefined, o: ToolsFor): Tools {
  return createTools({
    agentId: o.agentId, dept: o.dept, taskId: o.taskId ?? null, journal: hq, db: hq.db, now: hq.now, tz: hq.tz,
    config: app?.config ?? {},
    ...(o.llm ? { llm: o.llm } : {}),
    ...(o.messenger && o.ownerId ? { messenger: o.messenger, ownerId: o.ownerId } : {}),
    ...(app?.renderPng ? { renderPng: app.renderPng } : {}),
    ...(app?.crm ? { crm: app.crm } : {}),
    ...(app?.youtubeQuota ? { youtubeQuota: app.youtubeQuota } : {}),
    ...(app?.fetch ? { fetch: app.fetch } : {}),
    ...(app?.lookup ? { lookup: app.lookup } : {}),
    ...(app?.sleep ? { sleep: app.sleep } : {}),
  });
}
