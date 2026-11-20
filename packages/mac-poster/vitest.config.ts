import { defineConfig } from 'vitest/config';

// the Agent Reach tests start real shell scripts (a freshly written script costs 0.1-0.2 s per start on macOS, more under load)
export default defineConfig({
  test: { include: ['tests/**/*.test.ts'], testTimeout: 60_000 },
});
