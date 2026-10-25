import test from 'node:test';
import assert from 'node:assert/strict';
import { TaskStore } from '../src/tasks.js';
import { taskHome, homeRequest, publishTaskHome, homeState } from '../src/home.js';
import { handleEnvelope } from '../src/socket.js';
const base={teamId:'TTEST',channelId:'CTEST',title:'Visible task',assigneeId:'UME',creatorId:'UOTHER'};
const context={teamId:'TTEST',channelId:'CTEST',userId:'UME'};
const tables=view=>view.blocks.filter(b=>b.type==='data_table');
const actions=view=>view.blocks.flatMap(b=>b.elements??[]);
const action=(id='home_expand_assigned',state={})=>({type:'block_actions',team:{id:'TTEST'},user:{id:'UME'},view:{type:'home',private_metadata:JSON.stringify(state)},actions:[{action_id:id,value:JSON.stringify({userId:'USTRANGER'})}]});
test('Current shows unfinished assigned-to work and keeps creation at the bottom',()=>{
 const store=new TaskStore();store.create({...base,title:'Older open work'});
 const done=store.create({...base,title:'Newest finished work'});store.transition({id:done.id,teamId:'TTEST',channelId:'CTEST',actorId:'UME',action:'complete'});
 store.create({...base,creatorId:'UME',assigneeId:'UOTHER',title:'Delegated'});
 store.create({...base,creatorId:'UME',title:'Self assigned'});
 store.create({...base,teamId:'TOTHER',title:'Wrong workspace'});store.create({...base,channelId:'COTHER',title:'Other channel'});
 const view=taskHome(store,context),[mine,assigned]=tables(view);
 // Home is personal: it lists your tasks from every channel and from Home itself, but never another workspace.
 assert.equal(mine.caption,'Assigned to you · 3');assert.equal(assigned.caption,'Assigned by you · 2');
 assert.deepEqual(mine.rows.slice(1).map(r=>r[0].element?.text.text??r[0].text),['#6 · Other channel','#4 · Self assigned','#1 · Older open work']);
 assert.equal(mine.rows[2][3].element.text.text,'▾ 🔲 To do');
 assert.deepEqual(assigned.rows.slice(1).map(r=>r[0].element?.text.text??r[0].text),['#4 · Self assigned','#3 · Delegated']);
 assert.equal(mine.rows[0].length,4);assert.ok(mine.rows.slice(1).every(row=>row.length===4));
 assert.equal(assigned.rows[0][4].text,'Archive');assert.equal(assigned.rows[1][4].element.text.text,'▾ Active');assert.equal(assigned.rows[1][3].type,'raw_text');
 assert.deepEqual(view.blocks.at(-1).elements.map(e=>e.action_id),['ui_new','home_refresh']);
 assert.doesNotMatch(JSON.stringify(view),/Wrong workspace|home_select|home_filter|Trash/);store.close();
});
test('Independent expansion pages all older records and collapses to the newest five',()=>{
 const store=new TaskStore();for(let i=0;i<47;i++)store.create({...base,title:`Task ${i}`});
 for(let i=0;i<7;i++)store.create({...base,creatorId:'UME',assigneeId:'UOTHER',title:`Delegated ${i}`});
 const first=taskHome(store,context);assert.equal(tables(first)[0].rows.length,6);assert.equal(tables(first)[1].rows.length,6);
 assert.equal(tables(first)[0].rows[1][0].element.text.text,'#47 · Task 46');
 const expanded=homeRequest('TTEST',action('home_expand_mine'));
 assert.equal(expanded.mineExpanded,true);assert.equal(expanded.assignedExpanded,false);
 const view=taskHome(store,{...context,...expanded});assert.equal(tables(view)[0].rows.length,21);assert.equal(tables(view)[1].rows.length,6);
 const second=homeRequest('TTEST',action('home_next_mine',expanded));assert.equal(second.minePage,1);
 assert.equal(tables(taskHome(store,{...context,...second}))[0].rows[1][0].element.text.text,'#27 · Task 26');
 const last=taskHome(store,{...context,mineExpanded:true,minePage:999});assert.equal(tables(last)[0].rows.length,8);assert.equal(JSON.parse(last.private_metadata).minePage,2);
 const collapsed=homeRequest('TTEST',action('home_collapse_mine',second));assert.equal(collapsed.mineExpanded,false);assert.equal(collapsed.minePage,0);
 assert.ok(actions(view).some(e=>e.action_id==='home_next_mine'));store.close();
});
test('Empty sections stay visible and queries clamp invalid page sizes',()=>{
 const store=new TaskStore();const view=taskHome(store,context);assert.equal(tables(view).length,2);
 for(const period of ['current','past'])for(const table of tables(taskHome(store,{...context,period}))){assert.equal(table.rows.length,2);assert.equal(table.rows[0].length,table.rows[1].length);assert.equal(table.rows[1][0].text,'No records');assert.equal(table.rows[1].filter(c=>c.text==='No records').length,1);assert.ok(table.rows[1].every(c=>c.type==='raw_text'));assert.match(table.caption,/· 0$/);}
 assert.equal(store.personalPage({...context,direction:'mine',size:100}).size,20);
 assert.equal(store.personalPage({...context,direction:'mine',size:-4}).size,1);
 assert.throws(()=>store.personalPage({...context,direction:'unsafe SQL'}));store.close();
});
test('Home navigation authenticates actor and rejects wrong workspace or unrelated actions',()=>{
 assert.deepEqual(homeRequest('TTEST',action()),{userId:'UME',...homeState({assignedExpanded:true})});
 const wrong=action();wrong.team.id='TOTHER';assert.equal(homeRequest('TTEST',wrong),null);
 const channel=action();delete channel.view;assert.equal(homeRequest('TTEST',channel),null);
 assert.equal(homeRequest('TTEST',action('home_select')),null);
 assert.equal(homeRequest('TTEST',action('home_next_mine')).minePage,0);
});
test('Socket Mode acknowledges Home events and table expansion',()=>{
 const store=new TaskStore(),config={store,teamId:'TTEST',allowedChannelId:'CTEST'};
 const opened={envelope_id:'home-event',type:'events_api',payload:{team_id:'TTEST',event:{type:'app_home_opened',user:'UME',tab:'home'}}};
 assert.deepEqual(handleEnvelope(config,opened),{ack:{envelope_id:'home-event'},home:{userId:'UME',...homeState()}});
 opened.payload.event.tab='messages';assert.equal(handleEnvelope(config,opened).home.userId,'UME');
 opened.payload.event.tab='about';assert.equal(handleEnvelope(config,opened).home,undefined);
 assert.equal(handleEnvelope(config,{envelope_id:'button',type:'interactive',payload:action()}).home.assignedExpanded,true);store.close();
});
test('Home publishes privately and escapes task directions by using plain text cells',async()=>{
 const store=new TaskStore();store.create({...base,title:'<!channel> *not markup*'});let call;
 await publishTaskHome({call:async(method,args)=>{call={method,args};}},store,context);
 assert.equal(call.method,'views.publish');assert.equal(call.args.user_id,'UME');assert.equal(tables(call.args.view)[0].rows[1][0].type,'action_cell');
 assert.match(tables(call.args.view)[0].rows[1][0].element.text.text,/<!channel>/);store.close();
});
