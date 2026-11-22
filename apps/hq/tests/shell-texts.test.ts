import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { pultLinks } from '../src/links.js';

// Audit fix 3 (2026-11-22): the owner-facing strings of the Telegram bot say Shell, never Пульт or HQ, and every link goes to a Shell section.
const SRC = new URL('../src/', import.meta.url);
const OWNER_FILES = ['director.ts', 'cab-docs.ts', 'glue.ts', 'assistant.ts', 'email-failures.ts', 'index.ts', 'tg.ts', 'presence.ts', 'lost-leads.ts', 'reviews.ts', 'calls.ts', 'heads/sales.ts', 'client/engine.ts', 'playground.ts', 'notices.ts'];

describe('Telegram texts', () => {
  it('no Пульт in the strings of the owner-facing files', () => {
    for (const f of OWNER_FILES) {
      const code = readFileSync(new URL(f, SRC), 'utf8').split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
      expect(code, f).not.toMatch(/Пульт/);
    }
    expect(readdirSync(SRC).length).toBeGreaterThan(10);
  });

  it('links go to Shell sections, never to the pixel office', () => {
    const l = pultLinks('https://firtech.pro');
    const all = [l.to('home'), l.to('review'), l.to('leads'), l.to('lead', 7), l.to('clients', 3), l.to('calls'), l.to('projects'), l.to('project', 2), l.to('chats'), l.to('chats', 'lead'), l.to('money', 5), l.to('tasks'), l.to('company'), l.to('settings')];
    for (const u of all) expect(u).not.toContain('/office');
    expect(l.to('home')).toBe('https://firtech.pro/admin/inbox');
    expect(l.to('tasks')).toBe('https://firtech.pro/admin/tasks');
    expect(l.to('review')).toBe('https://firtech.pro/admin/approvals');
    expect(l.to('lead', 7)).toBe('https://firtech.pro/admin/clients?tab=pipeline&focus=7');
    expect(l.to('clients', 3)).toBe('https://firtech.pro/admin/clients?tab=clients&focus=3');
    expect(l.to('money', 5)).toBe('https://firtech.pro/admin/finance?tab=invoices&focus=5');
  });
});
