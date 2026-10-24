import test from 'node:test';
import assert from 'node:assert/strict';
import { TaskStore } from '../src/tasks.js';
import { taskHome, homeState } from '../src/home.js';
import { handleAppUi } from '../src/ui.js';
import { handleEnvelope } from '../src/socket.js';
import { taskMessage } from '../src/slack.js';
const config={teamId:'TTEST',allowedChannelId:'CTEST'};
const base={teamId:'TTEST',channelId:'CTEST',creatorId:'UME',assigneeId:'UOTHER',title:'Build a task',dueDate:null};
function action(name,state={},actor='UME'){
 return {type:'block_actions',team:{id:'TTEST'},user:{id:actor},trigger_id:'trigger',view:{type:'home',private_metadata:JSON.stringify(homeState(state))},actions:[{action_id:name,value:JSON.stringify({id:state.selectedId,version:state.selectedVersion})}]};
}
function submit(meta,values={},actor='UME',id='VMODAL'){
 return {type:'view_submission',team:{id:'TTEST'},user:{id:actor},view:{id,type:'modal',callback_id:'relay_task_form',private_metadata:JSON.stringify(meta),state:{values:{title:{value:{value:values.title??'Task from Home'}},assignee:{value:{selected_user:values.assigneeId??'UOTHER'}},due_date:{value:{selected_date:values.dueDate??null}},due_time:{value:{selected_time:values.dueTime??null}}}}}};
}
const select=task=>({mode:'assigned',filter:'all',selectedId:task.id,selectedVersion:task.version});
test('New task opens a Slack form, saves once, and preserves the current view',()=>{
 const store=new TaskStore();
 const opened=handleAppUi(store,config,action('ui_new',{assignedExpanded:true,assignedPage:1}));
 assert.equal(opened.openModal.view.title.text,'New task');
 assert.equal(opened.openModal.view.blocks[1].element.type,'users_select');
 const meta=JSON.parse(opened.openModal.view.private_metadata);
 const payload=submit(meta,{dueDate:'2026-11-05'});
 const saved=handleAppUi(store,config,payload,'first');handleAppUi(store,config,payload,'retry');
 const tasks=store.list({teamId:'TTEST',channelId:'CTEST'});
 assert.equal(tasks.length,1);assert.equal(tasks[0].dueDate,'2026-11-05');
 assert.equal(tasks[0].creatorId,'UME');assert.equal(saved.home.assignedExpanded,true);assert.equal(saved.home.assignedPage,1);
 store.close();
});
test('Edit form changes assignee and date, clears optional dates, and rejects stale saves',()=>{
 const store=new TaskStore();let task=store.create(base);
 const opened=handleAppUi(store,config,action('ui_edit',select(task)));
 const meta=JSON.parse(opened.openModal.view.private_metadata);
 handleAppUi(store,config,submit(meta,{title:'Updated',assigneeId:'UME',dueDate:'2026-11-10'}));
 task=store.get(task.id,'TTEST');assert.equal(task.title,'Updated');assert.equal(task.assigneeId,'UME');assert.equal(task.dueDate,'2026-11-10');
 const stale=handleAppUi(store,config,submit(meta,{title:'Overwrite'},'UME','VSTALE'));
 assert.equal(stale.ackPayload.response_action,'errors');assert.equal(store.get(task.id,'TTEST').title,'Updated');
 const current=JSON.parse(handleAppUi(store,config,action('ui_edit',{...select(task),mode:'mine'})).openModal.view.private_metadata);
 handleAppUi(store,config,submit(current,{title:'No deadline',assigneeId:'UME'},'UME','VCLEAR'));
 assert.equal(store.get(task.id,'TTEST').dueDate,null);store.close();
});
test('Assignees cannot edit or delete; neither role can cross a workspace or channel',()=>{
 const store=new TaskStore();const task=store.create(base);
 for(const name of ['ui_edit','ui_delete'])assert.equal(handleAppUi(store,config,action(name,select(task),'UOTHER')).openModal,undefined);
 assert.equal(handleAppUi(store,config,{...action('ui_new'),team:{id:'TOTHER'}}),null);
 assert.equal(handleAppUi(store,{...config,allowedChannelId:'COTHER'},action('ui_edit',select(task))).openModal,undefined);
 assert.throws(()=>store.manage({id:task.id,teamId:'TTEST',channelId:'CTEST',actorId:'UOTHER',version:0,action:'delete'}));
 store.close();
});
test('Delete confirms, hides the task, and offers Undo without a Trash view',()=>{
 const store=new TaskStore();const task=store.create(base);
 const opened=handleAppUi(store,config,action('ui_delete',select(task)));
 assert.equal(opened.openModal.view.submit.text,'Delete task');
 assert.equal(store.get(task.id,'TTEST').deletedAt,null);
 const result=handleAppUi(store,config,submit(JSON.parse(opened.openModal.view.private_metadata)));
 const home=taskHome(store,{teamId:'TTEST',channelId:'CTEST',...result.home});
 assert.equal(home.blocks.find(b=>b.accessory?.action_id==='ui_restore').accessory.text.text,'Undo delete');
 const deleted=store.get(task.id,'TTEST');assert.ok(deleted.deletedAt);
 assert.equal(store.list({teamId:'TTEST',channelId:'CTEST'}).length,0);
 assert.equal(store.personalPage({teamId:'TTEST',channelId:'CTEST',userId:'UME',direction:'trash'}).total,1);
 assert.equal(store.personalPage({teamId:'TTEST',channelId:'CTEST',userId:'UOTHER',direction:'trash'}).total,0);
 assert.equal(taskMessage(deleted).blocks.some(b=>b.type==='actions'),false);
 handleAppUi(store,config,action('ui_restore',{...select(deleted),mode:'trash'}),'restore');
 assert.equal(store.get(task.id,'TTEST').deletedAt,null);assert.equal(store.history(task.id).at(-1).action,'restore');store.close();
});
test('Mark done and Reopen enforce roles and support completing a task again',()=>{
 const store=new TaskStore();let task=store.create(base);
 assert.throws(()=>store.transition({...base,id:task.id,actorId:'UME',version:0,action:'complete'}));
 task=store.transition({...base,id:task.id,actorId:'UOTHER',version:0,action:'complete'});
 store.notificationDelivered(store.pendingNotifications()[0]?.notificationId??1,'sent');
 assert.throws(()=>store.transition({...base,id:task.id,actorId:'UME',version:task.version,action:'reopen'}),/assignee/);
 task=store.transition({...base,id:task.id,actorId:'UOTHER',version:task.version,action:'reopen'});
 assert.equal(task.status,'todo');
 task=store.transition({...base,id:task.id,actorId:'UOTHER',version:task.version,action:'complete'});
 assert.equal(task.status,'done');assert.equal(store.db.prepare('SELECT count(*) AS n FROM completion_notifications').get().n,2);
 store.close();
});
test('Inline row controls respect ownership and carry independent task identities',()=>{
 const store=new TaskStore();let task=store.create(base);
 const view=taskHome(store,{teamId:'TTEST',channelId:'CTEST',userId:'UME',...select(task)});
 const allActions=view.blocks.flatMap(b=>b.rows?.slice(1).flatMap(r=>r.map(c=>c.element?.action_id?.split(':')[0]))??[]);
 assert.ok(allActions.includes('ui_details'));assert.ok(!allActions.includes('ui_delete'));assert.ok(!allActions.includes('ui_complete'));
 const assigneeView=taskHome(store,{teamId:'TTEST',channelId:'CTEST',userId:'UOTHER',filter:'all',selectedId:task.id});
 const theirActions=assigneeView.blocks.flatMap(b=>b.rows?.slice(1).flatMap(r=>r.map(c=>c.element?.action_id?.split(':')[0]))??[]);
 assert.ok(theirActions.includes('ui_complete'));assert.ok(theirActions.includes('ui_details'));
 task=store.transition({...base,id:task.id,actorId:'UOTHER',action:'complete'});
 assert.equal(store.personalPage({teamId:'TTEST',channelId:'CTEST',userId:'UOTHER',direction:'mine',filter:'todo'}).total,0);
 assert.equal(store.personalPage({teamId:'TTEST',channelId:'CTEST',userId:'UOTHER',direction:'mine',filter:'done'}).total,1);store.close();
});
test('Socket modal submissions acknowledge inline validation errors before side effects',()=>{
 const store=new TaskStore();const payload=submit({operation:'create',state:homeState()},{title:'   '});
 const result=handleEnvelope({store,...config},{type:'interactive',envelope_id:'bad-form',accepts_response_payload:true,payload});
 assert.equal(result.ack.payload.response_action,'errors');assert.ok(result.ack.payload.errors.title);
 assert.equal(store.db.prepare('SELECT count(*) AS n FROM tasks').get().n,0);store.close();
});

