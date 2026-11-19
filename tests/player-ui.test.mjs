import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {JSDOM} from 'jsdom';
import {mockDb,loadFunction,telegramData} from './helpers.mjs';
async function until(predicate) {
  for(let i=0;i<500;i++) { if(predicate())return; await new Promise(resolve=>setTimeout(resolve,10)); }
  throw Error('Player UI did not settle');
}
async function setupPlayer({attempts=1,eventStart='2099-01-01',eventEnd='2099-12-31',eventWinCount=0,history=[]}={}) {
  const db=mockDb();db.balances.set(123456789,attempts);db.eventWinCount=eventWinCount;
  db.settings.event_start=eventStart;db.settings.event_end=eventEnd;
  const handler=loadFunction('supabase/functions/wjx-roulette/index.ts',db).handleRoulette;
  const dom=new JSDOM(fs.readFileSync('index.html','utf8'),{url:'https://flyingmish-lab.github.io/wjx-1111-roulette/',runScripts:'outside-only'});
  const w=dom.window,alerts=[],calls=[];
  if(history.length) w.localStorage.setItem('wjxEventHistory',JSON.stringify(history));
  w.Telegram={WebApp:{initData:await telegramData(123456789),initDataUnsafe:{user:{id:123456789}}}};
  w.console={log(){},error(){}};w.alert=text=>alerts.push(text);
  w.HTMLElement.prototype.animate=()=>({finished:Promise.resolve(),cancel(){}});
  w.fetch=async(url,options)=>{calls.push(JSON.parse(options.body));return handler(new Request(url,options));};
  w.eval([...w.document.scripts].find(s=>s.textContent.includes('const reels')).textContent);
  const el=id=>w.document.getElementById(id);
  await until(()=>el('eventScheduleNote').textContent.includes(eventStart.split('-').reverse().join('.'))||el('eventScheduleNote').textContent.includes('ОКОНЧЕН'));
  const releaseLever=()=>w.document.querySelector('.lever-stick').dispatchEvent(new w.Event('animationend',{bubbles:true}));
  return {db,dom,w,el,alerts,calls,releaseLever};
}
test('test button is visible and spends only allocated tests before event dates',async()=>{
  const {db,w,el,alerts,calls}=await setupPlayer();
  try {
    assert.equal(el('testPlayPanel').hidden,false);
    assert.notEqual(w.getComputedStyle(el('testSpinButton')).display,'none');
    assert.equal(el('playModeNote').hidden,false);
    assert.equal(el('testModeToggle').checked,true);
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
test('lever uses assigned tests before event dates without a schedule rejection',async()=>{
  const {w,el,alerts,calls}=await setupPlayer();try {
    el('leverButton').click();
    await until(()=>el('testSpinResult').textContent.includes('Приз не выдаётся')&&!el('spinButton').disabled);
    assert.equal(calls.filter(c=>c.action==='test_spin').length,1);
    assert.equal(calls.filter(c=>c.action==='spin').length,0);
    assert.equal(alerts.length,0);
    assert.equal(w.localStorage.getItem('wjxEventHistory'),null);
  } finally {w.close();}
});
test('exhausted tests never fall through to real spins; real mode requires an explicit switch',async()=>{
  const {w,el,calls,releaseLever}=await setupPlayer({eventStart:'2000-01-01'});try {
    el('leverButton').click();
    await until(()=>el('testSpinResult').textContent.includes('Приз не выдаётся')&&!el('spinButton').disabled);
    releaseLever();el('leverButton').click();
    await until(()=>el('testSpinResult').textContent.includes('закончились'));
    assert.equal(el('testModeToggle').checked,true);
    assert.equal(calls.filter(c=>c.action==='test_spin').length,1);
    assert.equal(calls.filter(c=>c.action==='spin').length,0);
    releaseLever();el('testModeToggle').checked=false;
    el('testModeToggle').dispatchEvent(new w.Event('change',{bubbles:true}));
    assert.equal(el('playModeNote').hidden,true);
    el('leverButton').click();
    await until(()=>w.localStorage.getItem('wjxSpins')!==null);
    assert.equal(calls.filter(c=>c.action==='spin').length,1);
  } finally {w.close();}
});
test('assigned tests keep the lever and reels usable after the real event ends',async()=>{
  const {w,el,alerts,calls}=await setupPlayer({eventStart:'2000-01-01',eventEnd:'2001-01-01'});try {
    assert.notEqual(w.getComputedStyle(el('leverButton')).display,'none');
    assert.notEqual(w.getComputedStyle(w.document.querySelector('.reels')).display,'none');
    el('leverButton').click();
    await until(()=>el('testSpinResult').textContent.includes('Приз не выдаётся'));
    assert.equal(calls.filter(c=>c.action==='test_spin').length,1);
    assert.equal(alerts.length,0);
  } finally {w.close();}
});
test('unassigned users keep the real schedule and cannot activate testing',async()=>{
  const {w,el,alerts,calls}=await setupPlayer({attempts:0});try {
    assert.equal(el('testPlayPanel').hidden,true);
    assert.equal(el('playModeNote').hidden,true);
    el('leverButton').click();
    await until(()=>alerts.length>0);
    assert.match(alerts[0],/Розыгрыш начнётся/);
    assert.equal(calls.filter(c=>c.action==='test_spin'||c.action==='spin').length,0);
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

test('after the event claim opens only the manager chat for a real server-confirmed winner',async()=>{
  const {w,el,calls,alerts}=await setupPlayer({attempts:0,eventStart:'2000-01-01',eventEnd:'2001-01-01',eventWinCount:2});
  const links=[];w.Telegram.WebApp.openTelegramLink=url=>links.push(url);
  try {
    assert.equal(w.getComputedStyle(el('claimPrizeButton')).display,'block');
    const before=calls.length;el('claimPrizeButton').click();
    assert.deepEqual(links,['https://t.me/Wjx_wjxx']);
    assert.equal(calls.length,before);assert.equal(alerts.length,0);
  } finally {w.close();}
});
test('local browser prize history cannot enable claiming; tests and active events cannot claim',async()=>{
  for(const values of [
    {attempts:0,eventStart:'2000-01-01',eventEnd:'2001-01-01',eventWinCount:0,history:[{date:'2000-01-01',prize:'🎁 Картридж'}]},
    {attempts:0,eventStart:'2000-01-01',eventWinCount:2},
    {attempts:1,eventStart:'2000-01-01',eventEnd:'2001-01-01',eventWinCount:2},
  ]) {
    const {w,el}=await setupPlayer(values);const links=[];w.Telegram.WebApp.openTelegramLink=url=>links.push(url);
    try {
      assert.equal(w.getComputedStyle(el('claimPrizeButton')).display,'none');el('claimPrizeButton').click();assert.equal(links.length,0);
    } finally {w.close();}
  }
});
