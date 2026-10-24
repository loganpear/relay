import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {TaskStore,validateDetails,taskImages} from '../src/tasks.js';
const base={teamId:'TTEST',channelId:'CTEST',creatorId:'UME',assigneeId:'UOTHER',title:'Requirements'};
test('Details survive restarts, migrate old tasks, and survive deadline-only changes',()=>{
 const dir=mkdtempSync(join(tmpdir(),'relay-details-')),path=join(dir,'test.sqlite');let store=new TaskStore(path);
 try{
  let task=store.create({...base,details:'Acceptance criteria',images:['FIMAGE1']});store.close();store=new TaskStore(path);
  task=store.get(task.id,base.teamId);assert.equal(task.details,'Acceptance criteria');assert.deepEqual(taskImages(task),['FIMAGE1']);
  task=store.manage({...base,id:task.id,actorId:'UME',version:task.version,action:'edit',changes:{...base,dueDate:'2027-01-01'}});
  assert.equal(task.details,'Acceptance criteria');assert.deepEqual(taskImages(task),['FIMAGE1']);
  store.db.exec("ALTER TABLE tasks DROP COLUMN details; ALTER TABLE tasks DROP COLUMN images; DELETE FROM schema_migrations WHERE name='task-details'");store.close();store=new TaskStore(path);
  task=store.get(task.id,base.teamId);assert.equal(task.details,'');assert.deepEqual(taskImages(task),[]);assert.equal(task.dueDate,'2027-01-01');
 }finally{store.close();rmSync(dir,{recursive:true});}
});
test('Details enforce text and attachment limits',()=>{
 assert.throws(()=>validateDetails('x'.repeat(3001)),/3,000/);
 assert.throws(()=>validateDetails('',Array.from({length:6},(_,i)=>'FIMAGE'+i)),/five/);
 assert.throws(()=>validateDetails('',['https://example.com/image.png']),/images/);
 assert.deepEqual(validateDetails('  Requirements  ',['FIMAGE1','FIMAGE1']),{details:'Requirements',images:['FIMAGE1']});
});

test('Slash details parse quoted notes independently of deadline flags and persist through command handling',async()=>{
 const {parseTask}=await import('../src/tasks.js');const {handleCommand}=await import('../src/server.js');
 const now=new Date('2026-10-24T16:00:00Z');
 for(const options of ['--due 11/06 05:30 PM --details "Email validation"','--details "Email validation" --due 11/06 05:30 PM']) {
 const task=parseTask('<@UOTHER> Build signup '+options,{now});assert.equal(task.title,'Build signup');assert.equal(task.details,'Email validation');assert.equal(task.dueDate,'2026-11-06');assert.equal(task.dueTime,'17:30');
 }
 const literal=parseTask('<@UOTHER> Build --details "Document --due and --no-review flags"');assert.equal(literal.details,'Document --due and --no-review flags');assert.equal(literal.title,'Build');assert.equal(literal.dueDate,null);
 assert.equal(parseTask('<@UOTHER> Build --details “Mobile notes”').details,'Mobile notes');
 assert.equal(parseTask(String.raw`<@UOTHER> Build --details "Show \"Done\" and C:\\notes"`).details,'Show "Done" and C:\\notes');
 assert.equal(parseTask('<@UOTHER> Build --details ""').details,'');
 for(const options of ['--details unquoted','--details "unclosed','--details "notes"bad','--details "one" --details "two"','--details "'+ 'x'.repeat(3001)+'"'])assert.throws(()=>parseTask('<@UOTHER> Build '+options),/details|quotes|3,000/);
 const store=new TaskStore();const form={team_id:'TTEST',channel_id:'CTEST',user_id:'UME',command:'/task',text:'<@UOTHER> Build --details "Requirements\nTwo lines"'};
 handleCommand(store,form,'details-command');handleCommand(store,form,'details-command');const tasks=store.list({teamId:'TTEST',channelId:'CTEST'});assert.equal(tasks.length,1);assert.equal(tasks[0].details,'Requirements\nTwo lines');
 assert.throws(()=>handleCommand(store,{...form,text:'<@UOTHER> Build --details broken'},'invalid'));assert.equal(store.list({teamId:'TTEST',channelId:'CTEST'}).length,1);store.close();
});
