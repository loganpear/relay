import { TaskError, validateTask, dueTimezone, dueTimezoneLabel } from './tasks.js';
import { homeRequest, homeState, viewState, section, publishTaskHome } from './home.js';

const plain = text => ({type:'plain_text',text});
const input = (block_id,label,element,optional=false)=>({type:'input',block_id,label:plain(label),element,...(optional?{optional:true}:{})});
function modal(operation, state, task) {
  const meta={operation,state,...(task?{taskId:task.id,version:task.version}:{})};
  const base={type:'modal',callback_id:'relay_task_form',private_metadata:JSON.stringify(meta),title:plain(operation==='create'?'New task':operation==='edit'?'Edit task':operation==='due'?'Edit due date':'Delete task'),close:plain('Cancel')};
  if(operation==='delete')return {...base,submit:plain('Delete task'),blocks:[section(`Delete “${task.title}”? It will disappear from both task lists. You can undo this immediately afterward.`)]};
  return {...base,submit:plain(operation==='create'?'Create task':'Save changes'),blocks:[
    ...(operation==='due'?[section(task.title)]:[input('title','Task',{type:'plain_text_input',action_id:'value',max_length:240,...(task?{initial_value:task.title}:{})}),
    input('assignee','Assign to',{type:'users_select',action_id:'value',placeholder:plain('Choose a teammate'),...(task?{initial_user:task.assigneeId}:{})})]),
    input('due_date','Due date',{type:'datepicker',action_id:'value',placeholder:plain('Choose a date'),...(task?.dueDate?{initial_date:task.dueDate}:{})},true),
    input('due_time','Due time',{type:'timepicker',action_id:'value',timezone:dueTimezone,placeholder:plain('Choose a time'),...(task?.dueTime?{initial_time:task.dueTime}:{})},true),
    {type:'context',elements:[plain('Times use '+dueTimezoneLabel+'. Tasks are posted only in the channel configured for Relay. The assignee marks work done; the assigner gets a completion mention.')]}
  ]};
}
function failedModal(message){return {response_action:'update',view:{type:'modal',title:plain('Could not save'),close:plain('Close'),blocks:[section(message+' Close this form and refresh Relay before trying again.')]}};}
export function handleAppUi(store,{teamId,allowedChannelId},payload,receiptKey){
  if(!allowedChannelId||payload.team?.id!==teamId||!/^[UW][A-Z0-9]+$/.test(payload.user?.id??''))return null;
  const actorId=payload.user.id;
  const context={teamId,channelId:allowedChannelId,actorId};
  if(payload.type==='view_submission'&&payload.view?.callback_id==='relay_task_form'){
    let meta;
    try{meta=JSON.parse(payload.view.private_metadata||'{}');}catch{return {ackPayload:failedModal('Invalid form.')}}
    const state=homeState(meta.state);
    const home={userId:actorId,...state};
    const key=`modal:${payload.view.id}`;
    try{
      if(!payload.view.id)throw new TaskError('This form has no identity.');
      if(['create','edit','due'].includes(meta.operation)){
        const values=payload.view.state?.values??{};
        const task=meta.operation==='due'?store.get(meta.taskId,teamId):null;
        const changes=validateTask({title:meta.operation==='due'?task?.title:values.title?.value?.value,assigneeId:meta.operation==='due'?task?.assigneeId:values.assignee?.value?.selected_user,dueDate:values.due_date?.value?.selected_date,dueTime:values.due_time?.value?.selected_time});
        if(meta.operation==='create')store.create({...changes,teamId,channelId:allowedChannelId,creatorId:actorId},key);
        else store.manage({...context,id:meta.taskId,version:meta.version,action:'edit',changes,receiptKey:key});
        return {ackPayload:{},home:{...home,notice:meta.operation==='create'?'Task created.':'Changes saved.'}};
      }
      if(meta.operation==='delete'){
        const deleted=store.manage({...context,id:meta.taskId,version:meta.version,action:'delete',receiptKey:key});
        return {ackPayload:{},home:{...home,undoId:deleted.id,undoVersion:deleted.version}};
      }
      throw new TaskError('Unknown form.');
    }catch(error){
      const message=error instanceof TaskError?error.message:'Unable to save this task.';
      if(['create','edit','due'].includes(meta.operation)){
        const field=/date/i.test(message)?'due_date':/time|HH:MM/i.test(message)?'due_time':/teammate/i.test(message)?'assignee':'title';
        return {ackPayload:{response_action:'errors',errors:{[meta.operation==='due'&& !['due_date','due_time'].includes(field)?'due_date':field]:message}}};
      }
      return {ackPayload:failedModal(message)};
    }
  }
  if(payload.type!=='block_actions'||payload.view?.type!=='home'||payload.actions?.length!==1)return null;
  const action=payload.actions[0];
  if(!action.action_id?.startsWith('ui_')){
    const home=homeRequest(teamId,allowedChannelId,payload);
    return home?{ackPayload:{},home}:null;
  }
  const name=action.action_id.split(':')[0];
  const state=viewState(payload),home={userId:actorId,...state};
  try{
    if(name==='ui_new')return {ackPayload:{},openModal:{trigger_id:payload.trigger_id,view:modal('create',state)}};
    let row;
    try { row=JSON.parse(name==='ui_status'?action.selected_option?.value:action.value); } catch { throw new TaskError('Refresh Relay and try this task again.'); }
    if(!Number.isSafeInteger(row.id)||!Number.isSafeInteger(row.version))throw new TaskError('Invalid task control. Refresh Relay.');
    const task=store.get(row.id,teamId);
    if(!task||task.channelId!==allowedChannelId||![task.creatorId,task.assigneeId].includes(actorId))throw new TaskError('Choose one of your tasks first.');
    if(name==='ui_status'&&receiptKey&&store.receipt(receiptKey))return {ackPayload:{},home};
    if(row.version!==task.version)throw new TaskError('This task changed. Refresh Relay and try again.');
    if(name==='ui_status'){
      if(!['todo','done'].includes(row.status)||task.deletedAt)throw new TaskError('Choose To do or Done on an active task.');
      if(task.status===row.status)return {ackPayload:{},home};
      store.transition({...context,id:task.id,version:task.version,action:row.status==='done'?'complete':'reopen',receiptKey});
      return {ackPayload:{},home:{...home,notice:row.status==='done'?'Task marked done. Its assigner will receive a completion mention.':'Task reopened.'}};
    }
    if(['ui_edit','ui_due','ui_delete'].includes(name)){
      if(task.creatorId!==actorId||task.deletedAt)throw new TaskError('Only the assigner can edit or delete an active task.');
      return {ackPayload:{},openModal:{trigger_id:payload.trigger_id,view:modal(name==='ui_edit'?'edit':name==='ui_due'?'due':'delete',state,task)}};
    }
    if(name==='ui_restore')store.manage({...context,id:task.id,version:task.version,action:'restore',receiptKey});
    else if(['ui_complete','ui_reopen'].includes(name))store.transition({...context,id:task.id,version:task.version,action:name.slice(3),receiptKey});
    else throw new TaskError('Unknown task action.');
    const notice=name==='ui_complete'?'Task marked done. Its assigner will receive a completion mention.':name==='ui_reopen'?'Task reopened.':'Task restored.';
    return {ackPayload:{},home:{...home,...(name==='ui_restore'?{undoId:null,undoVersion:null}:{}),notice}};
  }catch(error){return {ackPayload:{},home:{...home,notice:error instanceof TaskError?error.message:'Unable to update the task. Try again.'}};}
}
export async function runAppUiEffects(client,store,config,result){
  if(result?.openModal){
    try{await client.call('views.open',result.openModal);}catch(error){
      console.error('Relay could not open a task form:',error.message);
      // No mutation happened. The user can safely click New task or Edit again.
      return;
    }
  }
  if(result?.home)await publishTaskHome(client,store,{teamId:config.teamId,channelId:config.allowedChannelId,...result.home});
}
