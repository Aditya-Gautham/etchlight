// Quick screenshot helper: node e2e/shot.mjs <preset> <waitMs> <out.png> [scale]
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { serve } from './server.mjs';
const [preset = 'double-slit', waitMs = '4000', out = 'e2e/out/shot.png', scale = '1'] = process.argv.slice(2);
const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const { server, port } = await serve(root);
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1360, height: +(process.env.SHOT_H ?? 820) }, deviceScaleFactor: +scale });
page.on('pageerror', (e) => console.error('page error:', e));
page.on('console', (m) => { if (m.type() === 'error') console.error('console:', m.text()); });
await page.goto(`http://127.0.0.1:${port}/?preset=${preset}`);
await page.waitForTimeout(+waitMs);
await page.screenshot({ path: out });
console.log('saved', out);
await browser.close(); server.close();
