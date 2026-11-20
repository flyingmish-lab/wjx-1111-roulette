import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {JSDOM} from 'jsdom';
import {mockDb,loadFunction,telegramData} from './helpers.mjs';
async function until(predicate) {
  for(let i=0;i<500;i++) { if(predicate())return; await new Promise(resolve=>setTimeout(resolve,10)); }
  throw Error('Player UI did not settle');
}
async function setupPlayer({attempts=1,eventStart='2099-01-01',eventEnd='2099-12-31',eventWinCount=0,history=[],prepare,allowFailure=false}={}) {
  const db=mockDb();db.balances.set(123456789,attempts);db.eventWinCount=eventWinCount;
  db.settings.event_start=eventStart;db.settings.event_end=eventEnd;
  const handler=loadFunction('supabase/functions/wjx-roulette/index.ts',db).handleRoulette;
  const dom=new JSDOM(fs.readFileSync('index.html','utf8'),{url:'https://flyingmish-lab.github.io/wjx-1111-roulette/',runScripts:'outside-only'});
  const w=dom.window,alerts=[],calls=[];
  if(history.length) w.localStorage.setItem('wjxEventHistory',JSON.stringify(history));
  w.Telegram={WebApp:{initData:await telegramData(123456789),initDataUnsafe:{user:{id:123456789}}}};
  w.console={log(){},error(){}};w.alert=text=>alerts.push(text);
  w.HTMLElement.prototype.animate=()=>({finished:Promise.resolve(),cancel(){}});
  w.fetch=async(url,options)=>{calls.push(JSON.parse(options.body));return handler(new Request(url,{...options,signal:undefined}));};
  if(prepare)await prepare({w,db,handler,calls,alerts});
  w.eval([...w.document.scripts].find(s=>s.textContent.includes('const reels')).textContent);
  const el=id=>w.document.getElementById(id);
  try {await until(()=>el('eventScheduleNote').textContent.includes(eventStart.split('-').reverse().join('.'))||el('eventScheduleNote').textContent.includes('ОКОНЧЕН')||(allowFailure&&!el('retryLoadButton').hidden));}catch(error){w.close();throw error;}
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
    await until(()=>el('lastSpinResult').textContent.includes('Результат'));
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


test('reliability: startup failure is visible and a single retry reloads settings and attempts together',async()=>{
  const p=await setupPlayer({attempts:0,allowFailure:true,prepare:({w,handler,calls})=>{
    let first=true;w.fetch=async(url,options)=>{calls.push(JSON.parse(options.body));if(first){first=false;throw Error('offline');}return handler(new Request(url,{...options,signal:undefined}));};
  }});
  try {
    assert.equal(p.el('leverButton').disabled,true);assert.equal(p.el('retryLoadButton').hidden,false);
    assert.equal(p.calls.length,1);p.el('retryLoadButton').click();
    await until(()=>!p.el('leverButton').disabled);
    assert.equal(p.calls.length,2);assert.ok(p.calls.every(c=>c.action==='status'));
    assert.match(p.el('eventScheduleNote').textContent,/2099/);
  } finally {p.w.close();}
});
test('reliability: response lost after commit is recovered by the same request ID with one spent attempt',async()=>{
  const p=await setupPlayer({attempts:0,eventStart:'2000-01-01',prepare:({w,handler,calls})=>{
    let lost=false;w.fetch=async(url,options)=>{
      const body=JSON.parse(options.body);calls.push(body);const response=await handler(new Request(url,{...options,signal:undefined}));
      if(body.action==='spin'&&!lost){lost=true;throw Error('response lost');}return response;
    };
  }});
  try {
    const before=p.db.realSpinsUsed;p.el('leverButton').click();
    await until(()=>!p.el('recoverSpinButton').hidden&&!p.el('recoverSpinButton').disabled);
    assert.equal(p.db.realSpinsUsed,before+1);assert.equal(p.el('leverButton').disabled,true);
    p.el('recoverSpinButton').click();await until(()=>p.el('recoverSpinButton').hidden);
    const spins=p.calls.filter(c=>c.action==='spin');assert.equal(spins.length,2);assert.equal(spins[0].operationId,spins[1].operationId);
    assert.equal(p.db.realSpinsUsed,before+1);assert.match(p.el('lastSpinResult').textContent,/Восстановленный результат/);
    assert.equal(p.w.localStorage.getItem('wjxPendingSpin:123456789'),null);
  } finally {p.w.close();}
});
test('reliability: stored pending request recovers on restart and server history works without browser history',async()=>{
  const operationId='00000000-0000-4000-8000-000000000077';
  const p=await setupPlayer({attempts:0,eventStart:'2000-01-01',eventWinCount:2,prepare:({w,db})=>{
    w.localStorage.setItem('wjxSpins','{broken');w.localStorage.setItem('wjxEventHistory','null');
    w.localStorage.setItem('wjxPendingSpin:123456789',JSON.stringify({operationId,isTest:false}));
    db.dailyHistory=[{prize:'Картридж',spinNumber:1},{prize:'Noir Blade',spinNumber:2}];db.realSpinsUsed=2;
    db.operations.set('123456789:'+operationId,{is_test:false,result:{operationId,isTest:false,spinDate:'2026-11-20',prize:'Noir Blade'}});
  }});
  try {
    assert.match(p.el('lastSpinResult').textContent,/Noir Blade/);assert.match(p.el('prizeResult').textContent,/Картридж/);
    assert.match(p.el('myPrizes').textContent,/Картридж × 2/);assert.equal(p.el('recoverSpinButton').hidden,true);
    assert.equal(p.calls.filter(c=>c.action==='spin').length,0);
  } finally {p.w.close();}
});
test('reliability: blocked storage and broken animation cannot hide a committed result',async()=>{
  const p=await setupPlayer({attempts:0,eventStart:'2000-01-01',prepare:({w})=>{
    Object.defineProperty(w,'localStorage',{get(){throw Error('blocked storage');}});
    w.HTMLElement.prototype.animate=()=>{throw Error('animation unavailable');};
  }});
  try {
    p.el('leverButton').click();await until(()=>p.el('lastSpinResult').textContent.includes('Результат')&&!p.el('leverButton').disabled);
    assert.equal(p.db.realSpinsUsed,2);assert.equal(p.db.operations.size,1);
  } finally {p.w.close();}
});
test('reliability: server clock controls event state and returning after Moscow midnight refreshes daily history',async()=>{
  const p=await setupPlayer({attempts:0,eventStart:'2026-11-27',eventEnd:'2026-11-29',prepare:({w,db})=>{
    db.serverNow='2026-11-27T20:59:00Z';
    const Real=w.Date;w.Date=class extends Real {constructor(...args){super(...(args.length?args:['2099-01-01T00:00:00Z']));}static now(){return Real.parse('2099-01-01T00:00:00Z');}};
  }});
  try {
    assert.match(p.el('eventScheduleNote').textContent,/Розыгрыш идёт/);
    p.db.serverNow='2026-11-27T21:01:00Z';p.db.realSpinsUsed=0;p.db.dailyHistory=[];
    p.w.dispatchEvent(new p.w.Event('online'));await until(()=>p.el('bottomCounter').textContent.includes('0 из 3'));
    assert.equal(p.el('prizeResult').textContent,'1. —2. —3. —');
  } finally {p.w.close();}
});
test('reliability: timeout leaves the operation pending and online recovery never creates a second spin',async()=>{
  const p=await setupPlayer({attempts:0,eventStart:'2000-01-01',prepare:({w,handler,calls})=>{
    const originalTimeout=w.setTimeout.bind(w);w.setTimeout=(fn,ms,...args)=>originalTimeout(fn,ms===15000?10:ms,...args);
    w.fetch=async(url,options)=>{
      const body=JSON.parse(options.body);calls.push(body);const response=await handler(new Request(url,{...options,signal:undefined}));
      if(body.action==='spin')return new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>reject(new w.DOMException('Aborted','AbortError')),{once:true}));
      return response;
    };
  }});
  try {
    p.el('leverButton').click();await until(()=>!p.el('recoverSpinButton').hidden&&!p.el('recoverSpinButton').disabled);
    const used=p.db.realSpinsUsed;p.w.dispatchEvent(new p.w.Event('online'));
    await until(()=>p.el('recoverSpinButton').hidden);assert.equal(p.db.realSpinsUsed,used);
    assert.match(p.el('lastSpinResult').textContent,/Восстановленный результат/);
  } finally {p.w.close();}
});

test('reliability: older WebViews without randomUUID still generate cryptographic operation IDs',async()=>{
  const p=await setupPlayer({attempts:0,eventStart:'2000-01-01',prepare:({w})=>Object.defineProperty(w.crypto,'randomUUID',{value:undefined})});
  try {
    p.el('leverButton').click();await until(()=>p.el('lastSpinResult').textContent.includes('Результат'));
    assert.match(p.calls.find(c=>c.action==='spin').operationId,/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.equal(p.db.operations.size,1);
  } finally {p.w.close();}
});
