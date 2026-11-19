import { EXCERPT_MAX, MockLlm, playbookExcerpt } from '@fir/core';
import { describe, expect, it } from 'vitest';
import { composeFindings, type AuditFacts } from '../src/audit.js';

const FACTS: AuditFacts = { reachable: true, status: 200, ms: 3200, title: 'x', hasDescription: false, h1: 0, canonical: false, og: false, viewport: false, messenger: false, form: false, instagram: false };

describe('SEO: the playbook is in the prompt', () => {
  it('the audit prompt keeps its own text and gets the capped excerpt', async () => {
    const llm = new MockLlm(() => 'not json');
    await composeFindings(llm, FACTS, 'ru');
    const system = llm.calls[0]!.system;
    const excerpt = playbookExcerpt('seo');
    expect(excerpt.length).toBeLessThanOrEqual(EXCERPT_MAX);
    expect(system).toContain('exactly 5 items');
    expect(system.endsWith(excerpt)).toBe(true);
    // the untrusted facts stay in the user message only
    expect(system).not.toContain('"messenger"');
  });
});
