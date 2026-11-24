import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {JSDOM} from 'jsdom';
import {env,mockDb,loadFunction,request} from './helpers.mjs';
const html=fs.readFileSync('admin.html','utf8');
const script=fs.readFileSync('admin.js','utf8');
async function until(predicate) {
  for(let i=0;i<500;i++) {if(predicate()) return; await new Promise(resolve=>setTimeout(resolve,10));}
  throw Error('UI did not settle');
}
function setup({clockOffset=0,telegramFetch}={}) {
  const db=mockDb();
  const auth=loadFunction('supabase/functions/wjx-admin-auth/index.ts',db).handleAdminAuth;
  const roulette=loadFunction('supabase/functions/wjx-roulette/index.ts',db,env,telegramFetch?{fetch:telegramFetch}:{}).handleRoulette;
  const dom=new JSDOM(html,{url:'https://flyingmish-lab.github.io/wjx-1111-roulette/admin.html',runScripts:'outside-only'});
  const w=dom.window; const calls=[];let expire,expiryDelay;
  w.Date=class DeviceDate extends Date {
    constructor(...args) {super(...(args.length?args:[Date.now()+clockOffset]));}
    static now() {return Date.now()+clockOffset;}
  };
  const nativeTimeout=w.setTimeout.bind(w);
  w.setTimeout=(fn,delay)=>{if(delay===3600000){expire=fn;expiryDelay=delay;return 99999;}return nativeTimeout(fn,delay);};
  w.fetch=async(url,options)=>{
    const body=JSON.parse(options.body); calls.push({url,body,headers:options.headers});
    const req=new Request(url,{...options,signal:undefined});
    return url.endsWith('wjx-admin-auth')?auth(req):roulette(req);
  };
  w.sessionStorage.setItem('wjxAdminInitData','legacy');
  w.eval(script);
  const el=id=>w.document.getElementById(id);
  const click=id=>el(id).dispatchEvent(new w.Event('click',{bubbles:true}));
  async function login(password=env.WJX_ADMIN_PASSWORD) {
    el('adminPassword').value=password;
    el('loginForm').dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));
    assert.equal(el('adminPassword').value,'');
    await until(()=>!el('loginButton').disabled);
  }
  return {db,dom,w,el,click,calls,login,expire:()=>expire(),expiryDelay:()=>expiryDelay};
}