test('Row controls reject stale and malformed values without changing other tasks',()=>{
 const store=new TaskStore();const one=store.create({...base,assigneeId:'UME'}),two=store.create({...base,assigneeId:'UME'});
 const click=action('ui_complete:mine:'+one.id,select(one));
 handleAppUi(store,config,click,'row-click');assert.equal(store.get(one.id,'TTEST').status,'done');assert.equal(store.get(two.id,'TTEST').status,'todo');
 assert.match(handleAppUi(store,config,click,'stale').home.notice,/changed/);
 click.actions[0].value='not json';assert.match(handleAppUi(store,config,click).home.notice,/Refresh/);store.close();
});

test('Previously published dropdowns remain safe during the table rollout',()=>{
 const store=new TaskStore();let task=store.create(base);
 const choose=(status,actor='UOTHER',version=task.version)=>{const p=action('ui_status:mine:'+task.id,{},actor);p.actions[0].type='static_select';p.actions[0].selected_option={value:JSON.stringify({id:task.id,version,status})};delete p.actions[0].value;return p;};
 const done=choose('done');const result=handleAppUi(store,config,done,'dropdown-done');assert.equal(result.openModal,undefined);assert.equal(result.ackPayload.response_action,undefined);
 handleAppUi(store,config,done,'dropdown-done');task=store.get(task.id,'TTEST');assert.equal(task.status,'done');assert.equal(task.version,1);assert.equal(store.db.prepare('SELECT count(*) AS n FROM completion_notifications').get().n,1);
 assert.match(handleAppUi(store,config,done,'stale').home.notice,/changed/);
 assert.match(handleAppUi(store,config,choose('todo','UME'),'owner-reopen').home.notice,/assignee/);
 assert.equal(store.get(task.id,'TTEST').status,'done');
 handleAppUi(store,config,choose('todo'),'reopen');task=store.get(task.id,'TTEST');assert.equal(task.status,'todo');
 assert.match(handleAppUi(store,config,choose('done','UME'),'forged').home.notice,/assignee/);assert.equal(store.get(task.id,'TTEST').status,'todo');
 handleAppUi(store,config,choose('todo'),'noop');assert.equal(store.get(task.id,'TTEST').version,2);
 assert.match(handleAppUi(store,config,choose('invalid'),'invalid').home.notice,/Choose/);store.close();
});

