import test from 'node:test';
import assert from 'node:assert/strict';
import {issueSession,verifyToken,equalPassword,digest} from '../supabase/functions/_shared/admin-session.ts';
import {env,mockDb,loadFunction,request,telegramData,prizes} from './helpers.mjs';
const authPath='supabase/functions/wjx-admin-auth/index.ts';
const roulettePath='supabase/functions/wjx-roulette/index.ts';
const session=()=>issueSession(env.WJX_ADMIN_PASSWORD,env.WJX_ADMIN_SESSION_SECRET);

async function setup() {
  const db=mockDb(); const s=await session(); db.sessions.set(s.tokenHash,{expires_at:s.expiresAt});
  return {db,s,auth:loadFunction(authPath,db).handleAdminAuth,roulette:loadFunction(roulettePath,db).handleRoulette};
}
test('tokens are unpredictable, signed, expire and rotate with either secret',async()=>{
  const first=await session(),second=await session();
  assert.notEqual(first.token,second.token);
  assert.equal(await verifyToken(first.token,env.WJX_ADMIN_PASSWORD,env.WJX_ADMIN_SESSION_SECRET),true);
  assert.equal(await verifyToken(first.token+'x',env.WJX_ADMIN_PASSWORD,env.WJX_ADMIN_SESSION_SECRET),false);
  const parts=first.token.split('.'); parts[1]='0'.repeat(64);
  assert.equal(await verifyToken(parts.join('.'),env.WJX_ADMIN_PASSWORD,env.WJX_ADMIN_SESSION_SECRET),false);
  assert.equal(await verifyToken(first.token,env.WJX_ADMIN_PASSWORD,env.WJX_ADMIN_SESSION_SECRET,Date.parse(first.expiresAt)),false);
  assert.equal(await verifyToken(first.token,'changed-password-long-enough',env.WJX_ADMIN_SESSION_SECRET),false);
  assert.equal(await verifyToken(first.token,env.WJX_ADMIN_PASSWORD,'changed-session-secret-at-least-32'),false);
  assert.equal(await equalPassword('test-only-password',env.WJX_ADMIN_PASSWORD),true);
  assert.equal(await equalPassword('incorrect',env.WJX_ADMIN_PASSWORD),false);
});
test('login stores only a token hash; logout revokes server-side access',async()=>{
  const {db,auth,roulette}=await setup();
  const response=await auth(request({action:'login',password:env.WJX_ADMIN_PASSWORD}));
  assert.equal(response.status,200); assert.equal(response.headers.get('cache-control'),'no-store');
  const body=await response.json(); assert.ok(db.sessions.has(await digest(body.token)));
  assert.equal(JSON.stringify([...db.sessions.values()]).includes(body.token),false);
  assert.equal((await roulette(request({action:'admin_get_settings'},body.token))).status,200);
  assert.equal((await auth(request({action:'logout'},body.token))).status,200);
  assert.equal((await roulette(request({action:'admin_get_settings'},body.token))).status,401);
});
test('all login attempts consume quota; IP spoofing and successful login cannot reset it',async()=>{
  const {db,auth}=await setup();
  for(let i=0;i<10;i++) {
    const response=await auth(request({action:'login',password:i===9?env.WJX_ADMIN_PASSWORD:'bad'},'',{'x-forwarded-for':`192.0.2.${i}`}));
    assert.equal(response.status,i===9?200:401);
  }
  const response=await auth(request({action:'login',password:env.WJX_ADMIN_PASSWORD}));
  assert.equal(response.status,429); assert.equal(response.headers.get('retry-after'),'900');
  assert.equal(db.attempts,11);
});
test('database outages and missing configuration fail closed',async()=>{
  const {db,s,auth,roulette}=await setup();
  db.failLimiter=true;
  assert.equal((await auth(request({action:'login',password:env.WJX_ADMIN_PASSWORD}))).status,503);
  db.failSessions=true;
  assert.equal((await roulette(request({action:'admin_get_settings'},s.token))).status,503);
  const missing=loadFunction(authPath,mockDb(),{...env,WJX_ADMIN_SESSION_SECRET:''}).handleAdminAuth;
  assert.equal((await missing(request({action:'login',password:env.WJX_ADMIN_PASSWORD}))).status,503);
});
test('every admin API rejects Telegram-only, unsigned, expired and revoked sessions',async()=>{
  const {db,s,roulette}=await setup();
  const owner=await telegramData(221535678);
  for(const action of ['admin_get_settings','admin_save_settings','admin_get_prizes','admin_save_prize_chances','admin_test_users','admin_set_test_spins','admin_spin_users','admin_reset_daily_spins','admin_get_winners','admin_get_user_wins','admin_mark_prizes_delivered','admin_bot_status','admin_configure_bot','admin_set_pause','admin_subscription_status']) {
    const before=db.calls.length;
    assert.equal((await roulette(request({action,initData:owner}))).status,401);
    assert.equal(db.calls.length,before,'no DB access before authentication');
    assert.equal((await roulette(request({action},'forged'))).status,401);
    const expired=await issueSession(env.WJX_ADMIN_PASSWORD,env.WJX_ADMIN_SESSION_SECRET,Date.now()-7200000);
    assert.equal((await roulette(request({action},expired.token))).status,401);
    const unused=await session();
    assert.equal((await roulette(request({action},unused.token))).status,401);
  }
  assert.equal((await roulette(request({action:'admin_reset_test_spins'},s.token))).status,400);
});
test('browser session authorizes all retained APIs without Telegram; server validates writes',async()=>{
  const {db,s,roulette}=await setup();
  const call=(action,values={})=>roulette(request({action,...values},s.token));
  const settings={event_start:'2026-11-26',event_end:'2026-11-28',start_time:'10:00',end_time:'23:59',daily_spins:3};
  assert.equal((await call('admin_get_settings')).status,200);
  assert.equal((await call('admin_get_prizes')).status,200);
  assert.equal((await call('admin_save_settings',{settings})).status,200);
  for(const patch of [{daily_spins:21},{daily_spins:0},{daily_spins:1.1},{event_start:'2026-02-30'},
    {end_time:'23:59<script>'},{start_time:'24:00'},{event_end:'2026-11-25'}]) {
    assert.equal((await call('admin_save_settings',{settings:{...settings,...patch}})).status,400);
  }
  assert.equal((await call('admin_save_prize_chances',{prizes,limitScope:'day'})).status,200);
  for(const invalid of [prizes.slice(1),prizes.map(p=>({...p,chance:0})),prizes.map(p=>({...p,prize:'injected'})),prizes.map(p=>({...p,chance:-1}))]) {
    assert.equal((await call('admin_save_prize_chances',{prizes:invalid,limitScope:'day'})).status,400);
  }
  assert.equal(db.calls.some(c=>c.table==='wjx_participants'),false,'admin never becomes a player');
  assert.equal(db.calls.some(c=>c.operation==='delete'),false);
});
test('owner, employee and ordinary player all use real spins and obey the event schedule',async()=>{
  for(const id of [221535678,382749857,123456789]) {
    const {db,roulette}=await setup(); const initData=await telegramData(id);
    const status=await roulette(request({action:'status',initData}));
    assert.equal(status.status,200); assert.equal((await status.json()).spinsRemaining,2);
    const spin=await roulette(request({action:'spin',initData})); assert.equal(spin.status,200);
    assert.ok(db.calls.some(c=>c.rpc==='wjx_save_spin'&&c.args.p_telegram_id===id));
    assert.equal(db.calls.some(c=>c.rpc==='wjx_use_test_spin'||c.table==='wjx_test_spins'),false);
    db.settings.event_start='2099-01-01';
    const count=db.calls.filter(c=>c.rpc==='wjx_save_spin').length;
    assert.equal((await roulette(request({action:'spin',initData}))).status,403);
    assert.equal(db.calls.filter(c=>c.rpc==='wjx_save_spin').length,count);
  }
});
test('methods, origins, malformed JSON, huge bodies and invalid Telegram data are rejected',async()=>{
  const {auth,roulette}=await setup();
  for(const handler of [auth,roulette]) {
    assert.equal((await handler(new Request('https://test.invalid',{method:'OPTIONS'}))).status,204);
    assert.equal((await handler(new Request('https://test.invalid'))).status,405);
    assert.equal((await handler(request({},'',{origin:'https://attacker.invalid'}))).status,403);
    assert.equal((await handler(new Request('https://test.invalid',{method:'POST',headers:{'content-type':'application/json'},body:'{'}))).status,400);
    assert.equal((await handler(request({x:'a'.repeat(17000)}))).status,413);
    assert.equal((await handler(request(null))).status,400);
  }
  assert.equal((await roulette(request({action:'spin',initData:'bad'}))).status,401);
});
test('retired rapid-action cannot be used as an unthrottled password oracle',async()=>{
  const db=mockDb();const handler=loadFunction('supabase/functions/rapid-action/index.ts',db).retiredAuth;
  const correct=await handler(request({password:env.WJX_ADMIN_PASSWORD}));
  const wrong=await handler(request({password:'wrong'}));
  assert.equal(correct.status,410);assert.equal(wrong.status,410);
  assert.deepEqual(await correct.json(),await wrong.json());assert.equal(db.calls.length,0);
});