test('prize stock plan is a draft until saved, validates caps and clears with the session',async()=>{
  const {w,el,login,click,calls,expire}=setup();
  try {
    await login();
    const limits=()=>[...w.document.querySelectorAll('.prizeLimitInput')];
    assert.equal(limits().length,6);
    const before=calls.length;click('suggestPrizePlanButton');
    assert.equal(calls.length,before);
    assert.equal(el('prizeChancesTotal').textContent,'Итого: 100.0000%');
    assert.deepEqual(limits().map(i=>[i.dataset.prize,Number(i.value)]),[
      ['Картридж',20],['Расходники',30],['Noir Blade',3],['Soul Ink',20],['Бандажка',50],['Мерч WJX',10]]);
    limits()[0].value='1.5';click('savePrizeChancesButton');
    assert.equal(calls.length,before);assert.match(el('statusMessage').textContent,/целым/);
    limits()[0].value='20';click('savePrizeChancesButton');
    await until(()=>!el('savePrizeChancesButton').disabled);
    const save=calls.find(c=>c.body.action==='admin_save_prize_chances').body;
    assert.equal(save.limitScope,'day');
    const saved=save.prizes;
    assert.equal(saved.find(p=>p.prize==='Noir Blade').chance,0.1);
    assert.equal(saved.find(p=>p.prize==='Мерч WJX').chance,0.3333);
    assert.equal(saved.find(p=>p.prize==='Мерч WJX').prize_limit,10);
    assert.match(el('prizeStockDate').textContent,/23.11.2026/);
    assert.equal(saved.find(p=>p.prize==='Noir Blade').prize_limit,3);
    assert.equal(saved.find(p=>p.prize==='Без выигрыша').prize_limit,null);
    assert.match(el('prizeChancesFields').textContent,/Осталось сегодня:/);
    expire();assert.equal(limits().length,0);
  } finally {w.close();}
});
test('browser login, settings, statistics, prize chances and logout work without Telegram',async()=>{
  const ui=setup();const {el,login,click,db,calls,w}=ui;
  try {
    assert.equal(el('adminContent').hidden,true);
    assert.equal(calls.length,0);
    assert.equal(w.sessionStorage.getItem('wjxAdminInitData'),null);
    assert.equal(w.Telegram,undefined);
    await login('incorrect');
    assert.equal(el('adminContent').hidden,true);
    assert.match(el('statusMessage').textContent,/Неверный пароль/);
    await login();
    assert.equal(el('adminContent').hidden,false);
    assert.equal(el('settingsFields').disabled,false);
    assert.equal(w.document.querySelectorAll('.prizeChanceInput').length,7);
    assert.match(el('prizesPanel').textContent,/1200/);
    assert.equal(calls.some(c=>c.body.initData),false);
    assert.equal(w.sessionStorage.length,0);
    assert.equal(w.localStorage.length,0);
    el('dailySpins').value='5';click('saveButton');
    await until(()=>!el('saveButton').disabled);
    assert.equal(db.settings.daily_spins,5);
    const before=calls.length;
    w.document.querySelector('.prizeChanceInput').value='99';click('savePrizeChancesButton');
    assert.equal(calls.length,before);assert.match(el('statusMessage').textContent,/100%/);
    w.document.querySelector('.prizeChanceInput').value='10';click('savePrizeChancesButton');
    await until(()=>!el('savePrizeChancesButton').disabled);
    assert.match(el('statusMessage').textContent,/Вероятности сохранены/);
    const token=calls.find(c=>c.body.action==='admin_get_settings').headers.Authorization.slice(7);
    click('logoutButton');
    assert.equal(el('adminContent').hidden,true);
    await until(()=>db.sessions.size===0);
    const handler=loadFunction('supabase/functions/wjx-roulette/index.ts',db).handleRoulette;
    assert.equal((await handler(request({action:'admin_get_settings'},token))).status,401);
  } finally {ui.dom.window.close();}
});
test('expired sessions clear controls and fetched data',async()=>{
  const ui=setup();try {
    await ui.login();ui.expire();
    assert.equal(ui.el('adminContent').hidden,true);
    assert.equal(ui.el('prizeChancesFields').children.length,0);
    assert.equal(ui.el('settingsFields').disabled,true);
    assert.match(ui.el('statusMessage').textContent,/Сессия истекла/);
  } finally {ui.dom.window.close();}
});
test('participant names and prize history are rendered as text',async()=>{
  const ui=setup();const rpc=ui.db.rpc;
  ui.db.rpc=async(name,args)=>name==='wjx_admin_prize_stats'?{data:{limitScope:'day',stockDate:'2026-11-23',prizes:[],history:[{username:'<img src=x onerror=alert(1)>',spin_date:'2026-11-19',prize:'<script>evil()</script>'}]}}:rpc(name,args);
  try {
    await ui.login();
    assert.match(ui.el('winsHistory').textContent,/<img/);
    assert.equal(ui.el('winsHistory').querySelectorAll('img,script').length,0);
  } finally {ui.dom.window.close();}
});

test('admin resets only today attempts of the selected user, preserving wins and retry identity after a lost response',async()=>{
 const ui=setup();try{
  ui.db.realSpinsUsed=3;ui.db.eventWinCount=2;await ui.login();
  assert.equal(ui.el('spinUserSelect').value,'123456789');assert.equal(ui.el('testAttempts'),null);
  assert.match(ui.el('spinUserSelect').textContent,/Сегодня использовано: 3/);
  const original=ui.w.fetch;let lost=false;
  ui.w.fetch=async(url,options)=>{const response=await original(url,options);if(JSON.parse(options.body).action==='admin_reset_daily_spins'&&!lost){lost=true;throw Error('lost response');}return response;};
  ui.click('resetDailySpinsButton');await until(()=>!ui.el('resetDailySpinsButton').disabled);
  assert.equal(ui.db.resets.size,1);assert.match(ui.el('statusMessage').textContent,/lost response/);
  const savedId=ui.calls.find(c=>c.body.action==='admin_reset_daily_spins').body.requestId;
  assert.equal(ui.w.sessionStorage.getItem('wjxDailyReset:123456789'),savedId);
  ui.db.realSpinsUsed++;ui.click('resetDailySpinsButton');await until(()=>!ui.el('resetDailySpinsButton').disabled);
  const resets=ui.calls.filter(c=>c.body.action==='admin_reset_daily_spins');assert.equal(resets.length,2);assert.equal(resets[1].body.requestId,savedId);
  assert.equal(ui.db.resets.size,1);assert.equal(ui.db.eventWinCount,2);assert.equal(ui.db.settings.daily_spins,3);
  assert.match(ui.el('spinUserSelect').textContent,/Осталось: 2/);assert.match(ui.el('statusMessage').textContent,/Призы сохранены/);
  assert.equal(ui.w.sessionStorage.getItem('wjxDailyReset:123456789'),null);
 }finally{ui.w.close();}
});

