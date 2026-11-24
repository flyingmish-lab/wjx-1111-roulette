import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {webcrypto} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {env,mockDb,loadFunction,request,telegramData} from './helpers.mjs';
const entry='supabase/functions/wjx-roulette/index.ts';
const modeFetch=(status,calls,extra={})=>async(url,options)=>{
  const body=JSON.parse(options.body);calls.push({url,body});
  return Response.json({ok:true,result:{status,user:{id:body.user_id},...extra}});
};
test('membership uses verified sender for every role and every new real spin',async()=>{
  for(const id of [221535678,382749857,123456789])for(const action of ['spin'])for(const status of ['left','kicked','member','creator','administrator']) {
    const db=mockDb(),calls=[];db.balances.set(id,2);
    const api=loadFunction(entry,db,env,{fetch:modeFetch(status,calls)}).handleRoulette;
    const response=await api(request({action,initData:await telegramData(id),user_id:999,subscribed:true}));
    const accepted=['member','creator','administrator'].includes(status);
    assert.equal(response.status,accepted?200:403);
    assert.equal(calls.length,1);assert.equal(calls[0].body.chat_id,'@tattoowjxrussia');assert.equal(calls[0].body.user_id,id);
    assert.equal(db.calls.some(c=>c.rpc==='wjx_perform_spin'),accepted);
    if(!accepted)assert.equal((await response.json()).code,'SUBSCRIPTION_REQUIRED');
  }
});
test('restricted membership, malformed replies, upstream failures fail safely',async()=>{
  const initData=await telegramData(123456789);
  for(const member of [{status:'restricted',is_member:true},{status:'restricted',is_member:false},{status:'unexpected'},{status:'member',user:{id:999}}]) {
    const db=mockDb(),api=loadFunction(entry,db,env,{fetch:modeFetch(member.status,[],member)}).handleRoulette;
    const response=await api(request({action:'spin',initData}));
    assert.equal(response.status,member.status==='restricted'?(member.is_member?200:403):503);
    if(response.status!==200)assert.equal(db.operations.size,0);
  }
  for(const fetch of [async()=>{throw Error(env.TELEGRAM_BOT_TOKEN);},async()=>Response.json({ok:false,error_code:429,description:env.TELEGRAM_BOT_TOKEN},{status:429})]) {
    const db=mockDb(),api=loadFunction(entry,db,env,{fetch}).handleRoulette;
    const response=await api(request({action:'spin',initData}));assert.equal(response.status,503);
    assert.equal((await response.text()).includes(env.TELEGRAM_BOT_TOKEN),false);assert.equal(db.operations.size,0);
  }
});
test('subscription status is explicit, never called by status polling, and does not spend attempts',async()=>{
  const db=mockDb(),calls=[],api=loadFunction(entry,db,env,{fetch:modeFetch('left',calls)}).handleRoulette;
  const initData=await telegramData(123456789);
  assert.equal((await api(request({action:'status',initData}))).status,200);assert.equal(calls.length,0);
  const result=await api(request({action:'check_subscription',initData}));assert.equal((await result.json()).subscribed,false);
  assert.equal(db.operations.size,0);assert.equal(calls.length,1);
  const before=calls.length;assert.equal((await api(request({action:'check_subscription',initData:'forged'}))).status,401);assert.equal(calls.length,before);
});
test('saved operation remains recoverable during pause and after leaving channel',async()=>{
  const db=mockDb(),calls=[];let subscribed=true;
  const api=loadFunction(entry,db,env,{fetch:async(...args)=>modeFetch(subscribed?'member':'left',calls)(...args)}).handleRoulette;
  const initData=await telegramData(123456789),operationId=webcrypto.randomUUID();
  const first=await api(request({action:'spin',initData,operationId}));assert.equal(first.status,200);
  db.settings.spins_paused=true;subscribed=false;
  const replay=await api(request({action:'spin',initData,operationId}));assert.equal(replay.status,200);assert.equal((await replay.json()).replayed,true);
  assert.equal(calls.length,1);assert.equal(db.operations.size,1);
});
test('pause is browser-admin-only, validates booleans and preserves dates/chances',async()=>{
  const db=mockDb(),api=loadFunction(entry,db).handleRoulette;
  const {issueSession}=loadFunction('supabase/functions/_shared/admin-session.ts',db);
  const session=await issueSession(env.WJX_ADMIN_PASSWORD,env.WJX_ADMIN_SESSION_SECRET);db.sessions.set(session.tokenHash,{expires_at:session.expiresAt});
  const initial={...db.settings};
  assert.equal((await api(request({action:'admin_set_pause',paused:true,initData:await telegramData(221535678)}))).status,401);
  assert.equal((await api(request({action:'admin_set_pause',paused:'true'},session.token))).status,400);
  assert.equal((await api(request({action:'admin_set_pause',paused:true},session.token))).status,200);
  assert.deepEqual(db.settings,{...initial,spins_paused:true});
  const response=await api(request({action:'spin',initData:await telegramData(123456789)}));assert.equal(response.status,403);assert.equal((await response.json()).code,'SPINS_PAUSED');
  assert.equal((await api(request({action:'status',initData:await telegramData(123456789)}))).status,200);
});
test('100 concurrent synthetic player handlers use independent verified identities',async()=>{
  const shared=mockDb(),api=loadFunction(entry,shared).handleRoulette;
  const replies=await Promise.all(Array.from({length:100},async(_,i)=>api(request({action:'status',initData:await telegramData(300000000+i)}))));
  assert.ok(replies.every(r=>r.status===200));
  const registrations=shared.calls.filter(c=>c.rpc==='wjx_register_player');
  assert.equal(new Set(registrations.map(c=>c.args.p_telegram_id)).size,100);
  assert.equal(shared.operations.size,0);
});
test('migration avoids unchanged profile writes, enforces transactional pause and preserves retries/data',async()=>{
  const db=new PGlite();
  try {
    const fixture=fs.readFileSync('tests/database.test.mjs','utf8').match(/const fixture=`([\s\S]*?)`;/)[1];await db.exec(fixture);
    for(const name of fs.readdirSync('supabase/migrations').filter(n=>!n.includes('230010')&&!n.includes('240011')).sort())await db.exec(fs.readFileSync('supabase/migrations/'+name,'utf8'));
    await db.exec("select wjx_register_player(123456789,'New name','new_nick')");
    const row=(await db.query('select ctid::text,joined_at from wjx_participants where telegram_id=123456789')).rows[0];
    await db.exec("select wjx_register_player(123456789,'New name','new_nick')");
    assert.deepEqual((await db.query('select ctid::text,joined_at from wjx_participants where telegram_id=123456789')).rows[0],row);
    await db.exec("select wjx_register_player(123456789,'Changed','new_nick')");
    assert.equal((await db.query('select first_name from wjx_participants where telegram_id=123456789')).rows[0].first_name,'Changed');
    const id=webcrypto.randomUUID();const first=(await db.query("select wjx_perform_spin(123456789,$1,false,'Без выигрыша') r",[id])).rows[0].r;
    await db.exec('update roulette_settings set spins_paused=true; select wjx_set_test_spins(123456789,2)');
    assert.deepEqual((await db.query("select wjx_perform_spin(123456789,$1,false,'Без выигрыша') r",[id])).rows[0].r,first);
    for(const mode of [true,false])await assert.rejects(db.query("select wjx_perform_spin(123456789,$1,$2,'Без выигрыша')",[webcrypto.randomUUID(),mode]),error=>error.code==='P0003');
    assert.equal((await db.query('select wjx_player_state(123456789) s')).rows[0].s.settings.spins_paused,true);
    await db.exec(fs.readFileSync('supabase/migrations/202611200006_launch_readiness.sql','utf8'));
    assert.equal((await db.query('select count(*)::int n from wjx_spins')).rows[0].n,1);
    assert.equal((await db.query('select spins_paused from roulette_settings')).rows[0].spins_paused,true);
    for(const role of ['anon','authenticated'])assert.equal((await db.query("select has_function_privilege($1,'wjx_register_player(bigint,text,text)','EXECUTE') x",[role])).rows[0].x,false);
  } finally {await db.close();}
});

