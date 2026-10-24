import test from 'node:test';
import assert from 'node:assert/strict';
import { TaskStore } from '../src/tasks.js';
import { taskHome, homeRequest, publishTaskHome, homeState } from '../src/home.js';
import { handleEnvelope } from '../src/socket.js';
const base={teamId:'TTEST',channelId:'CTEST',title:'Visible task',assigneeId:'UME',creatorId:'UOTHER'};
const context={teamId:'TTEST',channelId:'CTEST',userId:'UME'};
const rows=(view,mode='mine')=>view.blocks.filter(b=>b.block_id?.startsWith(`task:${mode}:`)).map(b=>({...b,accessory:view.blocks.find(a=>a.block_id===`controls:${b.block_id}`)?.elements.find(e=>e.type==='static_select')}));
const action=(id='home_expand_assigned',state={})=>({type:'block_actions',team:{id:'TTEST'},user:{id:'UME'},view:{type:'home',private_metadata:JSON.stringify(state)},actions:[{action_id:id,value:JSON.stringify({userId:'USTRANGER'})}]});
test('Home shows both recent lists, native row dropdowns, and creation at the bottom',()=>{
 const store=new TaskStore();store.create({...base,title:'Older open work'});
 const done=store.create({...base,title:'Newest finished work'});store.transition({id:done.id,teamId:'TTEST',channelId:'CTEST',actorId:'UME',action:'complete'});
 store.create({...base,creatorId:'UME',assigneeId:'UOTHER',title:'Delegated'});store.create({...base,creatorId:'UME',title:'Self assigned'});
 store.create({...base,teamId:'TOTHER',title:'Wrong workspace'});store.create({...base,channelId:'COTHER',title:'Wrong channel'});
 const view=taskHome(store,context),mine=rows(view);
 assert.deepEqual(mine.map(r=>r.text.text),['Self assigned','Newest finished work','Older open work']);
 assert.equal(mine[1].accessory.initial_option.text.text,'Done');assert.equal(mine[2].accessory.initial_option.text.text,'To do');
 assert.equal(mine[2].accessory.type,'static_select');assert.deepEqual(mine[2].accessory.options.map(o=>JSON.parse(o.value).status),['todo','done']);
 assert.deepEqual(rows(view,'assigned').map(r=>r.text.text),['Delegated']);
 assert.equal(rows(view,'assigned')[0].accessory,undefined);
 assert.deepEqual(view.blocks.at(-1).elements.map(e=>e.action_id),['ui_new','home_refresh']);
 assert.doesNotMatch(JSON.stringify(view),/Wrong workspace|Wrong channel|home_select|home_filter|Trash/);store.close();
});
test('Independent expansion pages older records, clamps offsets, and stays within Slack’s block limit',()=>{
 const store=new TaskStore();for(let i=0;i<47;i++)store.create({...base,creatorId:'UME',title:`Task ${i}`});
 for(let i=0;i<25;i++)store.create({...base,creatorId:'UME',assigneeId:'UOTHER',title:`Delegated ${i}`});
 const first=taskHome(store,context);assert.equal(rows(first).length,5);assert.equal(rows(first,'assigned').length,5);assert.equal(rows(first)[0].text.text,'Task 46');
 const expanded=homeRequest('TTEST','CTEST',action('home_expand_mine'));assert.equal(expanded.mineExpanded,true);assert.equal(expanded.assignedExpanded,false);
 assert.equal(rows(taskHome(store,{...context,...expanded})).length,20);
 const second=homeRequest('TTEST','CTEST',action('home_next_mine',expanded));assert.equal(rows(taskHome(store,{...context,...second}))[0].text.text,'Task 26');
 const last=taskHome(store,{...context,mineExpanded:true,minePage:999});assert.equal(rows(last).length,7);assert.equal(JSON.parse(last.private_metadata).minePage,2);
 const collapsed=homeRequest('TTEST','CTEST',action('home_collapse_mine',second));assert.equal(collapsed.mineExpanded,false);assert.equal(collapsed.minePage,0);
 const both=taskHome(store,{...context,mineExpanded:true,assignedExpanded:true});assert.ok(both.blocks.length<=100);assert.equal(rows(both).length,20);assert.equal(rows(both,'assigned').length,20);
 const ids=both.blocks.flatMap(b=>[b.accessory?.action_id,...(b.elements??[]).map(e=>e.action_id)]).filter(Boolean);assert.equal(new Set(ids).size,ids.length);store.close();
});
test('Empty sections stay visible and queries clamp invalid sizes',()=>{
 const store=new TaskStore();const view=taskHome(store,context);assert.equal(rows(view).length,0);assert.equal(view.blocks.filter(b=>b.type==='header').length,2);
 assert.equal(store.personalPage({...context,direction:'mine',size:100}).size,20);assert.equal(store.personalPage({...context,direction:'mine',size:-4}).size,1);assert.throws(()=>store.personalPage({...context,direction:'unsafe SQL'}));store.close();
});
test('Home navigation authenticates actor and rejects wrong workspace or unrelated actions',()=>{
 assert.deepEqual(homeRequest('TTEST','CTEST',action()),{userId:'UME',...homeState({assignedExpanded:true})});
 const wrong=action();wrong.team.id='TOTHER';assert.equal(homeRequest('TTEST','CTEST',wrong),null);
 const channel=action();delete channel.view;assert.equal(homeRequest('TTEST','CTEST',channel),null);assert.equal(homeRequest('TTEST','CTEST',action('home_select')),null);
 assert.equal(homeRequest('TTEST','CTEST',action('home_next_mine')).minePage,0);
});
test('Opening Messages initializes Home for first-time users; unrelated tabs do not',()=>{
 const store=new TaskStore(),config={store,teamId:'TTEST',allowedChannelId:'CTEST'};
 const opened={envelope_id:'home-event',type:'events_api',payload:{team_id:'TTEST',event:{type:'app_home_opened',user:'UME',tab:'home'}}};
 assert.deepEqual(handleEnvelope(config,opened),{ack:{envelope_id:'home-event'},home:{userId:'UME',...homeState()}});
 opened.payload.event.tab='messages';assert.equal(handleEnvelope(config,opened).home.userId,'UME');opened.payload.event.tab='about';assert.equal(handleEnvelope(config,opened).home,undefined);
 assert.equal(handleEnvelope(config,{envelope_id:'button',type:'interactive',payload:action()}).home.assignedExpanded,true);store.close();
});
test('Home publishes privately and keeps task directions as plain text',async()=>{
 const store=new TaskStore();store.create({...base,title:'<!channel> *not markup*'});let call;
 await publishTaskHome({call:async(method,args)=>{call={method,args};}},store,context);
 assert.equal(call.method,'views.publish');assert.equal(call.args.user_id,'UME');assert.equal(rows(call.args.view)[0].text.type,'plain_text');assert.match(rows(call.args.view)[0].text.text,/<!channel>/);store.close();
});