test('valid server sessions are accepted when device time is ahead or behind',async()=>{
  for(const clockOffset of [-86400000,-300000,300000,86400000]) {
    const ui=setup({clockOffset});try {
      await ui.login();
      assert.equal(ui.el('adminContent').hidden,false,`clock offset ${clockOffset}`);
      assert.equal(ui.el('settingsFields').disabled,false);
      assert.equal(ui.expiryDelay(),3600000);
      assert.equal(ui.el('statusMessage').textContent,'Настройки загружены.');
    } finally {ui.dom.window.close();}
  }
});

test('winner nickname opens server totals for the event and skips empty outcomes',async()=>{
  const ui=setup();ui.db.eventWinCount=3;
  const originalRpc=ui.db.rpc;
  ui.db.rpc=async(name,args)=>name==='wjx_admin_prize_stats'?{data:{limitScope:'day',stockDate:'2026-11-23',prizes:[],history:[
    {telegram_id:'123456789',username:'player',spin_date:'2026-11-27',prize:'Картридж'},
    {telegram_id:'123456789',username:'player',spin_date:'2026-11-28',prize:'Без выигрыша'},
    {telegram_id:'123456789',username:'player',spin_date:'2026-11-28',prize:null},
  ]}}:originalRpc(name,args);
  try {
    await ui.login();
    assert.equal(ui.el('settingsFields').disabled,false);
    const nickname=ui.el('winnersList').querySelector('button');
    assert.equal(nickname.textContent,'@player');nickname.click();
    await until(()=>ui.el('winnerDetails').textContent.includes('Всего реальных призов: 3'));
    assert.match(ui.el('winnerDetails').textContent,/Картридж × 3/);
    assert.equal(ui.el('winnerDetails').textContent.includes('Без выигрыша'),false);
    assert.equal(ui.el('winsHistory').querySelectorAll('p').length,1);
    assert.equal(ui.el('winsHistory').textContent.includes('Без выигрыша'),false);
    ui.el('winnerSearch').value='@player';ui.click('findWinnersButton');
    await until(()=>ui.calls.some(c=>c.body.action==='admin_get_winners'&&c.body.search==='player'));
    assert.equal(ui.calls.some(c=>c.body.action==='admin_get_user_wins'&&c.body.telegram_id==='123456789'),true);
  } finally {ui.dom.window.close();}
});

test('admin marks delivery once and sees updated remaining prizes without changing winnings',async()=>{
  const {w,el,db}=await setup();
  try {
    db.eventWinCount=3;db.canDeliver=true;
    el('adminPassword').value='test-only-password';el('loginForm').dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));
    await until(()=>el('statusMessage').textContent==='Настройки загружены.');
    el('winnersList').querySelector('button').click();await until(()=>!el('winnerDetails').textContent.includes('Загружаем'));
    const issue=el('winnerDetails').querySelector('button');assert.ok(issue);issue.click();
    await until(()=>el('winnerDetails').textContent.includes('Осталось выдать: 0'));
    assert.equal(el('winnerDetails').querySelector('button'),null);assert.equal(db.deliveries.get(123456789),3);
    assert.match(el('winnerDetails').textContent,/Всего реальных призов: 3/);
  } finally {w.close();}
});


test('browser admin checks and connects bot commands without displaying credentials',async()=>{
  const methods=[];
  const ui=setup({telegramFetch:async(url,options)=>{
    const method=url.split('/').at(-1);methods.push(method);
    return Response.json({ok:true,result:method==='getWebhookInfo'?{url:'',pending_update_count:0}:method==='getMe'?{username:'WjxBot'}:true});
  }});
  try {
    await ui.login();ui.click('checkBotButton');await until(()=>!ui.el('checkBotButton').disabled);
    assert.match(ui.el('botConnectionNote').textContent,/ещё не подключён/);
    ui.click('configureBotButton');await until(()=>!ui.el('configureBotButton').disabled);
    assert.match(ui.el('botConnectionNote').textContent,/Команды подключены для @WjxBot/);
    assert.ok(methods.includes('setWebhook'));
    assert.equal(ui.w.document.body.textContent.includes(env.TELEGRAM_BOT_TOKEN),false);
    ui.click('logoutButton');assert.equal(ui.el('botConnectionNote').textContent,'');
  } finally {ui.w.close();}
});