test('retired test endpoints never allocate attempts or spend an archived balance',async()=>{
 const {db,s,roulette}=await setup();db.balances.set(123456789,9);
 for(const action of ['admin_test_users','admin_set_test_spins'])assert.equal((await roulette(request({action,telegram_id:123456789,attempts:3},s.token))).status,403);
 assert.equal((await roulette(request({action:'test_spin',initData:await telegramData(123456789)}))).status,403);
 assert.equal(db.balances.get(123456789),9);assert.equal(db.operations.size,0);
 assert.equal(db.calls.some(c=>c.rpc==='wjx_use_test_spin'||c.rpc==='wjx_set_test_spins'),false);
});

test('winner lookup requires admin authorization, validates inputs and binds player summaries to verified identity',async()=>{
  const {db,s,roulette}=await setup();db.eventWinCount=4;
  const headers=s.token;
  assert.equal((await roulette(request({action:'admin_get_winners'},headers))).status,200);
  const detail=await roulette(request({action:'admin_get_user_wins',telegram_id:'123456789'},headers));
  assert.equal(detail.status,200);assert.equal((await detail.json()).total_wins,4);
  for(const telegram_id of [0,-1,'invalid',null]) assert.equal((await roulette(request({action:'admin_get_user_wins',telegram_id},headers))).status,400);
  for(const values of [{search:'a'.repeat(101)},{offset:-1},{offset:1.5}]) assert.equal((await roulette(request({action:'admin_get_winners',...values},headers))).status,400);
  const initData=await telegramData(123456789);
  const status=await roulette(request({action:'status',initData,telegram_id:221535678}));
  assert.equal(status.status,200);assert.equal((await status.json()).eventWinCount,4);
  assert.equal(db.calls.filter(c=>c.rpc==='wjx_user_prize_summary').at(-1).args.p_telegram_id,123456789);
});


