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
test('assigned attempts work through the lever without public testing controls or balances',async()=>{
  const {db,w,el,alerts,calls}=await setupPlayer();
  try {
    for(const id of ['testPlayPanel','testSpinButton','playModeNote','testModeToggle','testBalanceNote','testSpinResult'])assert.equal(el(id),null);
    assert.doesNotMatch(w.document.body.textContent,/тестов|тестирован/i);
    assert.equal(el('leverButton').getAttribute('aria-label'),'Потянуть рычаг');
    el('leverButton').click();
    await until(()=>el('lastSpinResult').textContent==='Прокрутка завершена.'&&!el('spinButton').disabled);
    assert.equal(db.balances.get(123456789),0);
    assert.equal(calls.filter(c=>c.action==='test_spin').length,1);
    assert.equal(calls.filter(c=>c.action==='spin').length,0);
    assert.equal(w.localStorage.getItem('wjxEventHistory'),null);
    assert.equal(alerts.length,0);
  } finally {w.close();}
});
test('assigned attempts bypass the future schedule without a public mode notice',async()=>{
  const {w,el,alerts,calls}=await setupPlayer();try {
    el('leverButton').click();
    await until(()=>el('lastSpinResult').textContent==='Прокрутка завершена.');
    assert.equal(calls.filter(c=>c.action==='test_spin').length,1);
    assert.equal(alerts.length,0);
  } finally {w.close();}
});
test('exhausted assigned attempts never silently spend real attempts',async()=>{
  const {w,el,calls,releaseLever}=await setupPlayer({eventStart:'2000-01-01'});try {
    el('leverButton').click();
    await until(()=>el('lastSpinResult').textContent==='Прокрутка завершена.'&&!el('spinButton').disabled);
    releaseLever();el('leverButton').click();
    await until(()=>el('lastSpinResult').textContent.includes('закончились'));
    assert.equal(calls.filter(c=>c.action==='test_spin').length,1);
    assert.equal(calls.filter(c=>c.action==='spin').length,0);
    assert.doesNotMatch(w.document.body.textContent,/тестов|тестирован/i);
  } finally {w.close();}
});
test('assigned attempts keep the lever usable after the event ends',async()=>{
  const {w,el,alerts,calls}=await setupPlayer({eventStart:'2000-01-01',eventEnd:'2001-01-01'});try {
    assert.notEqual(w.getComputedStyle(el('leverButton')).display,'none');
    assert.notEqual(w.getComputedStyle(w.document.querySelector('.reels')).display,'none');
    el('leverButton').click();
    await until(()=>el('lastSpinResult').textContent==='Прокрутка завершена.');
    assert.equal(calls.filter(c=>c.action==='test_spin').length,1);
    assert.equal(alerts.length,0);
  } finally {w.close();}
});
test('unassigned users retain the real schedule',async()=>{
  const {w,el,alerts,calls}=await setupPlayer({attempts:0});try {
    assert.equal(el('testPlayPanel'),null);
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
      if(body.action==='spin'){if(options.signal.aborted)throw new w.DOMException('Aborted','AbortError');return new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>reject(new w.DOMException('Aborted','AbortError')),{once:true}));}
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

test('subscription prompt opens only the official channel and checking never spends an attempt',async()=>{
  const p=await setupPlayer({prepare:({db})=>{db.subscribed=false;}});
  const opened=[];p.w.Telegram.WebApp.openTelegramLink=url=>opened.push(url);
  try {
    p.el('leverButton').click();
    await until(()=>!p.el('subscriptionPanel').hidden&&!p.el('spinButton').disabled);
    assert.equal(p.alerts.length,1);
    assert.match(p.alerts[0],/Чтобы крутить рулетку.*@tattoowjxrussia/);
    assert.equal(p.db.operations.size,0);assert.equal(p.db.balances.get(123456789),1);
    p.el('subscribeButton').click();assert.deepEqual(opened,['https://t.me/tattoowjxrussia']);
    p.el('checkSubscriptionButton').click();
    await until(()=>p.el('subscriptionNote').textContent.includes('не найдена')&&!p.el('checkSubscriptionButton').disabled);
    assert.equal(p.db.operations.size,0);
    assert.equal(p.alerts.length,1);
    p.db.subscribed=true;p.el('checkSubscriptionButton').click();
    await until(()=>p.el('subscriptionPanel').hidden&&!p.el('checkSubscriptionButton').disabled);
    assert.equal(p.db.operations.size,0);
    p.releaseLever();p.el('leverButton').click();
    await until(()=>p.db.operations.size===1&&!p.el('spinButton').disabled);
    assert.equal(p.db.balances.get(123456789),0);
  } finally {p.w.close();}
});
test('lever subscription popup opens the channel only after confirmation and never spends an attempt',async()=>{
  const popups=[],opened=[];
  const p=await setupPlayer({prepare:({w,db})=>{
    db.subscribed=false;
    w.Telegram.WebApp.showPopup=(params,callback)=>popups.push({params,callback});
    w.Telegram.WebApp.openTelegramLink=url=>opened.push(url);
  }});
  try {
    p.el('leverButton').click();
    await until(()=>popups.length===1&&!p.el('spinButton').disabled);
    assert.equal(popups[0].params.title,'Нужна подписка');
    assert.match(popups[0].params.message,/Чтобы крутить рулетку.*@tattoowjxrussia/);
    assert.equal(popups[0].params.buttons[0].text,'Подписаться');
    assert.equal(p.alerts.length,0);
    popups[0].callback(null);assert.equal(opened.length,0);
    popups[0].callback('subscribe');assert.deepEqual(opened,['https://t.me/tattoowjxrussia']);
    p.el('checkSubscriptionButton').click();
    await until(()=>!p.el('checkSubscriptionButton').disabled);
    assert.equal(popups.length,1);
    assert.equal(p.db.operations.size,0);assert.equal(p.db.balances.get(123456789),1);
  } finally {p.w.close();}
});
for(const mode of ['unsupported','throws'])test(`subscription popup falls back safely when Telegram popup ${mode}`,async()=>{
  const p=await setupPlayer({prepare:({w,db})=>{
    db.subscribed=false;
    w.Telegram.WebApp.showPopup=()=>{throw Error('Popup unavailable');};
    if(mode==='unsupported')w.Telegram.WebApp.isVersionAtLeast=()=>false;
  }});
  try {
    p.el('leverButton').click();
    await until(()=>p.alerts.length===1&&!p.el('spinButton').disabled);
    assert.match(p.alerts[0],/Чтобы крутить рулетку.*@tattoowjxrussia/);
    assert.equal(p.el('subscriptionPanel').hidden,false);
    assert.equal(p.db.operations.size,0);assert.equal(p.db.balances.get(123456789),1);
  } finally {p.w.close();}
});
test('paused game disables new spins and preserves access to existing prizes',async()=>{
  const p=await setupPlayer({attempts:0,eventStart:'2000-01-01',eventEnd:'2001-01-01',eventWinCount:2,prepare:({db})=>{db.settings.spins_paused=true;}});
  try {
    assert.equal(p.el('pauseNotice').hidden,false);assert.equal(p.el('leverButton').disabled,true);
    assert.equal(p.el('myPrizesPanel').hidden,false);
    assert.equal(p.w.getComputedStyle(p.el('claimPrizeButton')).display,'block');
  } finally {p.w.close();}
});
test('polling backs off when idle and refreshes on return without querying Telegram membership',async()=>{
  const timers=[];let visible=true;
  const p=await setupPlayer({attempts:0,prepare:({w})=>{
    Object.defineProperty(w.document,'hidden',{get:()=>!visible,configurable:true});
    const realTimeout=w.setTimeout.bind(w);
    w.setTimeout=(fn,ms,...args)=>{if(ms>=60000){timers.push({fn,ms});return 999;}return realTimeout(fn,ms,...args);};
  }});
  try {
    await until(()=>timers.length>0);assert.ok(timers.at(-1).ms>=300000&&timers.at(-1).ms<=345000);
    const before=p.calls.length;visible=false;p.w.document.dispatchEvent(new p.w.Event('visibilitychange'));
    assert.equal(p.calls.length,before);
    visible=true;p.w.document.dispatchEvent(new p.w.Event('visibilitychange'));
    await until(()=>p.calls.length>before&&!p.el('spinButton').disabled);
    assert.equal(p.calls.some(c=>c.action==='check_subscription'),false);
  } finally {p.w.close();}
});

test('last real daily attempt shows a persistent limit notice, clears progress and prevents extra spin requests',async()=>{
  const p=await setupPlayer({attempts:0,eventStart:'2000-01-01',prepare:({db})=>{
    db.realSpinsUsed=2;db.dailyHistory=[{prize:'Без выигрыша',spinNumber:1},{prize:'Без выигрыша',spinNumber:2}];
  }});
  try {
    assert.equal(p.el('limitMessage').hidden,true);
    p.el('leverButton').click();
    await until(()=>p.db.realSpinsUsed===3&&!p.el('limitMessage').hidden);
    assert.match(p.el('limitMessage').textContent,/На сегодня все прокрутки использованы/);
    assert.match(p.el('limitMessage').textContent,/Возвращайтесь завтра/);
    assert.equal(p.el('connectionNote').textContent,'');
    assert.equal(p.el('connectionNote').hidden,true);
    assert.equal(p.el('leverButton').disabled,true);
    assert.match(p.el('lastSpinResult').textContent,/Результат/);
    p.releaseLever();p.el('leverButton').click();p.el('spinButton').click();
    assert.equal(p.calls.filter(c=>c.action==='spin').length,1);
    p.w.dispatchEvent(new p.w.Event('online'));
    await until(()=>p.calls.filter(c=>c.action==='status').length===2&&p.el('connectionNote').hidden);
    assert.equal(p.el('limitMessage').hidden,false);
    assert.equal(p.el('leverButton').disabled,true);
  } finally {p.w.close();}
});
test('daily limit notice survives reopening and disappears after the server refreshes the Moscow day',async()=>{
  const p=await setupPlayer({attempts:0,eventStart:'2026-11-27',eventEnd:'2026-11-29',prepare:({db})=>{
    db.serverNow='2026-11-27T20:59:00Z';db.realSpinsUsed=3;
  }});
  try {
    assert.equal(p.el('limitMessage').hidden,false);assert.equal(p.el('leverButton').disabled,true);
    p.db.serverNow='2026-11-27T21:01:00Z';p.db.realSpinsUsed=0;p.db.dailyHistory=[];
    p.w.dispatchEvent(new p.w.Event('online'));
    await until(()=>p.el('bottomCounter').textContent.includes('0 из 3')&&!p.el('leverButton').disabled);
    assert.equal(p.el('limitMessage').hidden,true);
    assert.equal(p.el('connectionNote').textContent,'');
  } finally {p.w.close();}
});
test('unconfirmed last attempt retains recovery controls instead of claiming a confirmed daily limit',async()=>{
  const p=await setupPlayer({attempts:0,eventStart:'2000-01-01',prepare:({w,db,handler})=>{
    db.realSpinsUsed=2;
    w.fetch=async(url,options)=>{
      const body=JSON.parse(options.body);const response=await handler(new Request(url,{...options,signal:undefined}));
      if(body.action==='spin')throw Error('Lost committed response');
      return response;
    };
  }});
  try {
    p.el('leverButton').click();
    await until(()=>!p.el('recoverSpinButton').hidden&&!p.el('recoverSpinButton').disabled);
    assert.equal(p.el('limitMessage').hidden,true);
    assert.match(p.el('connectionNote').textContent,/Ответ не получен/);
    p.w.dispatchEvent(new p.w.Event('online'));
    await until(()=>p.el('recoverSpinButton').hidden&&!p.el('limitMessage').hidden);
    assert.equal(p.db.realSpinsUsed,3);
    assert.match(p.el('lastSpinResult').textContent,/Восстановленный результат/);
  } finally {p.w.close();}
});
test('last event day does not promise tomorrow; assigned attempts do not show a real daily limit',async()=>{
  for(const attempts of [0,1]) {
    const p=await setupPlayer({attempts,eventStart:'2026-11-27',eventEnd:'2026-11-27',prepare:({db})=>{
      db.serverNow='2026-11-27T09:00:00Z';db.realSpinsUsed=3;
    }});
    try {
      assert.equal(p.el('limitMessage').hidden,attempts>0);
      if(!attempts)assert.doesNotMatch(p.el('limitMessage').textContent,/завтра/);
      else {assert.equal(p.el('leverButton').disabled,false);p.el('leverButton').click();await until(()=>p.db.balances.get(123456789)===0);}
    } finally {p.w.close();}
  }
});
test('merch WebP participates in reels, shows the winning image and remains in real prize history',async()=>{
  const p=await setupPlayer({attempts:0,eventStart:'2000-01-01',prepare:({w,db})=>{
    w.Math.random=()=>0.99999;
    db.prizes=db.prizes.map(p=>({...p,chance:p.prize==='Мерч WJX'?100:0}));
  }});
  try {
    assert.ok(p.w.document.querySelector('img[src="wjx-merch.webp"]'),'new symbol participates in reel strips');
    p.el('leverButton').click();
    await until(()=>p.el('lastSpinResult').textContent.includes('Мерч WJX')&&!p.el('spinButton').disabled);
    assert.match(p.el('prizeResult').textContent,/Мерч WJX/);
    for(const reel of p.w.document.querySelectorAll('.reel'))assert.ok(reel.querySelector('img[src="wjx-merch.webp"]'));
    const sizes=fs.statSync('wjx-merch.webp');assert.ok(sizes.size<100000);
  } finally {p.w.close();}
});
