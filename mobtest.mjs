import { chromium } from 'playwright';
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 3 });
const page = await ctx.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push(String(e.message ?? e).slice(0, 120)));
await page.goto('http://localhost:4173/?debug', { waitUntil: 'networkidle', timeout: 45000 });
await page.waitForTimeout(2000);
await page.tap('#btnSolo');
await page.waitForTimeout(2000);
const q0 = await page.evaluate(() => ({ pr: window.game.pr, cap: window.game.prCap, actual: window.game.renderer.getPixelRatio() }));
// 방향 전환 시뮬레이션 (가로로 변경)
await page.setViewportSize({ width: 844, height: 390 });
await page.waitForTimeout(1500);
const q1 = await page.evaluate(() => ({ w: innerWidth, h: innerHeight, canvas: [document.getElementById('game').width, document.getElementById('game').height] }));
// 세로로 복귀
await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(1000);
console.log('quality:', JSON.stringify(q0));
console.log('rotated:', JSON.stringify(q1));
console.log('ERRS:', errs.length ? errs.join(' | ') : '(none)');
await browser.close();