test('Assigned-by-you status is read-only and stale creator buttons cannot reopen tasks',()=>{
 const store=new TaskStore();let task=store.create(base);
 task=store.transition({...base,id:task.id,actorId:'UOTHER',action:'complete'});
 const owner=taskHome(store,{teamId:'TTEST',channelId:'CTEST',userId:'UME'});
 const row=owner.blocks.find(b=>b.type==='data_table').rows[1];
 assert.equal(row[3].type,'raw_text');assert.equal(row[3].text,'✅ Done');
 assert.equal(row[0].element.action_id.split(':')[0],'ui_details');assert.equal(row[4].element.action_id.split(':')[0],'ui_archive');
 const denied=handleAppUi(store,config,action('ui_reopen:assigned:'+task.id,select(task)),'old-creator-button');
 assert.match(denied.home.notice,/assignee/);assert.equal(store.get(task.id,'TTEST').status,'done');assert.equal(store.get(task.id,'TTEST').version,1);
 const mine=taskHome(store,{teamId:'TTEST',channelId:'CTEST',userId:'UOTHER',period:'past'});
 assert.equal(mine.blocks.find(b=>b.type==='data_table').rows[1][3].element.action_id.split(':')[0],'ui_reopen');store.close();
});

test('Task forms set and clear due times and show missing-date errors inline',()=>{
 const store=new TaskStore();const open=handleAppUi(store,config,action('ui_new'));
 assert.equal(open.openModal.view.blocks.find(b=>b.block_id==='due_time').element.type,'timepicker');
 const meta=JSON.parse(open.openModal.view.private_metadata);
 const invalid=handleAppUi(store,config,submit(meta,{dueTime:'12:30'},'UME','VTIMEONLY'));assert.ok(invalid.ackPayload.errors.due_date);
 handleAppUi(store,config,submit(meta,{dueDate:'2026-11-06',dueTime:'12:30'},'UME','VTIMED'));
 let task=store.list({teamId:'TTEST',channelId:'CTEST'})[0];assert.equal(task.dueTime,'12:30');
 const edit=handleAppUi(store,config,action('ui_edit',select(task)));assert.equal(edit.openModal.view.blocks.find(b=>b.block_id==='due_time').element.initial_time,'12:30');
 handleAppUi(store,config,submit(JSON.parse(edit.openModal.view.private_metadata),{dueDate:'2026-11-06'},'UME','VCLEARTIME'));
 assert.equal(store.get(task.id,'TTEST').dueTime,null);store.close();
});

