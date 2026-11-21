import { loadLlmEnv, optional } from '@fir/core';
import { DEFAULT_OMNIROUTE_URL, parseMonitorUrls, type MonitorConfig } from './checks.js';

/** Monitoring settings from the environment. `dataDir` comes from the base config (the filesystem to watch). */
export function loadMonitorConfig(env: NodeJS.ProcessEnv, dataDir: string): MonitorConfig {
  return {
    urls: parseMonitorUrls(optional(env, 'MONITOR_URLS')),
    omnirouteUrl: optional(env, 'OMNIROUTE_HEALTH_URL') ?? DEFAULT_OMNIROUTE_URL,
    llmApiKey: optional(env, 'LLM_API_KEY'),
    // direct Anthropic mode: the gateway is not used, so its health is not checked and never alerts
    llmDirect: loadLlmEnv(env).mode === 'direct',
    dataDir,
    docker: optional(env, 'MONITOR_DOCKER')?.toLowerCase() === 'true',
    dockerSocket: optional(env, 'MONITOR_DOCKER_SOCKET') ?? '/var/run/docker.sock',
    diskMaxPct: 85,
    certMinDays: 14,
    timeoutMs: 10_000,
    renderer: (env.REELS_RENDER ?? 'on').toLowerCase() !== 'off',
  };
}
