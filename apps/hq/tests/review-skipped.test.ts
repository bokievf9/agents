import { describe, expect, it } from 'vitest';
import { routedLlm, world } from './helpers.js';

describe('a skipped checklist review is never logged as passed', () => {
  it('when the model gives no readable review the task journal and the approval card say it was skipped', async () => {
    const w = world({ llm: routedLlm({ review: () => 'не JSON' }) });
    const t = w.hq.createTask({ title: 'ролик', dept: 'marketing', creator: 'owner', meta: { action: 'topic', topic: 'приёмщик заявок', type: 'clip' } });
    await w.marketing.onHeartbeat();
    expect(w.hq.activity(200).some((a) => a.action === 'review_skipped')).toBe(true);
    const kids = w.hq.tasks({ parentId: t.id });
    const skipped = [t, ...kids].some((x) => w.hq.events(x.id).some((e) => e.kind === 'comment' && e.body.includes('Ревью по чек-листу пропущено')));
    expect(skipped).toBe(true);
    await w.director.sendApprovalBatch(false);
    expect(w.messenger.sent.map((m) => m.text).join('\n')).toContain('Ревью по чек-листу пропущено');
  });

  it('a working review leaves no skipped note', async () => {
    const w = world();
    w.hq.createTask({ title: 'ролик', dept: 'marketing', creator: 'owner', meta: { action: 'topic', topic: 'приёмщик заявок', type: 'clip' } });
    await w.marketing.onHeartbeat();
    expect(w.hq.activity(200).some((a) => a.action === 'review_skipped')).toBe(false);
  });
});
