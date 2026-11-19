#!/usr/bin/env node
// Thin entry: the logic is apps/hq/src/fresh-start.ts (compiled to dist/fresh-start.js in the image).
// Usage (on the server, HQ stopped): docker compose stop hq renderer
//   docker compose run --rm --no-deps hq node dist/fresh-start.js --i-stopped-hq
import { main } from '../dist/fresh-start.js';

process.exit(await main(process.argv.slice(2)));
