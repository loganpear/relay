import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {Miniflare,convertV4MiniflareOptions,Response as MockResponse} from 'miniflare';

// Uses the actual Workers runtime and durable SQLite. All Slack traffic is intercepted locally.
test('Cloudflare signs, authorizes, deduplicates, persists, and schedules Relay safely',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'relay-worker-test-')),calls=[],timestamp=String(Math.floor(Date.now()/1000));
 let mf;
 try{
  execFileSync(process.execPath,['node_modules/wrangler/bin/wrangler.js','deploy','--dry-run','--outdir',join(dir,'build')],{stdio:'pipe'});
  const secret='synthetic-cloudflare-test';
  const options={name:'relay-test',modules:true,scriptPath:join(dir,'build/worker.js'),modulesRoot:join(dir,'build'),compatibilityDate:'2026-11-18',compatibilityFlags:['nodejs_compat'],
   durableObjects:{RELAY_WORKSPACE:{className:'RelayWorkspace',useSQLite:true}},
   bindings:{SLACK_TEAM_ID:'TTEST',SLACK_SIGNING_SECRET:secret,SLACK_BOT_TOKEN:'synthetic-token',TASK_TIMEZONE:'UTC',RELAY_REMINDERS:'on',REMINDER_DIGEST_TIME:new Date().toISOString().slice(11,16)},
   outboundService:async request=>{
    const method=new URL(request.url).pathname.split('/').at(-1),contentType=request.headers.get('content-type')||'';
    const payload=contentType.includes('json')?await request.json():Object.fromEntries(new URLSearchParams(await request.text()));
    calls.push({method,payload});
    return new MockResponse(JSON.stringify({ok:true,ts:`${calls.length}.000001`,user:{tz:'UTC'},view:{id:'VTEST'}}),{headers:{'content-type':'application/json'}});
   }};
  mf=new Miniflare({...convertV4MiniflareOptions(options),resourcePersistencePath:join(dir,'state')});
  const signed=async(path,body)=>mf.dispatchFetch('https://relay.test'+path,{method:'POST',headers:{'x-slack-request-timestamp':timestamp,'x-slack-signature':'v0='+createHmac('sha256',secret).update(`v0:${timestamp}:${body}`).digest('hex')},body});
  const command=(text,extra={})=>signed('/slack/commands',new URLSearchParams({team_id:'TTEST',channel_id:'CTEST',user_id:'UCREATOR',command:'/task',text,...extra}).toString());
  const action=payload=>signed('/slack/actions',new URLSearchParams({payload:JSON.stringify(payload)}).toString());
  const eventually=async predicate=>{for(let i=0;i<100;i++){if(predicate())return;await new Promise(r=>setTimeout(r,20));}assert.fail('Background delivery timed out: '+JSON.stringify(calls));};
  assert.equal((await mf.dispatchFetch('https://relay.test/health')).status,200);
  for(const path of ['/','/demo/tasks','/internal/tick'])assert.equal((await mf.dispatchFetch('https://relay.test'+path)).status,404);
  assert.equal((await mf.dispatchFetch('https://relay.test/slack/commands',{method:'POST',body:'x=1'})).status,401);
  assert.equal((await command('<@UASSIGNEE> Wrong workspace',{team_id:'TOTHER'})).status,403);
  assert.equal((await signed('/slack/commands','x'.repeat(100001))).status,400);
  const challenge=await signed('/slack/events',JSON.stringify({type:'url_verification',challenge:'proof'}));assert.deepEqual(await challenge.json(),{challenge:'proof'});
  const text='<@UASSIGNEE> Worker task --due tomorrow --details "Keep requirements"';
  assert.match((await(await command(text)).json()).text,/Task #1 saved/);
  assert.match((await(await command(text)).json()).text,/Task #1 saved/);
  await eventually(()=>calls.some(c=>c.method==='chat.postMessage'&&c.payload.text.includes('Task #1:')));
  const card=calls.find(c=>c.method==='chat.postMessage'&&c.payload.text.includes('Task #1:'));
  assert.equal(card.payload.channel,'CTEST');
  assert.match((await(await command('all',{command:'/tasks'})).json()).text,/#1 · Worker task/);
  assert.doesNotMatch((await(await command('all',{command:'/tasks'})).json()).text,/#2/);
  const complete={type:'block_actions',team:{id:'TTEST'},channel:{id:'CTEST'},user:{id:'UASSIGNEE'},actions:[{action_id:'task_complete',value:JSON.stringify({id:1,version:0})}]};
  await action({...complete,user:{id:'USTRANGER'}});
  assert.match((await(await command('all',{command:'/tasks'})).json()).text,/To do/);
  await action(complete);await action(complete);
  await eventually(()=>calls.some(c=>c.method==='chat.postMessage'&&c.payload.thread_ts&&c.payload.text.includes('Done')));
  assert.equal(calls.filter(c=>c.method==='chat.postMessage'&&c.payload.thread_ts&&c.payload.text.includes('Done')).length,1);
  assert.match((await(await command('all',{command:'/tasks'})).json()).text,/Done/);
  const homeCount=calls.filter(c=>c.method==='views.publish').length;
  await signed('/slack/events',JSON.stringify({type:'event_callback',team_id:'TTEST',event:{type:'app_home_opened',tab:'home',user:'UASSIGNEE'}}));
  await eventually(()=>calls.filter(c=>c.method==='views.publish').length>homeCount);
  const home=calls.filter(c=>c.method==='views.publish').at(-1).payload.view;
  assert.equal(home.blocks.filter(b=>b.type==='data_table').length,2);
  await command('<@UASSIGNEE> Reminder target',{user_id:'UASSIGNEE'});
  await (await mf.getWorker()).scheduled({cron:'* * * * *'});
  await eventually(()=>calls.some(c=>c.method==='chat.postMessage'&&c.payload.text.startsWith('Good morning!')));
  await (await mf.getWorker()).scheduled({cron:'* * * * *'});
  assert.equal(calls.filter(c=>c.method==='chat.postMessage'&&c.payload.text.startsWith('Good morning!')).length,1);
  await mf.dispose();mf=new Miniflare({...convertV4MiniflareOptions(options),resourcePersistencePath:join(dir,'state')});
  const persisted=await(await command('all',{command:'/tasks'})).json();assert.match(persisted.text,/Worker task.*Done/s);assert.match(persisted.text,/#2 · Reminder target/);
  await (await mf.getWorker()).scheduled({cron:'* * * * *'});
  assert.equal(calls.filter(c=>c.method==='chat.postMessage'&&c.payload.text.startsWith('Good morning!')).length,1);
 }finally{await mf?.dispose();await rm(dir,{recursive:true,force:true});}
});
