import test from 'node:test';
import assert from 'node:assert/strict';
import {TaskStore,isTaskArchived} from '../src/tasks.js';
import {taskHome,homeRequest,homeState} from '../src/home.js';
import {handleAppUi} from '../src/ui.js';
const base={teamId:'TTEST',channelId:'CTEST',creatorId:'UCREATOR',assigneeId:'UASSIGNEE',title:'Lifecycle test'};
const week=7*24*60*60*1000;
const context={teamId:base.teamId,channelId:base.channelId,actorId:base.creatorId};
const config={teamId:base.teamId,allowedChannelId:base.channelId};
const page=(store,userId,direction,period,now=new Date())=>store.personalPage({...base,userId,direction,period,now});
const action=(task,name,user=base.creatorId,state={})=>({type:'block_actions',team:{id:base.teamId},user:{id:user},trigger_id:'trigger',view:{type:'home',private_metadata:JSON.stringify(homeState(state))},actions:[{action_id:name,value:JSON.stringify({id:task.id,version:task.version})}]});
test('Completion leaves assignee Current immediately and assigner Current exactly seven days later',()=>{
 const store=new TaskStore();let task=store.create(base);
 task=store.transition({...context,id:task.id,actorId:base.assigneeId,version:task.version,action:'complete'});
 const completed=Date.parse(task.completedAt);
 assert.equal(isTaskArchived(task,new Date(completed+week-1)),false);assert.equal(isTaskArchived(task,new Date(completed+week)),true);
 assert.equal(page(store,base.assigneeId,'mine','current').total,0);assert.equal(page(store,base.assigneeId,'mine','past').total,1);
 assert.equal(page(store,base.creatorId,'assigned','current',new Date(completed+week-1)).total,1);
 assert.equal(page(store,base.creatorId,'assigned','current',new Date(completed+week)).total,0);
 assert.equal(page(store,base.creatorId,'assigned','past',new Date(completed+week)).total,1);
 // Editing notes must not restart the completion window.
 task=store.manage({...context,id:task.id,version:task.version,action:'edit',changes:{...base,details:'More notes'}});
 assert.equal(Date.parse(task.completedAt),completed);assert.equal(page(store,base.creatorId,'assigned','past',new Date(completed+week)).total,1);store.close();
});
test('Archive is creator-only, changes only their list, and reopening resets lifecycle state',()=>{
 const store=new TaskStore();let task=store.create(base);
 task=store.transition({...context,id:task.id,actorId:base.assigneeId,action:'complete'});
 assert.throws(()=>store.manage({...context,actorId:base.assigneeId,id:task.id,version:task.version,action:'archive'}));
 const original=task.completedAt;
 task=store.manage({...context,id:task.id,version:task.version,action:'archive',receiptKey:'archive'});
 store.manage({...context,id:task.id,version:task.version-1,action:'archive',receiptKey:'archive'});
 assert.equal(page(store,base.creatorId,'assigned','current').total,0);assert.equal(page(store,base.creatorId,'assigned','past').total,1);assert.equal(page(store,base.assigneeId,'mine','past').total,1);
 task=store.manage({...context,id:task.id,version:task.version,action:'unarchive'});assert.equal(task.completedAt,original);assert.equal(page(store,base.creatorId,'assigned','current').total,1);
 task=store.manage({...context,id:task.id,version:task.version,action:'archive'});
 task=store.transition({...context,id:task.id,version:task.version,actorId:base.assigneeId,action:'reopen'});
 assert.equal(task.completedAt,null);assert.equal(task.archivedAt,null);assert.equal(task.creatorCurrentUntil,null);
 assert.equal(page(store,base.creatorId,'assigned','current').total,1);assert.equal(page(store,base.assigneeId,'mine','current').total,1);assert.equal(page(store,base.creatorId,'assigned','past').total,0);store.close();
});
test('Archived work stays readable in Past and only the creator can reactivate it',()=>{
 const store=new TaskStore();let task=store.create({...base,details:'Keep these requirements'});
 task=store.manage({...context,id:task.id,version:task.version,action:'archive'});
 for(const [user,direction] of [[base.creatorId,'assigned'],[base.assigneeId,'mine']]){assert.equal(page(store,user,direction,'current').total,0);assert.equal(page(store,user,direction,'past').total,1);}
 const mine=taskHome(store,{...base,userId:base.assigneeId,period:'past'}).blocks.find(b=>b.type==='data_table');assert.equal(mine.rows[1][3].text,'🔲 To do');assert.equal(mine.rows[1].length,5);
 const view=handleAppUi(store,config,action(task,'ui_details:mine:'+task.id,base.assigneeId,{period:'past'})).openModal.view;assert.match(JSON.stringify(view),/Keep these requirements/);assert.equal(view.blocks.some(b=>b.type==='actions'),false);
 assert.match(handleAppUi(store,config,action(task,'ui_unarchive',base.assigneeId,{period:'past'})).home.notice,/assigner/);
 handleAppUi(store,config,action(task,'ui_unarchive',base.creatorId,{period:'past'}));assert.equal(store.get(task.id,base.teamId).deletedAt,null);assert.equal(page(store,base.assigneeId,'mine','current').total,1);store.close();
});
test('View switching resets pages, Past orders recent activity, and pagination bounds apply',()=>{
 const store=new TaskStore();for(let i=0;i<26;i++){const t=store.create({...base,title:'Task '+i});store.transition({...context,id:t.id,actorId:base.assigneeId,action:'complete'});}
 const request=homeRequest(base.teamId,base.channelId,action({id:1,version:0},'home_past',base.assigneeId,{mineExpanded:true,minePage:2}));assert.equal(request.period,'past');assert.equal(request.mineExpanded,false);assert.equal(request.minePage,0);
 const view=taskHome(store,{...base,userId:base.assigneeId,...request});const table=view.blocks.find(b=>b.type==='data_table');assert.equal(table.rows[0][4].text,'Created at');assert.equal(table.rows[1][4].type,'raw_number');assert.equal(table.rows[1][4].value,Date.parse(store.get(26,base.teamId).createdAt));assert.equal(table.rows.length,6);assert.equal(table.rows[1][0].element.text.text,'Task 25');
 assert.equal(taskHome(store,{...base,userId:base.assigneeId,period:'past',mineExpanded:true}).blocks.find(b=>b.type==='data_table').rows.length,21);
 assert.equal(page(store,'USTRANGER','mine','past').total,0);assert.equal(store.personalPage({...base,teamId:'TOTHER',userId:base.assigneeId,direction:'mine',period:'past'}).total,0);store.close();
});

