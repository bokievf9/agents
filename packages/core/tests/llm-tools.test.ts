import { createServer, type IncomingMessage } from 'node:http';
import { describe, expect, it } from 'vitest';
import { createLlm, GatewayWatch, MockChatLlm, MockLlm, OffLlm, tryChat, turnOf, turnText, turnToolUses, type LlmChatRequest, type LlmClient } from '../src/index.js';

/** Native tool use (2026-11-22, Fira): an optional `chat` beside `complete`; nothing of the old protocol changes. */
const noKey = { baseUrl: undefined, apiKey: undefined, modelFast: undefined, modelSmart: undefined, timeoutMs: 2000, maxRetries: 0 };
const tool = { name: 'price_list', description: 'prices', input_schema: { type: 'object' as const, properties: { product: { type: 'string' } } } };
const req: LlmChatRequest = {
  tier: 'sonnet',
  system: [{ text: 'stable prefix', cache: true }, { text: 'per turn' }],
  messages: [{ role: 'user', content: 'сколько стоит?' }],
  tools: [tool],
  toolChoice: { type: 'auto' },
};

async function withServer(reply: unknown, run: (base: string, bodies: Record<string, unknown>[]) => Promise<void>): Promise<void> {
  const bodies: Record<string, unknown>[] = [];
  const server = createServer((r: IncomingMessage, res) => {
    let raw = '';
    r.on('data', (c: Buffer) => (raw += c.toString()));
    r.on('end', () => {
      bodies.push(JSON.parse(raw) as Record<string, unknown>);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(reply));
    });
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  try {
    await run(`http://127.0.0.1:${(server.address() as { port: number }).port}`, bodies);
  } finally {
    server.close();
  }
}

const toolReply = {
  id: 'm1', type: 'message', role: 'assistant', model: 'kimi-k2', stop_reason: 'tool_use', stop_sequence: null,
  content: [{ type: 'text', text: 'Сейчас посмотрю.' }, { type: 'tool_use', id: 'toolu_1', name: 'price_list', input: { product: 'admin' } }],
  usage: { input_tokens: 50, output_tokens: 9 },
};

describe('llm tool use', () => {
  it('turnOf keeps text and tool calls, maps the stop reason, drops other blocks', () => {
    const t = turnOf({ stop_reason: 'tool_use', content: [{ type: 'thinking', thinking: 'x' }, { type: 'text', text: ' a ' }, { type: 'tool_use', id: 'u1', name: 'n', input: [1] }] }, null);
    expect(t).toEqual({ content: [{ type: 'text', text: ' a ' }, { type: 'tool_use', id: 'u1', name: 'n', input: {} }], stopReason: 'tool_use' });
    expect(turnText(t)).toBe('a');
    expect(turnToolUses(t).map((x) => x.name)).toEqual(['n']);
    expect(turnOf({ stop_reason: 'pause_turn', content: [] }, null).stopReason).toBe('other');
  });

  it('through the gateway: tools and tool_choice go as plain parameters, the system is one string without cache marks', async () => {
    await withServer(toolReply, async (base, bodies) => {
      const llm = createLlm({ ...noKey, baseUrl: base, apiKey: 'k' });
      const turn = await llm.chat!(req);
      expect(turn.stopReason).toBe('tool_use');
      expect(turnToolUses(turn)).toEqual([{ type: 'tool_use', id: 'toolu_1', name: 'price_list', input: { product: 'admin' } }]);
      expect(turn.usage).toEqual({ inputTokens: 50, outputTokens: 9, model: 'kimi-k2' });
      const b = bodies[0]!;
      expect(b.system).toBe('stable prefix\n\nper turn');
      expect(b.tools).toEqual([tool]);
      expect(b.tool_choice).toEqual({ type: 'auto' });
      expect(b.model).toBe('auto');
      expect(b.output_config).toBeUndefined();
    });
  });

  it('direct: the stable prefix carries cache_control, effort is low, opus is claude-opus-5-5', async () => {
    await withServer(toolReply, async (base, bodies) => {
      // a direct client (no LLM_BASE_URL) whose SDK is pointed at the local server afterwards: the body is the direct one
      const { AnthropicLlm } = await import('../src/llm.js');
      const llm = new AnthropicLlm({ ...noKey, apiKey: 'k' });
      (llm as unknown as { client: { baseURL: string } }).client.baseURL = base;
      await llm.chat({ ...req, tier: 'opus' });
      const b = bodies[0]!;
      expect(b.model).toBe('claude-opus-5-5');
      expect(b.system).toEqual([{ type: 'text', text: 'stable prefix', cache_control: { type: 'ephemeral' } }, { type: 'text', text: 'per turn' }]);
      expect(b.output_config).toEqual({ effort: 'low' });
    });
  });

  it('tool results go back as user blocks and a refusal throws (tryChat turns it into null)', async () => {
    await withServer({ ...toolReply, stop_reason: 'refusal', content: [] }, async (base, bodies) => {
      const llm = createLlm({ ...noKey, baseUrl: base, apiKey: 'k' });
      const r = await tryChat(llm, {
        ...req,
        messages: [
          { role: 'user', content: 'сколько стоит?' },
          { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'price_list', input: {} }] },
          { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: '{"ok":true}' }] },
        ],
      });
      expect(r).toBeNull();
      expect((bodies[0]!.messages as unknown[])[2]).toEqual({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: '{"ok":true}' }] });
    });
  });

  it('tryChat is null when the model is off or the client has no chat; the old MockLlm is unchanged', async () => {
    expect(await tryChat(new OffLlm(), req)).toBeNull();
    expect(await tryChat(new MockLlm(() => 'x'), req)).toBeNull();
    expect((new MockLlm(() => 'x') as LlmClient).chat).toBeUndefined();
  });

  it('MockChatLlm plays a script: tool calls with ids, then text; records every request', async () => {
    const m = new MockChatLlm([{ tools: [{ name: 'price_list', input: { product: 'admin' } }] }, { text: 'Цены на сайте.' }]);
    const a = await m.chat(req);
    expect(a.stopReason).toBe('tool_use');
    expect(turnToolUses(a)[0]).toEqual({ type: 'tool_use', id: 'tu_1_0', name: 'price_list', input: { product: 'admin' } });
    const b = await m.chat(req);
    expect(turnText(b)).toBe('Цены на сайте.');
    expect(b.stopReason).toBe('end_turn');
    expect(m.chats).toHaveLength(2);
  });

  it('GatewayWatch passes chat through and watches it like complete', async () => {
    let downs = 0;
    const t = { now: 0 };
    const failing = { enabled: true, complete: () => Promise.resolve(''), chat: () => Promise.reject(Object.assign(new Error('503'), { status: 503 })) };
    const w = new GatewayWatch(failing, { thresholdMs: 0, now: () => t.now, onDown: () => void downs++, onUp: () => undefined });
    expect(w.chat).toBeTypeOf('function');
    await expect(w.chat!(req)).rejects.toThrow('503');
    expect(downs).toBe(1);
    expect(new GatewayWatch(new MockLlm(() => 'x'), { onDown: () => undefined, onUp: () => undefined }).chat).toBeUndefined();
  });
});