test('Due cells let only the assigner change or clear deadlines without changing task details',()=>{
 const store=new TaskStore();let task=store.create(base);
 const row=taskHome(store,{teamId:'TTEST',channelId:'CTEST',userId:'UME'}).blocks.find(b=>b.type==='data_table').rows[1];
 assert.equal(row[2].element.text.text,'Set due date');assert.equal(row[2].element.action_id,'ui_due:assigned:'+task.id);
 assert.equal(handleAppUi(store,config,action('ui_due',select(task),'UOTHER')).openModal,undefined);
 const opened=handleAppUi(store,config,action('ui_due',select(task))).openModal.view;
 assert.deepEqual(opened.blocks.filter(b=>b.type==='input').map(b=>b.block_id),['due_date','due_time']);
 const meta=JSON.parse(opened.private_metadata);
 const save=submit(meta,{title:'Must not overwrite',assigneeId:'UFORGED',dueDate:'2026-11-08',dueTime:'16:15'},'UME','VDUE');
 assert.deepEqual(handleAppUi(store,config,save).ackPayload,{});
 task=store.get(task.id,'TTEST');assert.equal(task.title,base.title);assert.equal(task.assigneeId,base.assigneeId);assert.equal(task.dueDate,'2026-11-08');assert.equal(task.dueTime,'16:15');
 const stale=handleAppUi(store,config,submit(meta,{dueDate:'2026-11-09'},'UME','VDUESTALE'));assert.match(stale.ackPayload.errors.due_date,/changed/);
 const current=JSON.parse(handleAppUi(store,config,action('ui_due',select(task))).openModal.view.private_metadata);
 handleAppUi(store,config,submit(current,{},'UME','VDUECLEAR'));task=store.get(task.id,'TTEST');assert.equal(task.dueDate,null);assert.equal(task.dueTime,null);store.close();
});

test('Task names open shared details, only creators edit, and saves return to details',()=>{
 const store=new TaskStore();let task=store.create({...base,details:'Requirements\n<!channel> is plain text'});
 const opened=handleAppUi(store,config,action('ui_details',select(task),'UOTHER')).openModal.view;
 assert.equal(opened.title.text,'Task details');assert.match(JSON.stringify(opened),/Requirements/);assert.equal(opened.blocks.some(b=>b.type==='actions'),false);
 assert.equal(handleAppUi(store,config,action('ui_details',select(task),'USTRANGER')).openModal,undefined);
 const owner=handleAppUi(store,config,action('ui_details',select(task))).openModal.view;
 const editAction={...action('ui_edit_details',select(task)),view:{...owner,id:'VDETAILS',hash:'hash'}};
 const result=handleAppUi(store,config,editAction);assert.equal(result.updateModal.view_id,'VDETAILS');
 const form=result.updateModal.view;assert.equal(form.blocks.find(b=>b.block_id==='details').element.initial_value,task.details);
 const payload=submit(JSON.parse(form.private_metadata),{title:base.title},'UME','VDETAILSSAVE');
 payload.view.state.values.details={value:{value:'New requirements'}};
 const saved=handleAppUi(store,config,payload);assert.equal(saved.ackPayload.response_action,'update');assert.equal(saved.ackPayload.view.title.text,'Task details');
 task=store.get(task.id,'TTEST');assert.equal(task.details,'New requirements');assert.deepEqual(JSON.parse(task.images),[]);
 const denied=handleAppUi(store,config,{...editAction,user:{id:'UOTHER'}});assert.equal(denied.updateModal.view.title.text,'Could not save');
 const old=handleAppUi(store,config,payload);assert.match(JSON.stringify(old),/Changes saved/);assert.equal(store.history(task.id).filter(h=>h.action==='edit').length,1);store.close();
});

