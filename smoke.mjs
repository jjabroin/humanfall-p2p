import { chromium } from 'playwright';

const mode = process.argv[2] ?? 'solo';
const base = process.argv[3] ?? 'http://localhost:4173/';
const browser = await chromium.launch();

if (mode === 'solo') {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push('PAGEERROR: ' + String(e).slice(0, 300)));
  await page.goto(base, { waitUntil: 'networkidle', timeout: 45000 });
  await page.waitForTimeout(2500);
  const loadingGone = await page.evaluate(() => !document.getElementById('loading'));
  await page.click('#btnSolo');
  await page.waitForTimeout(1500);
  const hud = await page.evaluate(() => document.getElementById('hud')?.classList.contains('visible'));
  const goal = await page.evaluate(() => document.getElementById('goalPill')?.textContent);
  // 앞으로 이동했는지 확인
  const p0 = await page.evaluate(() => window.game?.systems.get('human').pos.toArray());
  await page.keyboard.down('w');
  await page.waitForTimeout(1500);
  await page.keyboard.up('w');
  const p1 = await page.evaluate(() => window.game?.systems.get('human').pos.toArray());
  await page.screenshot({ path: 'shot-solo.png' });
  console.log('loadingGone:', loadingGone, '| hud:', hud, '| goalPill:', goal);
  console.log('moved:', JSON.stringify(p0), '->', JSON.stringify(p1));
  console.log('ERRORS:', errors.length ? errors.join('\n') : '(none)');
} else if (mode === 'mobile') {
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15',
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push('PAGEERROR: ' + String(e).slice(0, 300)));
  await page.goto(base, { waitUntil: 'networkidle', timeout: 45000 });
  await page.waitForTimeout(2000);
  await page.tap('#btnSolo');
  await page.waitForTimeout(1500);
  const touchUI = await page.evaluate(() => ({
    bodyTouch: document.body.classList.contains('touch'),
    btnsVisible: getComputedStyle(document.getElementById('touchUI')).display !== 'none',
    hud: document.getElementById('hud')?.classList.contains('visible'),
    hint: document.getElementById('hint')?.textContent?.slice(0, 30),
  }));
  // 가상 조이스틱 드래그 (왼쪽 영역 위로 = 전진)
  const p0 = await page.evaluate(() => window.game?.systems.get('human').pos.toArray());
  await page.touchscreen.tap(100, 600); // 터치 한 번으로 stick 표시 경로도 검증
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 100, y: 600, id: 1 }] });
  for (let i = 1; i <= 8; i++) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 100, y: 600 - i * 7, id: 1 }] });
    await page.waitForTimeout(80);
  }
  await page.waitForTimeout(1200);
  const p1 = await page.evaluate(() => window.game?.systems.get('human').pos.toArray());
  const stickShown = await page.evaluate(() => document.getElementById('stick')?.style.display);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.screenshot({ path: 'shot-mobile.png' });
  console.log('touchUI:', JSON.stringify(touchUI));
  console.log('stick display during drag:', stickShown);
  console.log('moved:', JSON.stringify(p0), '->', JSON.stringify(p1));
  console.log('ERRORS:', errors.length ? errors.join('\n') : '(none)');
} else if (mode === 'p2p') {
  const code = 'TEST' + Math.floor(100 + Math.random() * 900);
  const mk = async (nick) => {
    const ctx = await browser.newContext({ viewport: { width: 900, height: 600 } });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push('PAGEERROR: ' + String(e).slice(0, 200)));
    await page.goto(base, { waitUntil: 'networkidle', timeout: 45000 });
    await page.waitForTimeout(2000);
    await page.fill('#nick', nick);
    await page.fill('#code', code);
    await page.click('#btnJoin');
    return { page, errors };
  };
  const a = await mk('호스트');
  await a.page.waitForTimeout(3000);
  const b = await mk('게스트');
  console.log('both joined room', code, '- waiting 25s for WebRTC...');
  await a.page.waitForTimeout(25000);
  const ca = await a.page.evaluate(() => document.getElementById('players')?.innerText);
  const cb = await b.page.evaluate(() => document.getElementById('players')?.innerText);
  const na = await a.page.evaluate(() => window.game?.systems.get('net').peers.size);
  const nb = await b.page.evaluate(() => window.game?.systems.get('net').peers.size);
  console.log('A sees:', JSON.stringify(ca), '| peers:', na, '| err:', a.errors.join(';') || '(none)');
  console.log('B sees:', JSON.stringify(cb), '| peers:', nb, '| err:', b.errors.join(';') || '(none)');
}
await browser.close();
