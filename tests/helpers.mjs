import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { webcrypto } from 'node:crypto';

export const env = { SUPABASE_URL: 'https://test.invalid', SUPABASE_SERVICE_ROLE_KEY: 'test-service-role',
  TELEGRAM_BOT_TOKEN: 'test-bot-token', WJX_ADMIN_PASSWORD: 'test-only-password', WJX_ADMIN_SESSION_SECRET: 'test-only-session-secret-with-32-characters' };
export const baseSettings = { event_start: '2000-01-01', event_end: '2099-12-31', start_time: '00:00:00', end_time: '23:59:00', daily_spins: 3 };
export const prizes = ['Картридж', 'Расходники', 'Noir Blade', 'Soul Ink', 'Бандажка', 'Без выигрыша'].map((prize, i) => ({prize, chance: i === 5 ? 50 : 10}));

export function mockDb() {
  const db = { sessions: new Map(), balances: new Map(), eventWinCount: 0, operations: new Map(), deliveries: new Map(), realSpinsUsed: 1, dailyHistory: [{prize:'Без выигрыша',spinNumber:1}], calls: [], attempts: 0, settings: {...baseSettings}, failLimiter: false, failSessions: false,
    async rpc(name, args) {
      db.calls.push({ rpc: name, args });
      if (name === 'wjx_mark_prizes_delivered') {
        const old=db.deliveries.get(args.p_telegram_id)||0;db.deliveries.set(args.p_telegram_id,db.eventWinCount);
        return {data:{marked_count:db.eventWinCount-old}};
      }
      if (name === 'wjx_player_state') {
        const now = db.serverNow || new Date().toISOString();
        const date = new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Moscow',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(now));
        const moment = new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Moscow',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(new Date(now));
        const summary = (await db.rpc('wjx_user_prize_summary',args)).data;
        return {data:{serverNow:now,serverDate:date,settings:{...db.settings},spinsUsed:db.realSpinsUsed,
          spinsRemaining:Math.max(0,db.settings.daily_spins-db.realSpinsUsed),testRemaining:db.balances.get(args.p_telegram_id)||0,
          eventSummary:summary,dailyHistory:db.dailyHistory.map(h=>({...h,spinDate:date})),
          eventStatus:moment < db.settings.event_start+' '+db.settings.start_time.slice(0,5)?'before':moment > db.settings.event_end+' '+db.settings.end_time.slice(0,5)?'finished':'active',
          pendingOperation:db.operations.get(args.p_telegram_id+':'+args.p_request_id)?.result||null}};
      }
      if (name === 'wjx_perform_spin') {
        const key=args.p_telegram_id+':'+args.p_request_id;
        const old=db.operations.get(key);
        if(old) return old.is_test===args.p_is_test?{data:old.result}:{error:{code:'22023'}};
        const date=new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Moscow',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(db.serverNow||Date.now()));
        let extra;
        if(args.p_is_test) {
          const saved=await db.rpc('wjx_use_test_spin',args);if(saved.error)return saved;extra={testRemaining:saved.data};
        } else {
          const moment=new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Moscow',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(new Date(db.serverNow||Date.now()));
          if(moment < db.settings.event_start+' '+db.settings.start_time.slice(0,5)||moment > db.settings.event_end+' '+db.settings.end_time.slice(0,5))return {error:{code:'P0002'}};
          if(db.realSpinsUsed>=db.settings.daily_spins)return {error:{code:'P0001'}};
          const saved=await db.rpc('wjx_save_spin',args);if(saved.error)return saved;
          extra={spinNumber:saved.data[0].spin_number,spinsRemaining:saved.data[0].spins_remaining};
        }
        const result={operationId:args.p_request_id,spinDate:date,isTest:args.p_is_test,prize:args.p_prize==='Без выигрыша'?null:args.p_prize,...extra};
        db.operations.set(key,{is_test:args.p_is_test,result});return {data:result};
      }
      if (name === 'wjx_consume_admin_login_attempt') return db.failLimiter ? {error:{code:'db_error'}} : { data:[{allowed: ++db.attempts <= 10, retry_after:900}] };
      if (name === 'wjx_event_winners') return {data:{period:db.settings,winners:[{telegram_id:'123456789',first_name:'Player',username:'player',total_wins:3}],has_more:false}};
      if (name === 'wjx_user_prize_summary') return {data:{participant:{telegram_id:String(args.p_telegram_id),username:'player',first_name:'Player'},period:db.settings,total_wins:db.eventWinCount,can_deliver:!!db.canDeliver,delivered_count:db.deliveries.get(args.p_telegram_id)||0,remaining_count:db.eventWinCount-(db.deliveries.get(args.p_telegram_id)||0),delivered_prizes:[],prizes:db.eventWinCount?[{prize:'Картридж',quantity:db.eventWinCount}]:[],daily:db.eventWinCount?[{spin_date:'2026-11-27',prize:'Картридж',quantity:db.eventWinCount}]:[]}};
      if (name === 'wjx_admin_test_users') return {data:{users:[{telegram_id:'123456789',first_name:'Player',username:'player',test_remaining:db.balances.get(123456789)??0}],has_more:false}};
      if (name === 'wjx_set_test_spins') {db.balances.set(args.p_telegram_id,args.p_attempts);return {data:args.p_attempts};}
      if (name === 'wjx_use_test_spin') {
        const n=db.balances.get(args.p_telegram_id)??0;
        if(n<=0) return {error:{code:'P0001'}};
        db.balances.set(args.p_telegram_id,n-1);return {data:n-1};
      }
      if (name === 'wjx_admin_prize_stats') return {data:{prizes:prizes.map(p=>({...p,realWins:1200,testWins:2})),history:[]}};
      if (name === 'wjx_save_spin') {db.realSpinsUsed++;db.dailyHistory.push({prize:args.p_prize,spinNumber:db.realSpinsUsed});if(args.p_prize!=='Без выигрыша')db.eventWinCount++;return {data:[{spin_number:db.realSpinsUsed,spins_remaining:db.settings.daily_spins-db.realSpinsUsed}]};}
      throw Error('Unexpected RPC');
    },
    from(table) {
      const call = { table, filters: {}, operation:'select' }; db.calls.push(call);
      const q = {
        select(columns, options) { call.columns=columns; call.options=options; return q; },
        eq(key, value) {call.filters[key]=value; return q;},
        upsert(value) {call.operation='upsert'; call.value=value; return q;},
        update(value) {call.operation='update'; call.value=value; return q;},
        insert(value) {call.operation='insert'; call.value=value; return q;},
        delete() {call.operation='delete'; return q;},
        single() {return q;}, maybeSingle() {return q;},
        then(resolve, reject) {
          const run = () => {
            if (table === 'wjx_admin_sessions') {
              if(db.failSessions) return {error:{code:'db_error'}};
              if(call.operation==='insert') db.sessions.set(call.value.token_hash,call.value);
              if(call.operation==='delete') db.sessions.delete(call.filters.token_hash);
              return {data:db.sessions.get(call.filters.token_hash) ?? null};
            }
            if(table==='roulette_settings') {
              if(call.operation==='update') Object.assign(db.settings,call.value);
              return {data:db.settings};
            }
            if(table==='roulette_prize_chances') return {data:prizes};
            if(table==='wjx_participants') return {};
            if(table==='wjx_test_balances') return {data:{remaining:db.balances.get(call.filters.telegram_id)??0}};
            if(table==='wjx_spins') return {count:db.realSpinsUsed};
            if(table==='wjx_spin_operations')return {data:db.operations.get(call.filters.telegram_id+':'+call.filters.request_id)||null};
            throw Error('Unexpected table '+table);
          };
          return Promise.resolve().then(run).then(resolve,reject);
        }
      }; return q;
    }
  }; return db;
}