test('Details persist and image controls preserve or unlink attachments without file deletion',()=>{
 const old=process.env.SLACK_IMAGE_UPLOADS;process.env.SLACK_IMAGE_UPLOADS='true';
 try{
 const store=new TaskStore();let task=store.create({...base,details:'Read this',images:['FIMAGE1']});
 const edit=handleAppUi(store,config,action('ui_edit',select(task))).openModal.view;
 assert.equal(edit.blocks.find(b=>b.block_id==='images').element.type,'file_input');
 const payload=submit(JSON.parse(edit.private_metadata),{title:base.title},'UME','VIMAGES');
 payload.view.state.values.details={value:{value:'With pictures'}};
 payload.view.state.values.keep_images={value:{selected_options:[{value:'FIMAGE1'}]}};
 payload.view.state.values.images={value:{files:[{id:'FIMAGE2',mimetype:'image/png'}]}};
 assert.deepEqual(handleAppUi(store,config,payload).ackPayload,{});task=store.get(task.id,'TTEST');assert.deepEqual(JSON.parse(task.images),['FIMAGE1','FIMAGE2']);
 const form=handleAppUi(store,config,action('ui_edit',select(task))).openModal.view;
 const clear=submit(JSON.parse(form.private_metadata),{title:base.title},'UME','VCLEARIMAGES');clear.view.state.values.details={value:{value:''}};
 handleAppUi(store,config,clear);task=store.get(task.id,'TTEST');assert.equal(task.details,'');assert.deepEqual(JSON.parse(task.images),[]);
 const forged=submit(JSON.parse(handleAppUi(store,config,action('ui_edit',select(task))).openModal.view.private_metadata),{title:base.title},'UME','VFORGED');forged.view.state.values.details={value:{value:'x'}};forged.view.state.values.keep_images={value:{selected_options:[{value:'FUNRELATED'}]}};
 assert.equal(handleAppUi(store,config,forged).ackPayload.response_action,'errors');assert.equal(store.get(task.id,'TTEST').details,'');store.close();
 }finally{if(old===undefined)delete process.env.SLACK_IMAGE_UPLOADS;else process.env.SLACK_IMAGE_UPLOADS=old;}
});

test('New tasks save details and a second save in the same details modal is not deduplicated',()=>{
 const store=new TaskStore();const form=handleAppUi(store,config,action('ui_new')).openModal.view;
 const create=submit(JSON.parse(form.private_metadata),{title:'Details on creation'},'UME','VCREATEDETAILS');create.view.state.values.details={value:{value:'First requirements'}};
 assert.deepEqual(handleAppUi(store,config,create).ackPayload,{});
 let task=store.list({teamId:'TTEST',channelId:'CTEST'})[0];assert.equal(task.details,'First requirements');
 for(const details of ['Second requirements','Third requirements']) {
 const edit=handleAppUi(store,config,action('ui_edit',select(task))).openModal.view;
 const payload=submit(JSON.parse(edit.private_metadata),{title:task.title},'UME','VSAME');payload.view.state.values.details={value:{value:details}};
 assert.deepEqual(handleAppUi(store,config,payload).ackPayload,{});task=store.get(task.id,'TTEST');assert.equal(task.details,details);
 }
 store.close();
});

test('Assigned-to-you details stay read-only even for self-assigned tasks',()=>{
 const store=new TaskStore();const task=store.create({...base,assigneeId:'UME'});
 const mine=handleAppUi(store,config,action('ui_details:mine:'+task.id,select(task))).openModal.view;
 assert.equal(mine.blocks.some(b=>b.type==='actions'),false);
 const forged={...action('ui_edit_details',select(task)),view:{...mine,id:'VMINE',hash:'hash'}};
 assert.equal(handleAppUi(store,config,forged).updateModal.view.title.text,'Could not save');
 for(const name of ['ui_edit','ui_due','ui_delete'])assert.equal(handleAppUi(store,config,action(name+':mine:'+task.id,select(task))).openModal,undefined);
 const assigned=handleAppUi(store,config,action('ui_details:assigned:'+task.id,select(task))).openModal.view;
 assert.equal(assigned.blocks.find(b=>b.type==='actions').elements[0].text.text,'Edit');
 const edit={...forged,view:{...assigned,id:'VASSIGNED',hash:'hash'}};assert.equal(handleAppUi(store,config,edit).updateModal.view.title.text,'Edit task');
 assert.ok(handleAppUi(store,config,action('ui_complete:mine:'+task.id,select(task))).home);assert.equal(store.get(task.id,'TTEST').status,'done');store.close();
});
