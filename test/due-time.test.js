import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {TaskStore,parseTask,validateTask,formatDue} from '../src/tasks.js';
import {taskHome} from '../src/home.js';
import {taskMessage} from '../src/slack.js';
const base={teamId:'TTEST',channelId:'CTEST',creatorId:'UME',assigneeId:'UOTHER',title:'Deadline check'};
test('Due display is MM/DD h:mm AM/PM in both Home and channel cards',()=>{
 const store=new TaskStore();const task=store.create({...base,dueDate:'2026-11-06',dueTime:'09:05'});
 assert.equal(formatDue(task),'11/06 9:05 AM');assert.equal(formatDue({...task,dueTime:'00:00'}),'11/06 12:00 AM');
 assert.equal(formatDue({...task,dueTime:'12:00'}),'11/06 12:00 PM');assert.equal(formatDue({...task,dueTime:'17:30'}),'11/06 5:30 PM');
 assert.equal(formatDue({...task,dueTime:null}),'11/06');assert.equal(formatDue({...task,dueDate:null}),'—');
 const view=taskHome(store,{teamId:'TTEST',channelId:'CTEST',userId:'UOTHER'});
 assert.match(view.blocks.find(b=>b.type==='data_table').rows[1][2].text,/11\/06 9:05 AM$/);
 assert.match(JSON.stringify(taskMessage(task)),/11\/06 9:05 AM/);store.close();
});
test('Overdue follows Eastern local time rather than the host UTC date',()=>{
 const task={...base,status:'todo',dueDate:'2026-11-06',dueTime:'23:30'};
 assert.equal(formatDue(task,{now:new Date('2026-11-07T04:20:00Z'),markOverdue:true}),'11/06 11:30 PM');
 assert.equal(formatDue(task,{now:new Date('2026-11-07T04:40:00Z'),markOverdue:true}),'Overdue · 11/06 11:30 PM');
 assert.equal(formatDue({...task,dueTime:null},{now:new Date('2026-11-07T04:40:00Z'),markOverdue:true}),'11/06');
 assert.equal(formatDue({...task,dueTime:null},{now:new Date('2026-11-07T05:01:00Z'),markOverdue:true}),'Overdue · 11/06');
 assert.equal(formatDue({...task,status:'done'},{now:new Date('2026-11-08T05:00:00Z'),markOverdue:true}),'11/06 11:30 PM');
});
test('Validates times and slash-command deadlines without guessing a missing date',()=>{
 assert.equal(parseTask('<@UOTHER> Ship --due 2026-11-06 --at 17:45').dueTime,'17:45');
 for(const dueTime of ['24:00','12:60','9:05','noon'])assert.throws(()=>validateTask({...base,dueDate:'2026-11-06',dueTime}),/time/);
 assert.throws(()=>validateTask({...base,dueTime:'09:05'}),/date/);
 assert.throws(()=>parseTask('<@UOTHER> Ship --at 12:00'),/date/);
});
test('Timed deadlines persist, edits can clear times, and migration preserves date-only work',()=>{
 const dir=mkdtempSync(join(tmpdir(),'relay-deadline-')),path=join(dir,'test.sqlite');let store=new TaskStore(path);
 try{
  let task=store.create({...base,dueDate:'2026-11-06',dueTime:'17:45'});store.close();store=new TaskStore(path);
  task=store.get(task.id,'TTEST');assert.equal(task.dueTime,'17:45');
  task=store.manage({id:task.id,teamId:'TTEST',channelId:'CTEST',actorId:'UME',version:task.version,action:'edit',changes:{...base,dueDate:'2026-11-06'}});
  assert.equal(task.dueTime,null);
  store.db.exec("ALTER TABLE tasks DROP COLUMN dueTime; DELETE FROM schema_migrations WHERE name='due-time'");store.close();store=new TaskStore(path);
  task=store.get(task.id,'TTEST');assert.equal(task.dueDate,'2026-11-06');assert.equal(task.dueTime,null);assert.equal(task.status,'todo');assert.equal(store.history(task.id).length,2);
 }finally{store.close();rmSync(dir,{recursive:true});}
});

test('Short slash deadlines infer the next future year in Eastern time',()=>{
 const parse=(deadline,now='2026-10-24T18:00:00Z')=>parseTask('<@UOTHER> Ship --due '+deadline,{now:new Date(now)});
 assert.deepEqual(parse('11/06 05:30 PM'),{assigneeId:'UOTHER',title:'Ship',dueDate:'2026-11-06',dueTime:'17:30'});
 assert.equal(parse('01/05 09:00 AM').dueDate,'2027-01-05');
 assert.equal(parse('10/24 03:00 PM').dueDate,'2026-10-24');
 assert.equal(parse('10/24 01:00 PM').dueDate,'2027-10-24');
 assert.equal(parse('10/24 02:00 PM').dueDate,'2027-10-24');
 assert.equal(parse('02/29 12:00 AM').dueDate,'2028-02-29');
 assert.equal(parse('02/29 12:00 AM').dueTime,'00:00');
 assert.equal(parse('11/06 12:00 pm').dueTime,'12:00');
 assert.equal(parse('12/31 11:59 PM','2027-01-01T02:00:00Z').dueDate,'2026-12-31');
 for(const value of ['02/30 05:00 PM','13/01 05:00 PM','11/06 00:30 AM','11/06 13:00 PM','11/06 05:60 PM','11/06 05:00','11/06','11/06 05:00 PM --at 12:00','11/06 05:00 PM --due 12/01 06:00 PM'])assert.throws(()=>parse(value),/due|option|hour/);
});
