import { TaskError, validateTask } from './tasks.js';
import { homeRequest, homeState, viewState, section, publishTaskHome } from './home.js';

const plain = text => ({type:'plain_text',text});
const input = (block_id,label,element,optional=false)=>({type:'input',block_id,label:plain(label),element,...(optional?{optional:true}:{})});
function modal(operation, state, task) {
  const meta={operation,state,...(task?{taskId:task.id,version:task.version}:{})};
  const base={type:'modal',callback_id:'relay_task_form',private_metadata:JSON.stringify(meta),title:plain(operation==='create'?'New task':operation==='edit'?'Edit task':'Delete task'),close:plain('Cancel')};
  if(operation==='delete')return {...base,submit:plain('Move to Trash'),blocks:[section(`Move task #${task.id} “${task.title}” to Trash? It disappears from active lists, and you can restore it from Relay → Home → Trash.`)]};
  return {...base,submit:plain(operation==='create'?'Create task':'Save changes'),blocks:[
    input('title','Task',{type:'plain_text_input',action_id:'value',max_length:240,...(task?{initial_value:task.title}:{})}),
    input('assignee','Assign to',{type:'users_select',action_id:'value',placeholder:plain('Choose a teammate'),...(task?{initial_user:task.assigneeId}:{})}),
    input('due_date','Due date',{type:'datepicker',action_id:'value',placeholder:plain('Choose a date'),...(task?.dueDate?{initial_date:task.dueDate}:{})},true),
    {type:'context',elements:[plain('Tasks are posted only in the channel configured for Relay. The assignee marks work done; the assigner gets a completion mention.')]}
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
    const home={userId:actorId,...state,selectedId:null};
    const key=`modal:${payload.view.id}`;
    try{
      if(!payload.view.id)throw new TaskError('This form has no identity.');
      if(meta.operation==='create'||meta.operation==='edit'){
        const values=payload.view.state?.values??{};
        const changes=validateTask({title:values.title?.value?.value,assigneeId:values.assignee?.value?.selected_user,dueDate:values.due_date?.value?.selected_date});
        if(meta.operation==='create')store.create({...changes,teamId,channelId:allowedChannelId,creatorId:actorId},key);
        else store.manage({...context,id:meta.taskId,version:meta.version,action:'edit',changes,receiptKey:key});
        return {ackPayload:{},home:{...home,notice:meta.operation==='create'?'Task created.':'Changes saved.'}};
      }
      if(meta.operation==='delete'){
        store.manage({...context,id:meta.taskId,version:meta.version,action:'delete',receiptKey:key});
        return {ackPayload:{},home:{...home,notice:'Task moved to Trash. You can restore it there.'}};
      }
      throw new TaskError('Unknown form.');
    }catch(error){
      const message=error instanceof TaskError?error.message:'Unable to save this task.';
      if(['create','edit'].includes(meta.operation)){
        const field=/date/i.test(message)?'due_date':/teammate/i.test(message)?'assignee':'title';
        return {ackPayload:{response_action:'errors',errors:{[field]:message}}};
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
  const state=viewState(payload),home={userId:actorId,...state};
  try{
    if(action.action_id==='ui_new')return {ackPayload:{},openModal:{trigger_id:payload.trigger_id,view:modal('create',state)}};
    const task=store.get(state.selectedId,teamId);
    if(!task||task.channelId!==allowedChannelId||![task.creatorId,task.assigneeId].includes(actorId))throw new TaskError('Choose one of your tasks first.');
    if(state.selectedVersion!==task.version)throw new TaskError('This task changed. Select it again after refreshing.');
    if(['ui_edit','ui_delete'].includes(action.action_id)){
      if(task.creatorId!==actorId||task.deletedAt)throw new TaskError('Only the assigner can edit or delete an active task.');
      return {ackPayload:{},openModal:{trigger_id:payload.trigger_id,view:modal(action.action_id==='ui_edit'?'edit':'delete',state,task)}};
    }
    if(action.action_id==='ui_restore')store.manage({...context,id:task.id,version:task.version,action:'restore',receiptKey});
    else if(['ui_complete','ui_reopen'].includes(action.action_id))store.transition({...context,id:task.id,version:task.version,action:action.action_id.slice(3),receiptKey});
    else throw new TaskError('Unknown task action.');
    const notice=action.action_id==='ui_complete'?'Task marked done. Its assigner will receive a completion mention.':action.action_id==='ui_reopen'?'Task reopened.':'Task restored.';
    return {ackPayload:{},home:{...home,selectedId:null,notice}};
  }catch(error){return {ackPayload:{},home:{...home,selectedId:null,notice:error instanceof TaskError?error.message:'Unable to update the task. Try again.'}};}
}
export async function runAppUiEffects(client,store,config,result){
  if(result?.openModal){
    try{await client.call('views.open',result.openModal);}catch{
      // No mutation happened. The user can safely click New task or Edit again.
      return;
    }
  }
  if(result?.home)await publishTaskHome(client,store,{teamId:config.teamId,channelId:config.allowedChannelId,...result.home});
}
