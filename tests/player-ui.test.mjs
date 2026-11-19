import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {JSDOM} from 'jsdom';
import {mockDb,loadFunction,telegramData} from './helpers.mjs';
async function until(predicate) {
  for(let i=0;i<500;i++) { if(predicate())return; await new Promise(resolve=>setTimeout(resolve,10)); }
  throw Error('Player UI did not settle');
}
test('test button spends only allocated tests, outside event dates, without recording claimable prizes',async()=>{
  const db=mockDb();db.balances.set(123456789,1);db.settings.event_start='2099-01-01';
  const handler=loadFunction('supabase/functions/wjx-roulette/index.ts',db).handleRoulette;
  const dom=new JSDOM(fs.readFileSync('index.html','utf8'),{url:'https://flyingmish-lab.github.io/wjx-1111-roulette/',runScripts:'outside-only'});
  const w=dom.window;const alerts=[];const calls=[];
  try {
    w.Telegram={WebApp:{initData:await telegramData(123456789),initDataUnsafe:{user:{id:123456789}}}};
    w.console={log(){},error(){}};w.alert=text=>alerts.push(text);
    w.HTMLElement.prototype.animate=()=>({finished:Promise.resolve(),cancel(){}});
    w.fetch=async(url,options)=>{calls.push(JSON.parse(options.body));return handler(new Request(url,options));};
    const script=[...w.document.scripts].find(s=>s.textContent.includes('const reels')).textContent;
    w.eval(script);
    const el=id=>w.document.getElementById(id);
    await until(()=>!el('testPlayPanel').hidden);
    assert.match(el('testBalanceNote').textContent,/1/);
    el('testSpinButton').click();
    await until(()=>el('testSpinResult').textContent.length>0&&!el('spinButton').disabled);
    assert.match(el('testSpinResult').textContent,/Приз не выдаётся/);
    assert.match(el('testBalanceNote').textContent,/попыток: 0/);
    assert.equal(el('testSpinButton').disabled,true);
    assert.equal(w.localStorage.getItem('wjxSpins'),null);
    assert.equal(w.localStorage.getItem('wjxEventHistory'),null);
    assert.equal(db.balances.get(123456789),0);
    assert.equal(calls.filter(c=>c.action==='test_spin').length,1);
    assert.equal(calls.filter(c=>c.action==='spin').length,0);
    assert.equal(alerts.length,0);
  } finally {w.close();}
});
test('flattened dashboard build preserves the configuration guard and authenticated API',async()=>{
  const db=mockDb();
  const auth=loadFunction('dashboard-dist/wjx-admin-auth/index.ts',db).handleAdminAuth;
  const roulette=loadFunction('dashboard-dist/wjx-roulette/index.ts',db).handleRoulette;
  const req=new Request('https://test.invalid',{method:'POST',headers:{'content-type':'application/json'},body:'{"action":"check_configuration"}'});
  assert.equal((await auth(req)).status,400);
  const denied=new Request('https://test.invalid',{method:'POST',headers:{'content-type':'application/json'},body:'{"action":"admin_test_users"}'});
  assert.equal((await roulette(denied)).status,401);
});