test('Lifecycle migration preserves old completion dates and archived state survives restart',async()=>{
 const {mkdtempSync,rmSync}=await import('node:fs');const {tmpdir}=await import('node:os');const {join}=await import('node:path');
 const dir=mkdtempSync(join(tmpdir(),'relay-lifecycle-')),path=join(dir,'tasks.sqlite');let store=new TaskStore(path);
 try{
  let task=store.create(base);task=store.transition({...context,id:task.id,actorId:base.assigneeId,action:'complete'});
  const completed=task.completedAt,notifications=store.db.prepare('SELECT count(*) AS n FROM completion_notifications').get().n;
  store.db.exec("ALTER TABLE tasks DROP COLUMN completedAt; ALTER TABLE tasks DROP COLUMN archivedAt; ALTER TABLE tasks DROP COLUMN creatorCurrentUntil; DELETE FROM schema_migrations WHERE name='task-lifecycle'");store.close();store=new TaskStore(path);
  task=store.get(task.id,base.teamId);assert.equal(task.completedAt,completed);assert.equal(store.db.prepare('SELECT count(*) AS n FROM completion_notifications').get().n,notifications);
  task=store.manage({...context,id:task.id,version:task.version,action:'archive'});store.close();store=new TaskStore(path);
  assert.equal(page(store,base.creatorId,'assigned','past').total,1);assert.equal(store.get(task.id,base.teamId).archivedAt,task.archivedAt);
 }finally{store.close();rmSync(dir,{recursive:true});}
});