test('channel setup diagnostic checks the bot own admin status and requires browser session',async()=>{
  for(const status of ['administrator','member']) {
    const db=mockDb(),calls=[];
    const fetch=async(url,options)=>{
      calls.push(url);
      return url.endsWith('/getMe')?Response.json({ok:true,result:{id:555,username:'TestBot'}}):modeFetch(status,[])(url,options);
    };
    const api=loadFunction(entry,db,env,{fetch}).handleRoulette;
    assert.equal((await api(request({action:'admin_subscription_status'}))).status,401);assert.equal(calls.length,0);
    const {issueSession}=loadFunction('supabase/functions/_shared/admin-session.ts',db);
    const session=await issueSession(env.WJX_ADMIN_PASSWORD,env.WJX_ADMIN_SESSION_SECRET);db.sessions.set(session.tokenHash,{expires_at:session.expiresAt});
    const response=await api(request({action:'admin_subscription_status'},session.token));
    assert.equal(response.status,200);assert.equal((await response.json()).ready,status==='administrator');assert.equal(calls.length,2);
  }
  const db=mockDb(),api=loadFunction('dashboard-dist/wjx-roulette/index.ts',db,env,{fetch:modeFetch('left',[])}).handleRoulette;
  const blocked=await api(request({action:'spin',initData:await telegramData(123456789)}));
  assert.equal(blocked.status,403);assert.equal((await blocked.json()).code,'SUBSCRIPTION_REQUIRED');assert.equal(db.operations.size,0);
});
