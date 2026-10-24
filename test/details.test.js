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
