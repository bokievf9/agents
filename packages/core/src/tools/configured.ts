import { knowledgeDir } from '../playbooks.js';
import { parseClientJson } from '../google-oauth.js';
import type { ToolDeps } from './kit.js';
import { fontsPresent } from './pdf.js';

/**
 * Is a tool set up: keys in the config, the adapter the app registers, the database or folder it needs. The one place the
 * registry, the tools and `/admin/company` ask; a tool that is not set up answers `not_configured` without running.
 */
export function isConfigured(name: string, d: Pick<ToolDeps, 'config' | 'db' | 'llm' | 'messenger' | 'ownerId' | 'renderPng' | 'crm'>): boolean {
  const c = d.config ?? {};
  const files = Boolean(c.rendersDir ?? c.dataDir);
  const oauth = Boolean(parseClientJson(c.ytOauthClientJson) && c.ytRefreshToken);
  const tg = Boolean(d.messenger && d.ownerId);
  switch (name) {
    case 'files.put':
    case 'files.get':
    case 'files.list':
      return files;
    case 'files.url':
      return files && Boolean(c.mediaSecret && c.mediaBase);
    case 'media.png':
      return Boolean(d.renderPng);
    case 'media.pdf':
      return fontsPresent();
    case 'llm.json':
    case 'llm.text':
      return Boolean(d.llm?.enabled);
    case 'knowledge.search':
      return Boolean(knowledgeDir(c.knowledgeDir) || d.db);
    case 'knowledge.add':
    case 'events.week':
    case 'mac.poster.enqueue':
      return Boolean(d.db);
    case 'crm.leads':
    case 'crm.clients':
    case 'crm.projects':
    case 'crm.invoices':
    case 'crm.tickets':
      return Boolean(d.crm);
    case 'google.youtube.channel':
      return oauth || Boolean(c.youtubeApiKey && c.youtubeChannelId);
    case 'google.youtube.videos':
      return oauth || Boolean(c.youtubeApiKey);
    case 'google.youtube.upload':
      return oauth;
    case 'google.searchConsole':
      return Boolean(c.gscServiceAccountJson && c.gscSiteUrl);
    case 'telegram.send':
      return tg;
    case 'telegram.sendDocument':
      return tg && Boolean(d.messenger?.sendDocument);
    case 'telegram.sendPhotos':
      return tg && Boolean(d.messenger?.sendPhotos);
    case 'email.send':
      return Boolean(c.resendApiKey && c.emailFrom);
    default:
      return true; // web, cache, qr, prices, playbook, trends, chain, clock: nothing to set up
  }
}
