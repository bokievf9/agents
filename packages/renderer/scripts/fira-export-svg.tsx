/* eslint-disable @typescript-eslint/no-explicit-any */
// One-off exporter (NOT part of the build): renders the 16 Fira SVGs from the firtech repo source
// (src/components/fira/fira-fallback7.tsx, read-only) into assets/fira/svg/. Run from this folder:
//   npx tsx --tsconfig <tsconfig with jsx react-jsx and paths @/* -> firtech/src/*> scripts/fira-export-svg.tsx assets/fira/svg
// The committed SVGs are the source of truth for scripts/fira-assets.mjs; re-run this only when the turtle art changes.
import { writeFileSync, mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { FiraFallback7 } from '/Users/firdavs/fir-tech/firtech/src/components/fira/fira-fallback7'
const req = createRequire('/Users/firdavs/fir-tech/firtech/package.json')
const React = req('react'); (globalThis as any).React = React
const { renderToStaticMarkup } = req('react-dom/server')
const out = process.argv[2]!
mkdirSync(out, { recursive: true })
const accs: Record<string, any> = { base: [], glasses: ['glasses'], headphones: ['headphones'], laptop: ['laptop'] }
for (const e of ['idle','happy','thinking','listening'])
  for (const [a, acc] of Object.entries(accs)) {
    let s = renderToStaticMarkup(React.createElement(FiraFallback7 as any, { variant: 'a', emotion: e, dark: true, acc }))
    s = s.replace('<svg ', '<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" ').replace('fill="currentColor"', 'fill="#000"')
    writeFileSync(`${out}/${e}-${a}.svg`, s + '\n')
  }
