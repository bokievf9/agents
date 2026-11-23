import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { compile, mockTools, teamPackIds, teamSpec, TEAM_KNOWN_TOOLS, TEAM_PACK_DIR, TEAM_TOOL_DEFS, TEAM_WRITE_TOOLS } from '../src/index.js';

describe('team packs («Команда»)', () => {
  it('every team pack parses into an owner spec whose tools are known; writes are only the listed ones', () => {
    const ids = teamPackIds();
    expect(ids.length).toBeGreaterThanOrEqual(22);
    for (const id of ids) {
      const s = teamSpec(id);
      expect(s.id).toBe(`firtech/${id}`);
      expect(s.audience).toBe('owner');
      expect(s.guards.prices).toBe(true);
      for (const t of s.role.tools) expect(TEAM_KNOWN_TOOLS).toContain(t);
    }
    for (const w of TEAM_WRITE_TOOLS) expect(TEAM_KNOWN_TOOLS).toContain(w);
  });

  it('compile keeps only the pack tools present in the registry', () => {
    const reg = { ...mockTools({ leads: [], money: [] }), my_queue: { def: TEAM_TOOL_DEFS.my_queue!, run: () => Promise.resolve({ ok: true as const, value: {} }) } };
    const c = compile(teamSpec('sales-head'), reg);
    expect(c.toolNames).toContain('leads');
    expect(c.toolNames).toContain('my_queue');
    expect(c.toolNames).not.toContain('money');
  });

  it('no team pack says a banned name', () => {
    for (const id of teamPackIds()) {
      const text = readFileSync(join(TEAM_PACK_DIR, `${id}.md`), 'utf8');
      expect(text).not.toMatch(/приём?щик|калькулятор|конструктор|(ии|ai)[- ]бот|50\s*(?:на|\/)\s*50/iu);
    }
  });
});
