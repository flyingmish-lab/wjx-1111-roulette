import test from 'node:test';
import assert from 'node:assert/strict';
import {telegramWebhookSecret, MINI_APP_URL, MANAGER_URL, BOT_COMMANDS} from '../supabase/functions/_shared/telegram-bot.ts';
import {env,mockDb,loadFunction,request,telegramData} from './helpers.mjs';
import {issueSession} from '../supabase/functions/_shared/admin-session.ts';
const path='supabase/functions/wjx-telegram-bot/index.ts';
async function setup(entry=path) {
  const db=mockDb();const handler=loadFunction(entry,db).handleTelegramBot;
  const secret=await telegramWebhookSecret(env.WJX_ADMIN_SESSION_SECRET,env.TELEGRAM_BOT_TOKEN);
  const body=(text,id=123456789)=>({update_id:42,message:{message_id:3,chat:{id,type:'private'},from:{id,is_bot:false},text}});
  const send=(update,header=secret)=>handler(request(update,'',{'X-Telegram-Bot-Api-Secret-Token':header}));
  return {db,handler,secret,body,send};
}
test('webhook authenticates Telegram before reading participant data and ignores public/forged messages',async()=>{
  const p=await setup();
  for(const header of ['', 'wrong', 'a'.repeat(64)])assert.equal((await p.send(p.body('/prizes'),header)).status,401);
  assert.equal(p.db.calls.length,0);
  assert.equal((await p.handler(new Request('https://test.invalid'))).status,405);
  for(const edit of [u=>u.message.chat.type='group',u=>u.message.chat.id=382749857,u=>u.message.from.is_bot=true,u=>u.message.from.id=-1]){
    const update=p.body('/prizes');edit(update);assert.deepEqual(await (await p.send(update)).json(),{ok:true});
  }
  assert.equal(p.db.calls.length,0);
  assert.deepEqual(await (await p.send(p.body('hello'))).json(),{ok:true});
  assert.deepEqual(await (await p.send({update_id:1,edited_message:p.body('/prizes').message})).json(),{ok:true});
});
test('start/play/help work equally for all users and never spend attempts or expose an admin panel',async()=>{
  const p=await setup();
  for(const id of [221535678,382749857,123456789])for(const command of ['/start','/start referral','/play','/PLAY@WjxBot','/help']){
    const r=await p.send(p.body(command,id));assert.equal(r.status,200);const reply=await r.json();
    assert.equal(reply.method,'sendMessage');assert.equal(reply.chat_id,id);
    const buttons=reply.reply_markup.inline_keyboard.flat();
    assert.ok(buttons.some(b=>b.web_app?.url===MINI_APP_URL));
    if(command==='/help')assert.ok(buttons.some(b=>b.url===MANAGER_URL));
    assert.equal(JSON.stringify(reply).includes('admin.html'),false);assert.equal(reply.parse_mode,undefined);
  }
  assert.equal(p.db.calls.length,0);
});
test('rules always use current configured dates and daily limit, including changes after launch',async()=>{
  const p=await setup();p.db.settings={...p.db.settings,event_start:'2026-12-05',event_end:'2026-12-07',start_time:'11:30:00',end_time:'20:15:00',daily_spins:4};
  let text=(await (await p.send(p.body('/rules'))).json()).text;
  for(const value of ['05.12.2026','07.12.2026','11:30','20:15','Попыток в день: 4','00:00 МСК'])assert.ok(text.includes(value));
  p.db.settings.event_start='2026-12-10';p.db.settings.event_end='2026-12-12';
  text=(await (await p.send(p.body('/rules'))).json()).text;assert.match(text,/10\.12\.2026/);assert.equal(text.includes('05.12.2026'),false);
});
test('prizes bind to the actual sender, omit tests and misses, and show delivery totals from the server',async()=>{
  const p=await setup();p.db.eventWinCount=3;p.db.deliveries.set(123456789,1);
  const reply=await (await p.send(p.body('/prizes 221535678 @owner'))).json();
  assert.equal(reply.chat_id,123456789);assert.match(reply.text,/Картридж × 3/);assert.match(reply.text,/Выдано: 1\. Осталось выдать: 2/);
  assert.equal(p.db.calls.find(c=>c.rpc==='wjx_user_prize_summary').args.p_telegram_id,123456789);
  assert.equal(p.db.calls.some(c=>c.rpc==='wjx_use_test_spin'||c.rpc==='wjx_perform_spin'||c.operation==='upsert'),false);
  p.db.rpc=async()=>({data:null});assert.match((await (await p.send(p.body('/prizes'))).json()).text,/ещё не участвовали/);
  p.db.rpc=async()=>({data:{period:p.db.settings,total_wins:0,prizes:[{prize:'Без выигрыша',quantity:9},{prize:'',quantity:1}]}});
  assert.match((await (await p.send(p.body('/prizes'))).json()).text,/Реальных выигрышей.*нет/);
});
test('webhook fails closed on database/configuration errors without exposing secrets',async()=>{
  const p=await setup();p.db.rpc=async()=>({error:{code:'offline'}});
  const response=await p.send(p.body('/prizes'));assert.equal(response.status,503);
  const text=await response.text();assert.equal(text.includes(env.TELEGRAM_BOT_TOKEN),false);assert.equal(text.includes(p.secret),false);
  const bad=loadFunction(path,mockDb(),{...env,WJX_ADMIN_SESSION_SECRET:''}).handleTelegramBot;
  assert.equal((await bad(request(p.body('/start')))).status,503);
  const different=await telegramWebhookSecret(env.WJX_ADMIN_SESSION_SECRET+'x',env.TELEGRAM_BOT_TOKEN);assert.notEqual(different,p.secret);
});
function fakeTelegram({otherWebhook=false,fail=false}={}){
  const calls=[];
  const fetch=async(url,options)=>{
    const method=url.split('/').at(-1),body=JSON.parse(options.body);calls.push({method,body});
    const result=method==='getWebhookInfo'?{url:otherWebhook?'https://existing.invalid/private?secret=never-echo-this':'',pending_update_count:0}:method==='getMe'?{username:'WjxBot'}:true;
    return Response.json(fail?{ok:false,description:'private upstream details'}:{ok:true,result},{status:fail?500:200});
  };return {calls,fetch};
}
test('only a browser admin can configure commands; existing webhook is never silently replaced',async()=>{
  const db=mockDb(),fake=fakeTelegram();
  const roulette=loadFunction('supabase/functions/wjx-roulette/index.ts',db,env,{fetch:fake.fetch}).handleRoulette;
  const owner=await telegramData(221535678);
  for(const action of ['admin_bot_status','admin_configure_bot'])assert.equal((await roulette(request({action,initData:owner}))).status,401);
  assert.equal(fake.calls.length,0);
  const s=await issueSession(env.WJX_ADMIN_PASSWORD,env.WJX_ADMIN_SESSION_SECRET);db.sessions.set(s.tokenHash,{expires_at:s.expiresAt});
  const status=await roulette(request({action:'admin_bot_status'},s.token));assert.equal(status.status,200);assert.equal((await status.json()).connected,false);
  const configured=await roulette(request({action:'admin_configure_bot'},s.token));assert.equal(configured.status,200);
  const names=fake.calls.filter(c=>c.method==='setMyName');
  assert.deepEqual(names.map(c=>c.body),[{name:'WJX Рулетка',language_code:''},{name:'WJX Рулетка',language_code:'ru'}]);
  const commands=fake.calls.filter(c=>c.method==='setMyCommands');assert.equal(commands.length,4);assert.deepEqual(commands[0].body.commands,BOT_COMMANDS);
  const webhook=fake.calls.find(c=>c.method==='setWebhook');assert.equal(webhook.body.url,env.SUPABASE_URL+'/functions/v1/wjx-telegram-bot');
  assert.equal(webhook.body.drop_pending_updates,false);assert.deepEqual(webhook.body.allowed_updates,['message']);
  assert.equal(webhook.body.secret_token,await telegramWebhookSecret(env.WJX_ADMIN_SESSION_SECRET,env.TELEGRAM_BOT_TOKEN));
  const response=JSON.stringify(await configured.json());assert.equal(response.includes(webhook.body.secret_token),false);assert.equal(response.includes(env.TELEGRAM_BOT_TOKEN),false);
  const old=fakeTelegram({otherWebhook:true});const guarded=loadFunction('supabase/functions/wjx-roulette/index.ts',db,env,{fetch:old.fetch}).handleRoulette;
  const blocked=await guarded(request({action:'admin_configure_bot'},s.token));assert.equal(blocked.status,409);
  assert.deepEqual(old.calls.map(c=>c.method),['getWebhookInfo']);assert.equal((await blocked.text()).includes('never-echo-this'),false);
});
test('flattened bot build authenticates and replies exactly like source',async()=>{
  const p=await setup('dashboard-dist/wjx-telegram-bot/index.ts');
  const reply=await (await p.send(p.body('/play'))).json();assert.equal(reply.reply_markup.inline_keyboard[0][0].web_app.url,MINI_APP_URL);
  assert.equal((await p.send(p.body('/rules'),'forged')).status,401);
});

test('admin connection diagnostics never expose upstream errors or bot credentials',async()=>{
  const db=mockDb();const s=await issueSession(env.WJX_ADMIN_PASSWORD,env.WJX_ADMIN_SESSION_SECRET);db.sessions.set(s.tokenHash,{expires_at:s.expiresAt});
  for(const mode of ['http','network']) {
    const fetch=async()=>{
      if(mode==='network')throw Error('https://api.telegram.org/bot'+env.TELEGRAM_BOT_TOKEN);
      return Response.json({ok:false,error_code:500,description:'private upstream details'},{status:500});
    };
    const roulette=loadFunction('supabase/functions/wjx-roulette/index.ts',db,env,{fetch}).handleRoulette;
    const response=await roulette(request({action:'admin_bot_status'},s.token));assert.equal(response.status,503);
    const data=await response.json();assert.equal(data.error.includes(env.TELEGRAM_BOT_TOKEN),false);assert.equal(data.error.includes('private upstream details'),false);
    assert.match(data.error,mode==='http'?/код 500/:/Не удалось получить ответ/);
  }
});