test('operation IDs bind retries to the verified player and mode, even after the event ends',async()=>{
  const {db,roulette}=await setup();const initData=await telegramData(123456789);
  const id='00000000-0000-4000-8000-000000000001';
  for(const operationId of [undefined,null,'bad',1]) assert.equal((await roulette(request({action:'spin',initData,operationId}))).status,400);
  const spin=()=>roulette(request({action:'spin',initData,operationId:id,telegram_id:221535678}));
  const first=await (await spin()).json();assert.equal(first.isTest,false);assert.equal(db.operations.size,1);
  db.settings.event_end='2001-01-01';
  const retry=await spin();assert.equal(retry.status,200);const recovered=await retry.json();
  assert.equal(recovered.prize,first.prize);assert.equal(recovered.operationId,id);assert.equal(recovered.replayed,true);
  assert.equal(db.calls.filter(c=>c.rpc==='wjx_save_spin').length,1);
  assert.equal((await roulette(request({action:'test_spin',initData,operationId:id}))).status,403);
  assert.equal([...db.operations.keys()][0],'123456789:'+id);
});
test('a committed spin remains recoverable when the subsequent state query fails',async()=>{
  const {db,roulette}=await setup();const initData=await telegramData(123456789);
  const id='00000000-0000-4000-8000-000000000003';const original=db.rpc;
  db.rpc=async(name,args)=>name==='wjx_player_state'?{error:{code:'offline'}}:original(name,args);
  const body={action:'spin',initData,operationId:id};
  assert.equal((await roulette(request(body))).status,503);assert.equal(db.operations.size,1);
  db.rpc=original;const retry=await roulette(request(body));assert.equal(retry.status,200);
  assert.equal(db.calls.filter(c=>c.rpc==='wjx_save_spin').length,1);
});
