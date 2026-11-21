/** Every /admin route of the census (ids 1 exist in a seeded world, none in a fresh one). */
/** [method, path, whether the route takes a body]. ids in the paths exist in the seeded world (1 is a lead, a task, an approval, a project...). */
export const ADMIN: [string, string][] = [
  ['GET', '/admin/state'], ['GET', '/admin/inbox'], ['GET', '/admin/inbox?after=1&limit=5&unread=1'], ['GET', '/admin/approvals'], ['GET', '/admin/tasks'], ['GET', '/admin/tasks?status=blocked,done&open=1&limit=3&dept=sales'],
  ['GET', '/admin/tasks/1'], ['GET', '/admin/tasks/99999'], ['GET', '/admin/office'], ['GET', '/admin/departments'], ['GET', '/admin/drill'], ['GET', '/admin/hub'],
  ['GET', '/admin/crm/summary'], ['GET', '/admin/crm/prospects'], ['GET', '/admin/crm/leads'], ['GET', '/admin/crm/leads?limit=1&q=dil'], ['GET', '/admin/crm/clients'], ['GET', '/admin/crm/tickets'], ['GET', '/admin/crm/documents'],
  ['GET', '/admin/crm/projects'], ['GET', '/admin/crm/referrals'], ['GET', '/admin/crm/reviews'], ['GET', '/admin/crm/invoices'], ['GET', '/admin/crm/clients/c:dilnoza'], ['GET', '/admin/crm/clients/1'], ['GET', '/admin/crm/clients/%E0%A4'],
  ['GET', '/admin/crm/projects/1'], ['GET', '/admin/crm/projects/99999'], ['GET', '/admin/crm/nothing'], ['GET', '/admin/content'], ['GET', '/admin/content?week=2026-W48'], ['GET', '/admin/content?week=bad'], ['GET', '/admin/content?queued=1'],
  ['GET', '/admin/review'], ['GET', '/admin/chats'], ['GET', '/admin/chats?status=all'], ['GET', '/admin/chats/c1'], ['GET', '/admin/chats/%E0%A4'], ['GET', '/admin/trends'], ['GET', '/admin/metrics/week'], ['GET', '/admin/metrics/week?week=bad'],
  ['GET', '/admin/company'], ['GET', '/admin/company/playbooks/seo'], ['GET', '/admin/company/playbooks/nope'], ['GET', '/admin/files/nothing.png'], ['GET', '/admin/files/../x.png'], ['GET', '/admin/clients/by-email?email=anvar.k%40example.com'], ['GET', '/admin/clients/by-email'],
  ['GET', '/admin/'], ['GET', '/admin/unknown/deep/path'],
  ['POST', '/admin/presence'], ['POST', '/admin/ping'], ['POST', '/admin/inbox/read'], ['POST', '/admin/say'], ['POST', '/admin/command'], ['POST', '/admin/drill'], ['POST', '/admin/approvals/1'], ['POST', '/admin/approvals/99999'],
  ['POST', '/admin/tasks/1/retry'], ['POST', '/admin/tasks/99999/retry'], ['POST', '/admin/prices/reload'],
  ['POST', '/admin/crm/prospects/1'], ['POST', '/admin/crm/tickets/1'], ['POST', '/admin/crm/leads/1'], ['POST', '/admin/crm/leads/1/reply'], ['POST', '/admin/crm/leads/1/call'], ['POST', '/admin/crm/leads/99999/reply'],
  ['POST', '/admin/crm/projects/1'], ['POST', '/admin/crm/invoices/1'], ['POST', '/admin/content/1'], ['POST', '/admin/content/a1'], ['POST', '/admin/review/ap_1'], ['POST', '/admin/chats/c1/reply'], ['POST', '/admin/chats/zzz/reply'], ['POST', '/admin/chats/c1/resume'], ['POST', '/admin/chats/zzz/resume'], ['POST', '/admin/trends'],
  ['POST', '/admin/company/routines/support-daily'], ['POST', '/admin/company/routines/support-daily/run'], ['POST', '/admin/company/routines/nope/run'], ['POST', '/admin/company/trust/lead_reply'], ['POST', '/admin/company/trust/nope'],
  ['POST', '/admin/clients'], ['POST', '/admin/clients/1/tickets'], ['POST', '/admin/clients/1/leads/1/messages'], ['POST', '/admin/clients/1/projects/1/milestones/1/accept'],
];


/** Bodies thrown at every POST route: absent, empty, wrong type, wrong shape, oversized, and the shapes of real actions. */
export const BODIES: unknown[] = [undefined, {}, [], null, 'text', 42, { action: 'nope' }, { id: -1 }, { text: 'x'.repeat(5000) }, { action: 'approve', text: { draft: 1 } }, { mode: 'desk' }, { ids: 'all' }, { name: 'status', arg: 1 }, { level: 1 }, { enabled: 'yes' }];
