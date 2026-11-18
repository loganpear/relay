import {DurableObject} from 'cloudflare:workers';
import {Buffer} from 'node:buffer';
import {createHash} from 'node:crypto';
import {TaskStore,TaskError} from './task-store.js';
import {CloudflareDatabase} from './cloudflare-db.js';
import {SlackClient,verifySlack,flushOutbox,learnTimeZoneQuickly} from './slack.js';
import {handleCommand,handleInteraction} from './commands.js';
import {homeRequest,publishTaskHome,refreshStaleHomes} from './home.js';
import {handleAppUi,runAppUiEffects} from './ui.js';
import {handleReminderAction,sendReminders} from './reminders.js';

const routes=new Set(['/slack/commands','/slack/actions','/slack/events']);
const json=(body,status=200)=>Response.json(body,{status,headers:{'cache-control':'no-store','x-content-type-options':'nosniff'}});
const ephemeral=text=>({response_type:'ephemeral',text});
const configured=env=>Boolean(env.SLACK_SIGNING_SECRET&&env.SLACK_BOT_TOKEN&&env.SLACK_TEAM_ID);
async function bodyBytes(request){
  const reader=request.body?.getReader(),chunks=[];let size=0;
  if(!reader)return Buffer.alloc(0);
  try{
    for(;;){const {value,done}=await reader.read();if(done)break;size+=value.length;if(size>100_000){await reader.cancel();throw new TaskError('Request too large.');}chunks.push(Buffer.from(value));}
  }finally{reader.releaseLock();}
  return Buffer.concat(chunks);
}
const workspace=env=>env.RELAY_WORKSPACE.get(env.RELAY_WORKSPACE.idFromName(env.SLACK_TEAM_ID));

export default {
  async fetch(request,env){
    const path=new URL(request.url).pathname;
    if(request.method==='GET'&&path==='/health')return json({ok:true,mode:'cloudflare',configured:configured(env)});
    if(request.method!=='POST'||!routes.has(path))return json({error:'Not found.'},404);
    if(!configured(env))return json({error:'Slack is not configured.'},503);
    try{
      const raw=await bodyBytes(request);
      if(!verifySlack(raw,Object.fromEntries(request.headers),env.SLACK_SIGNING_SECRET))return json({error:'Invalid Slack signature.'},401);
      return await workspace(env).fetch(new Request(request,{body:raw}));
    }catch(error){return json({error:error instanceof TaskError?error.message:'Unable to process request.'},error instanceof TaskError?400:500);}
  },
  async scheduled(_event,env,ctx){
    if(configured(env))ctx.waitUntil(workspace(env).fetch('https://relay.internal/internal/tick').then(response=>{if(!response.ok)throw new Error('Scheduled delivery failed.');}));
  }
};

// One durable object serializes a workspace's SQLite writes and outbound delivery jobs.
export class RelayWorkspace extends DurableObject {
  constructor(ctx,env){
    super(ctx,env);this.ctx=ctx;this.env=env;
    this.store=new TaskStore(new CloudflareDatabase(ctx.storage));
    this.client=new SlackClient(env.SLACK_BOT_TOKEN);this.effects=Promise.resolve();
  }
  enqueue(effect){
    const result=this.effects.then(effect);
    this.effects=result.catch(()=>console.error('Relay background work failed; the scheduled job will retry.'));
    this.ctx.waitUntil(this.effects);return result;
  }
  async flush(){await flushOutbox(this.store,this.client);await refreshStaleHomes(this.client,this.store);}
  async fetch(request){
    const path=new URL(request.url).pathname;
    if(path==='/internal/tick'){
      await this.enqueue(async()=>{await this.flush();await sendReminders(this.store,this.client);await refreshStaleHomes(this.client,this.store);});
      return json({ok:true});
    }
    if(request.method!=='POST'||!routes.has(path))return json({error:'Not found.'},404);
    const {store,client,env}=this,teamId=env.SLACK_TEAM_ID;
    try{
      const raw=await bodyBytes(request);
      if(!verifySlack(raw,Object.fromEntries(request.headers),env.SLACK_SIGNING_SECRET))return json({error:'Invalid Slack signature.'},401);
      const key=createHash('sha256').update(request.headers.get('x-slack-request-timestamp')).update(raw).digest('hex');
      if(path==='/slack/events'){
        const payload=JSON.parse(raw.toString());
        if(payload.type==='url_verification')return json({challenge:payload.challenge});
        const home=homeRequest(teamId,payload,true);
        if(home)this.enqueue(async()=>{await publishTaskHome(client,store,{teamId,...home});await this.flush();});
        return json({});
      }
      const form=Object.fromEntries(new URLSearchParams(raw.toString()));
      if(path==='/slack/commands'){
        if(form.team_id!==teamId)return json({error:'Workspace not configured.'},403);
        if(env.SLACK_ALLOWED_CHANNEL_ID&&form.channel_id!==env.SLACK_ALLOWED_CHANNEL_ID)return json(ephemeral('Relay testing is restricted to the private test channel. No task was created.'));
        await learnTimeZoneQuickly(store,client,form.user_id);
        let reply;try{reply=handleCommand(store,form,key);}catch(error){if(!(error instanceof TaskError))throw error;reply=ephemeral(error.message);}
        this.enqueue(()=>this.flush());return json(reply);
      }
      const payload=JSON.parse(form.payload??'{}');
      if(payload.team?.id!==teamId)return json({error:'Workspace not configured.'},403);
      if(payload.actions?.[0]?.action_id==='remind_done'){
        const result=handleReminderAction(store,{teamId},payload,key);
        this.enqueue(async()=>{if(result?.update?.ts)await client.call('chat.update',result.update);if(result?.feedback?.user)await client.call('chat.postEphemeral',result.feedback);await this.flush();});
        return json({});
      }
      if(['home','modal'].includes(payload.view?.type)||payload.type==='view_submission'){
        const result=handleAppUi(store,{teamId},payload,key);
        // Slack trigger IDs expire quickly: opening a form must not wait behind card retries.
        if(result?.openModal||result?.updateModal)this.ctx.waitUntil(runAppUiEffects(client,store,{teamId},result));
        else if(result)this.enqueue(async()=>{await runAppUiEffects(client,store,{teamId},result);await this.flush();});
        return json(result?.ackPayload??{});
      }
      if(env.SLACK_ALLOWED_CHANNEL_ID&&payload.channel?.id!==env.SLACK_ALLOWED_CHANNEL_ID)return json({});
      try{handleInteraction(store,payload,key);}
      catch(error){if(!(error instanceof TaskError))throw error;if(payload.channel?.id&&payload.user?.id)this.enqueue(()=>client.call('chat.postEphemeral',{channel:payload.channel.id,user:payload.user.id,text:error.message}));}
      this.enqueue(()=>this.flush());return json({});
    }catch(error){return json({error:error instanceof TaskError?error.message:'Unable to process request.'},error instanceof TaskError||error instanceof SyntaxError?400:500);}
  }
}