export function loadFunction(entry, db, environment = env) {
  const cache = new Map();
  function load(filename) {
    filename=path.resolve(filename);
    if(cache.has(filename)) return cache.get(filename);
    const exports={}; cache.set(filename,exports);
    const code=ts.transpileModule(fs.readFileSync(filename,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
    const context={ exports, require(specifier) {
      if(specifier.startsWith('npm:')) return {createClient:()=>db};
      return load(path.resolve(path.dirname(filename),specifier));
    }, Deno:{env:{get:key=>environment[key]},serve(){}}, Request,Response,Headers,TextEncoder,TextDecoder,URLSearchParams,Date,crypto:webcrypto,console };
    vm.runInNewContext(code,context,{filename});
    return exports;
  }
  return load(entry);
}
export function request(body, token='', extras={}) {
  if(body && ['spin','test_spin'].includes(body.action) && !('operationId' in body)) body={...body,operationId:webcrypto.randomUUID()};
  return new Request('https://test.invalid/function',{method:'POST',headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{}),...extras},body:JSON.stringify(body)});
}
export async function telegramData(id) {
  const params = new URLSearchParams({auth_date:String(Math.floor(Date.now()/1000)),user:JSON.stringify({id,first_name:'Tester'})});
  const key = await webcrypto.subtle.importKey('raw',new TextEncoder().encode('WebAppData'),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  const secret = await webcrypto.subtle.sign('HMAC',key,new TextEncoder().encode(env.TELEGRAM_BOT_TOKEN));
  const hmac = await webcrypto.subtle.importKey('raw',secret,{name:'HMAC',hash:'SHA-256'},false,['sign']);
  const check=[...params].sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>`${k}=${v}`).join('\n');
  const signature=await webcrypto.subtle.sign('HMAC',hmac,new TextEncoder().encode(check));
  params.set('hash',Buffer.from(signature).toString('hex')); return params.toString();
}