test('admin pause applies separately without saving or resetting draft dates',async()=>{
  const p=setup();try {
    await p.login();
    const original=p.db.settings.event_start;p.el('startDate').value='2027-01-01';p.el('spinsPaused').checked=true;p.click('savePauseButton');
    await until(()=>!p.el('savePauseButton').disabled);
    assert.equal(p.db.settings.spins_paused,true);assert.equal(p.db.settings.event_start,original);
    assert.equal(p.el('startDate').value,'2027-01-01');
    p.el('spinsPaused').checked=false;p.click('savePauseButton');await until(()=>!p.el('savePauseButton').disabled);
    assert.equal(p.db.settings.spins_paused,false);
  } finally {p.w.close();}
});
test('daily probability calculator uses edited caps and attempt allowance without overwriting limits or saving',async()=>{
  const {w,el,click,login,calls}=setup();try {
    await login();
    const merchLimit=[...w.document.querySelectorAll('.prizeLimitInput')].find(i=>i.dataset.prize==='Мерч WJX');
    const merchChance=[...w.document.querySelectorAll('.prizeChanceInput')].find(i=>i.dataset.prize==='Мерч WJX');
    merchLimit.value='20';el('dailySpins').value='5';const before=calls.length;
    click('suggestPrizePlanButton');
    assert.equal(merchChance.value,'0.4');assert.equal(merchLimit.value,'20');
    assert.equal(calls.length,before);assert.match(el('statusMessage').textContent,/5000/);
    assert.equal(el('prizeChancesTotal').textContent,'Итого: 100.0000%');
    merchLimit.value='';click('suggestPrizePlanButton');
    assert.match(el('statusMessage').textContent,/Безлимитные/);assert.equal(merchChance.value,'0.4');assert.equal(calls.length,before);
  } finally {w.close();}
});
test('reset retry keeps its UUID when the reset succeeded but user-list refresh failed',async()=>{
 const ui=setup();try{
  ui.db.realSpinsUsed=3;await ui.login();
  const rpc=ui.db.rpc;let failed=false;
  ui.db.rpc=async(name,args)=>{if(name==='wjx_admin_spin_users'&&ui.db.resets.size&&!failed){failed=true;return {error:{code:'unavailable'}};}return rpc(name,args);};
  ui.click('resetDailySpinsButton');await until(()=>!ui.el('resetDailySpinsButton').disabled);
  const saved=ui.calls.find(c=>c.body.action==='admin_reset_daily_spins').body.requestId;
  assert.equal(ui.w.sessionStorage.getItem('wjxDailyReset:123456789'),saved);
  ui.db.realSpinsUsed++;ui.click('resetDailySpinsButton');await until(()=>!ui.el('resetDailySpinsButton').disabled);
  assert.equal(ui.db.resets.size,1);assert.equal(ui.calls.filter(c=>c.body.action==='admin_reset_daily_spins')[1].body.requestId,saved);
  assert.match(ui.el('spinUserSelect').textContent,/Осталось: 2/);
 }finally{ui.w.close();}
});

test('prize reset confirms participant, preserves attempts and retries lost responses with same UUID',async()=>{
 const ui=setup();const {w,el,login,click,db,calls}=ui;try{
  await login();db.eventWinCount=2;
  const prompts=[];w.confirm=text=>{prompts.push(text);return false;};
  click('resetUserPrizesButton');assert.equal(calls.some(c=>c.body.action==='admin_reset_user_prizes'),false);
  assert.match(prompts[0],/123456789/);assert.match(prompts[0],/не вернутся в запас/);
  w.confirm=()=>true;
  const fetch=w.fetch;let lose=true;
  w.fetch=async(url,options)=>{const response=await fetch(url,options);if(JSON.parse(options.body).action==='admin_reset_user_prizes'&&lose){lose=false;throw Error('Lost response');}return response;};
  const used=db.realSpinsUsed;click('resetUserPrizesButton');
  await until(()=>!el('resetUserPrizesButton').disabled);
  assert.equal(db.eventWinCount,0);assert.equal(db.realSpinsUsed,used);
  db.eventWinCount=1;click('resetUserPrizesButton');await until(()=>el('statusMessage').textContent.includes('Ранее выполненный сброс'));
  const resets=calls.filter(c=>c.body.action==='admin_reset_user_prizes');assert.equal(resets.length,2);
  assert.equal(resets[0].body.requestId,resets[1].body.requestId);assert.equal(db.eventWinCount,1);
  assert.match(el('statusMessage').textContent,/123456789/);
  assert.equal(w.sessionStorage.getItem('wjxDailyReset:prizes:123456789'),null);
 }finally{w.close();}
});
