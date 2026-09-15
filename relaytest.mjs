import { chromium } from 'playwright';
const browser = await chromium.launch();
const code = 'RL' + Math.floor(1000 + Math.random() * 9000);
const mk = async (nick) => {
  const page = await (await browser.newContext()).newPage();
  await page.goto('http://localhost:5174/?debug', { waitUntil: 'networkidle', timeout: 45000 });
  await page.waitForTimeout(2000);
  await page.fill('#nick', nick);
  await page.fill('#code', code);
  await page.click('#btnJoin');
  return page;
};
const a = await mk('호스트');
await new Promise((r) => setTimeout(r, 3000));
const b = await mk('게스트');
await new Promise((r) => setTimeout(r, 35000));
console.log('A sees:', await a.evaluate(() => document.getElementById('players')?.innerText));
console.log('B sees:', await b.evaluate(() => document.getElementById('players')?.innerText));
// A를 앞으로 이동 → B 화면의 A 아바타가 따라오는지
await a.keyboard.down('w');
await new Promise((r) => setTimeout(r, 2000));
await a.keyboard.up('w');
const pa = await a.evaluate(() => window.game.systems.get('human').pos.toArray().map((v) => +v.toFixed(1)));
await new Promise((r) => setTimeout(r, 3000));
const seenOnB = await b.evaluate(() => {
  const net = window.game.systems.get('net');
  const r = [...net.peers.values()][0];
  return r ? { name: r.name, pos: r.pos.toArray().map((v) => +v.toFixed(1)) } : null;
});
console.log('A pos:', JSON.stringify(pa), '| B sees A:', JSON.stringify(seenOnB));
await browser.close();
