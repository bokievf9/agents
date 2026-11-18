import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { conditions: ['source'] },
  ssr: { resolve: { conditions: ['source'] } },
  test: { include: ['tests/**/*.test.ts'], server: { deps: { inline: [/@fir\/core/, /@fir\/hq/, /@fir\/worker-content-maker/, /@fir\/worker-(finance|lead-intake|monitoring|prospector|trend-scout|publisher|seo|analyst)/] } } },
});
