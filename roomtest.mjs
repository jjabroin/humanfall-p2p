import { chromium } from 'playwright';
const browser = await chromium.launch();
const page = await (await browser.newContext()).newPage();
const errs = [];
page.on('pageerror', (e) => errs.push(String(e.message ?? e).slice(0, 150)));
await page.goto('http://localhost:4173/?debug', { waitUntil: 'networkidle', timeout: 45000 });
await page.waitForTimeout(2000);
await page.fill('#nick', '테스터');
await page.click('#btnCreate');
await page.waitForTimeout(6000);
const s = await page.evaluate(() => ({
  hud: document.getElementById('hud')?.classList.contains('visible'),
  code: document.getElementById('roomCode')?.textContent,
  players: document.getElementById('players')?.innerText,
  toasts: [...document.querySelectorAll('.toast')].map((t) => t.textContent),
}));
console.log(JSON.stringify(s, null, 1));
console.log('ERRS:', errs.length ? errs.join(' | ') : '(none)');
await browser.close();