test('Archiving To do stops work for both people without completion and can be reactivated',async()=>{
 const {taskMessage}=await import('../src/slack.js');const store=new TaskStore();let task=store.create(base);
 assert.throws(()=>store.manage({...context,actorId:base.assigneeId,id:task.id,version:task.version,action:'archive'}),/assigner/);
 task=store.manage({...context,id:task.id,version:task.version,action:'archive',receiptKey:'archive-todo'});
 assert.equal(task.status,'todo');assert.equal(task.completedAt,null);
 for(const [user,role] of [[base.creatorId,'assigned'],[base.assigneeId,'mine']]){assert.equal(page(store,user,role,'current').total,0);assert.equal(page(store,user,role,'past').total,1);}
 assert.equal(store.list({...base,userId:base.assigneeId,mode:'mine'}).length,0);
 assert.equal(store.db.prepare('SELECT count(*) AS n FROM completion_notifications').get().n,0);
 assert.throws(()=>store.transition({...context,id:task.id,version:task.version,actorId:base.assigneeId,action:'complete'}),/archived/);
 const card=taskMessage(task);assert.equal(card.blocks.some(b=>b.type==='actions'),false);assert.match(card.text,/To do · Archived/);assert.equal(card.blocks[2].fields[0].text,'*Status*\nTo do');assert.equal(card.blocks[2].fields[1].text,'*Archived*\nArchived');
 const mine=taskHome(store,{...base,userId:base.assigneeId,period:'past'}).blocks.find(b=>b.type==='data_table');assert.equal(mine.rows[1][3].text,'🔲 To do');assert.equal(mine.rows[1][3].element,undefined);
 const assigned=taskHome(store,{...base,userId:base.creatorId,period:'past'}).blocks.find(b=>b.type==='data_table');assert.equal(assigned.rows[1][5].element.text.text,'Archived');
 task=store.manage({...context,id:task.id,version:task.version,action:'unarchive'});
 assert.equal(task.status,'todo');assert.equal(task.archivedAt,null);assert.equal(task.creatorCurrentUntil,null);
 assert.equal(page(store,base.assigneeId,'mine','current').total,1);assert.equal(page(store,base.creatorId,'assigned','current').total,1);
 store.transition({...context,id:task.id,version:task.version,actorId:base.assigneeId,action:'complete'});assert.equal(store.get(task.id,base.teamId).status,'done');store.close();
});

test('Completing from Current shows a named success message above the tables and a working View Past shortcut',()=>{
 const store=new TaskStore();const task=store.create({...base,title:'<!channel> plain text task'});
 const result=handleAppUi(store,config,action(task,'ui_complete:mine:'+task.id,base.assigneeId));
 assert.equal(result.home.completionTitle,task.title);
 const view=taskHome(store,{...base,...result.home});
 assert.match(view.blocks[1].text.text,/✅.*<!channel> plain text task.*marked Done and moved to Past/);assert.equal(view.blocks[1].text.type,'plain_text');
 assert.equal(view.blocks[1].accessory.text.text,'View Past');assert.equal(view.blocks[1].accessory.action_id,'home_view_past');
 const past=homeRequest(base.teamId,base.channelId,action(task,'home_view_past',base.assigneeId));assert.equal(past.period,'past');
 const pastView=taskHome(store,{...base,...past});assert.equal(pastView.blocks.find(b=>b.type==='data_table').rows[1][0].element.text.text,task.title);assert.equal(pastView.blocks.some(b=>b.accessory?.action_id==='home_view_past'),false);store.close();
});

test('Old soft-deleted records migrate to archives without losing history or sending old notifications',async()=>{
 const {mkdtempSync,rmSync}=await import('node:fs');const {tmpdir}=await import('node:os');const {join}=await import('node:path');const {taskMessage}=await import('../src/slack.js');
 const dir=mkdtempSync(join(tmpdir(),'relay-archive-only-')),path=join(dir,'tasks.sqlite');let store=new TaskStore(path);
 try{
  const open=store.create({...base,details:'Original requirements'});let done=store.create({...base,title:'Old completed task'});done=store.transition({...context,id:done.id,actorId:base.assigneeId,action:'complete'});
  for(const task of [open,done]){store.db.prepare('UPDATE tasks SET deletedAt=? WHERE id=?').run('2026-10-01T10:00:00.000Z',task.id);store.db.prepare('INSERT INTO history(taskId,actorId,action,createdAt) VALUES (?,?,?,?)').run(task.id,base.creatorId,'delete','2026-10-01T10:00:00.000Z');}
  store.db.exec("DELETE FROM outbox; DELETE FROM schema_migrations WHERE name='archive-only'");store.close();store=new TaskStore(path);
  const migrated=store.get(open.id,base.teamId);assert.equal(migrated.deletedAt,null);assert.equal(migrated.archivedAt,'2026-10-01T10:00:00.000Z');assert.equal(migrated.details,'Original requirements');assert.equal(store.history(open.id).at(-1).action,'delete');
  assert.equal(store.get(done.id,base.teamId).status,'done');assert.equal(store.pending().length,2);assert.equal(store.db.prepare('SELECT count(*) AS n FROM completion_notifications WHERE sentTs IS NULL').get().n,0);
  const view=taskHome(store,{...base,userId:base.creatorId,period:'past'});assert.doesNotMatch(JSON.stringify(view),/Deleted|Delete task|Restore|Undo delete/);assert.doesNotMatch(JSON.stringify(taskMessage(migrated)),/Deleted/);
  store.manage({...context,id:migrated.id,version:migrated.version,action:'unarchive'});assert.equal(page(store,base.assigneeId,'mine','current').total,1);
 }finally{store.close();rmSync(dir,{recursive:true});}
});
