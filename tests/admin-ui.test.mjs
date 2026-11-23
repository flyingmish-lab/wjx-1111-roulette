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
    assert.equal(w.document.querySelectorAll('.prizeChanceInput').length,6);
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
  ui.db.rpc=async(name,args)=>name==='wjx_admin_prize_stats'?{data:{prizes:[],history:[{username:'<img src=x onerror=alert(1)>',spin_date:'2026-11-19',prize:'<script>evil()</script>'}]}}:rpc(name,args);
  try {
    await ui.login();
    assert.match(ui.el('winsHistory').textContent,/<img/);
    assert.equal(ui.el('winsHistory').querySelectorAll('img,script').length,0);
  } finally {ui.dom.window.close();}
});

test('admin selects an existing user and sets or revokes a test balance',async()=>{
  const ui=setup();try {
    await ui.login();
    assert.equal(ui.el('testUserSelect').value,'123456789');
    ui.el('testAttempts').value='7';ui.click('setTestAttemptsButton');
    await until(()=>!ui.el('setTestAttemptsButton').disabled);
    assert.equal(ui.db.balances.get(123456789),7);
    ui.el('testAttempts').value='0';ui.click('setTestAttemptsButton');
    await until(()=>!ui.el('setTestAttemptsButton').disabled);
    assert.equal(ui.db.balances.get(123456789),0);
    assert.equal(ui.db.settings.daily_spins,3);
  } finally {ui.dom.window.close();}
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
  ui.db.rpc=async(name,args)=>name==='wjx_admin_prize_stats'?{data:{prizes:[],history:[
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
