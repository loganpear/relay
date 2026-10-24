import { TaskError, validateTask, dueTimezone, dueTimezoneLabel, taskImages, validateDetails, formatDue, isTaskArchived } from './tasks.js';
import { homeRequest, homeState, viewState, section, button, publishTaskHome } from './home.js';

const plain = text => ({type:'plain_text',text});
const input = (block_id,label,element,optional=false)=>({type:'input',block_id,label:plain(label),element,...(optional?{optional:true}:{})});
const uploadsEnabled = () => process.env.SLACK_IMAGE_UPLOADS === 'true';
const imageBlocks = task => taskImages(task).map((id,index)=>({type:'image',slack_file:{id},alt_text:`Task image ${index+1}`}));
export function taskDetails(task,actorId,state={},source='assigned') {
  const blocks=[section(task.title),{type:'section',fields:[
    {type:'mrkdwn',text:`*Assigned to*\n<@${task.assigneeId}>`},
    {type:'mrkdwn',text:`*Assigned by*\n<@${task.creatorId}>`},
    {type:'plain_text',text:`Status: ${task.status==='done'?'✅ Done':'🔲 To do'}`},
    {type:'plain_text',text:`Archived: ${isTaskArchived(task)?'Archived':'Active'}`},
    {type:'plain_text',text:`Due: ${formatDue(task)} (${dueTimezoneLabel})`}
  ]},{type:'divider'}];
  const details=task.details||'No additional details yet.';
  for(let i=0;i<details.length;i+=3000)blocks.push(section(details.slice(i,i+3000)));
  blocks.push(...imageBlocks(task));
  if(source==='assigned'&&actorId===task.creatorId&&!task.deletedAt)blocks.push({type:'actions',elements:[button('ui_edit_details','Edit',{id:task.id,version:task.version})]});
  return {type:'modal',callback_id:'relay_task_details',title:plain('Task details'),close:plain('Close'),private_metadata:JSON.stringify({state:homeState(state),source}),blocks};
}
function attachmentInputs(task) {
  const images=taskImages(task);
  return [input('details','Details',{type:'plain_text_input',action_id:'value',multiline:true,max_length:3000,placeholder:plain('Requirements, notes, or steps to complete this task'),...(task?.details?{initial_value:task.details}:{})},true),
    ...(images.length?[input('keep_images','Attached images',{type:'checkboxes',action_id:'value',options:images.map((id,i)=>({text:plain(`Keep image ${i+1}`),value:id})),initial_options:images.map((id,i)=>({text:plain(`Keep image ${i+1}`),value:id}))},true),...imageBlocks(task)]:[]),
    ...(uploadsEnabled()&&images.length<5?[input('images','Add images',{type:'file_input',action_id:'value',filetypes:['png','jpg','jpeg','gif'],max_files:5-images.length},true)]:[])
  ];
}
function modal(operation, state, task) {
  const meta={operation,state,...(task?{taskId:task.id,version:task.version}:{})};
  const base={type:'modal',callback_id:'relay_task_form',private_metadata:JSON.stringify(meta),title:plain(operation==='create'?'New task':operation==='edit'?'Edit task':operation==='due'?'Edit due date':'Archive task'),close:plain('Cancel')};
  if(['archive','delete'].includes(operation))return {...base,submit:plain('Archive task'),blocks:[section(`Archive “${task.title}”? ${task.status==='todo'?'Work will no longer be required, and the task will move to Past for both people.':'It will move to your Past list.'} You can move it to Current again later.`)]};
  return {...base,submit:plain(operation==='create'?'Create task':'Save changes'),blocks:[
    ...(operation==='due'?[section(task.title)]:[input('title','Task',{type:'plain_text_input',action_id:'value',max_length:240,...(task?{initial_value:task.title}:{})}),
    input('assignee','Assign to',{type:'users_select',action_id:'value',placeholder:plain('Choose a teammate'),...(task?{initial_user:task.assigneeId}:{})})]),
    input('due_date','Due date',{type:'datepicker',action_id:'value',placeholder:plain('Choose a date'),...(task?.dueDate?{initial_date:task.dueDate}:{})},true),
    input('due_time','Due time',{type:'timepicker',action_id:'value',timezone:dueTimezone,placeholder:plain('Choose a time'),...(task?.dueTime?{initial_time:task.dueTime}:{})},true),
    ...(operation!=='due'?attachmentInputs(task):[]),
    {type:'context',elements:[plain('Times use '+dueTimezoneLabel+'. Tasks are posted only in the channel configured for Relay. The assignee marks work done; the assigner gets a completion mention.')]}
  ]};
}
function choiceModal(operation,state,task) {
  const status=operation==='status';
  const options=(status?[['todo','🔲 To do'],['done','✅ Done']]:[['active','Active'],['archived','Archived']]).map(([value,label])=>({text:plain(label),value}));
  const current=status?task.status:isTaskArchived(task)?'archived':'active';
  return {type:'modal',callback_id:'relay_task_form',private_metadata:JSON.stringify({operation,state,taskId:task.id,version:task.version}),title:plain(status?'Change status':'Change archive state'),close:plain('Cancel'),submit:plain('Save'),blocks:[section(task.title),input('choice',status?'Status':'Archive',{type:'static_select',action_id:'value',options,initial_option:options.find(option=>option.value===current)}),
    ...(!status?[{type:'context',elements:[plain(task.status==='todo'?'Archiving stops this task for both people. Reactivating makes it current again.':'Archiving moves this task to your Past list. Reactivating keeps it current for seven days.')]}]:[])]};
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
    const key=`modal:${payload.view.id}:${meta.operation}:${meta.version??"new"}`;
    try{
      if(!payload.view.id)throw new TaskError('This form has no identity.');
      if(['status','archive_state'].includes(meta.operation)){
        const task=store.get(meta.taskId,teamId),choice=payload.view.state?.values?.choice?.value?.selected_option?.value;
        if(!task||task.channelId!==allowedChannelId)throw new TaskError('Choose one of your tasks first.');
        if(meta.operation==='status'&&task.assigneeId!==actorId)throw new TaskError('Only the assignee can change status.');
        if(meta.operation==='archive_state'&&task.creatorId!==actorId)throw new TaskError('Only the assigner can archive a task.');
        if(store.receipt(key))return {ackPayload:{},home};
        if(task.version!==meta.version)throw new TaskError('This task changed. Close this window and refresh Relay.');
        if(meta.operation==='status'){
          if(state.period==='past')throw new TaskError('Move this task to Current before changing its status.');
          if(!['todo','done'].includes(choice)||task.deletedAt||(task.status==='todo'&&task.archivedAt))throw new TaskError('Choose To do or Done on an active task.');
          if(choice===task.status)return {ackPayload:{},home};
          store.transition({...context,id:task.id,version:meta.version,action:choice==='done'?'complete':'reopen',receiptKey:key});
          return {ackPayload:{},home:{...home,...(choice==='done'?{completionTitle:task.title}:{}),notice:choice==='done'?'Task marked done and moved to Past.':'Task reopened.'}};
        }
        if(!['active','archived'].includes(choice))throw new TaskError('Choose Active or Archived.');
        if((choice==='archived')===isTaskArchived(task))return {ackPayload:{},home};
        store.manage({...context,id:task.id,version:meta.version,action:choice==='archived'?'archive':'unarchive',receiptKey:key});
        return {ackPayload:{},home:{...home,notice:choice==='archived'?(task.status==='todo'?'Task archived for both people. Work is no longer required.':'Task moved to Past for you.'):(task.status==='todo'?'Task reactivated in Current for both people.':'Task moved to Current for you for seven days.')}};
      }
      if(['create','edit','due'].includes(meta.operation)){
        const values=payload.view.state?.values??{};
        const task=meta.operation==='due'?store.get(meta.taskId,teamId):null;
        const changes=validateTask({title:meta.operation==='due'?task?.title:values.title?.value?.value,assigneeId:meta.operation==='due'?task?.assigneeId:values.assignee?.value?.selected_user,dueDate:values.due_date?.value?.selected_date,dueTime:values.due_time?.value?.selected_time});
        if(['create','edit'].includes(meta.operation)&&values.details) {
          const current=meta.operation==='edit'?store.get(meta.taskId,teamId):null,existing=taskImages(current||{});
          const kept=(values.keep_images?.value?.selected_options??[]).map(option=>option.value);
          if(kept.some(id=>!existing.includes(id)))throw new TaskError('Refresh this task before editing images.');
          const files=values.images?.value?.files??[];
          if(files.length&&!uploadsEnabled())throw new TaskError('Image uploads are not enabled.');
          if(files.some(file=>!['image/png','image/jpeg','image/gif'].includes(file.mimetype)))throw new TaskError('Attach PNG, JPG, or GIF images only.');
          Object.assign(changes,validateDetails(values.details.value?.value||'', [...kept,...files.map(file=>file.id)]));
        }
        if(meta.operation==='create')store.create({...changes,teamId,channelId:allowedChannelId,creatorId:actorId},key);
        else store.manage({...context,id:meta.taskId,version:meta.version,action:'edit',changes,receiptKey:key});
        const saved=meta.operation==='edit'?store.get(meta.taskId,teamId):null;
        return {ackPayload:meta.returnToDetails&&saved?{response_action:'update',view:taskDetails(saved,actorId,state)}:{},home:{...home,notice:meta.operation==='create'?'Task created.':'Changes saved.'}};
      }
      if(['archive','delete'].includes(meta.operation)){
        store.manage({...context,id:meta.taskId,version:meta.version,action:'archive',receiptKey:key});
        return {ackPayload:{},home:{...home,notice:'Task archived. You can find it in Past.'}};
      }
      throw new TaskError('Unknown form.');
    }catch(error){
      const message=error instanceof TaskError?error.message:'Unable to save this task.';
      if(['status','archive_state'].includes(meta.operation))return {ackPayload:{response_action:'errors',errors:{choice:message}}};
      if(['create','edit','due'].includes(meta.operation)){
        const field=/^Keep task details/i.test(message)&&meta.operation!=='due'?'details':/images|PNG|JPG|GIF/i.test(message)?'images':/date/i.test(message)?'due_date':/time|HH:MM/i.test(message)?'due_time':/teammate/i.test(message)?'assignee':'title';
        return {ackPayload:{response_action:'errors',errors:{[meta.operation==='due'&& !['due_date','due_time'].includes(field)?'due_date':field]:message}}};
      }
      return {ackPayload:failedModal(message)};
    }
  }
  if(payload.type!=='block_actions'||!['home','modal'].includes(payload.view?.type)||payload.actions?.length!==1)return null;
  if(payload.view.type==='modal') {
    if(payload.view.callback_id!=='relay_task_details'||!['ui_edit_details','ui_delete_details'].includes(payload.actions[0].action_id))return null;
    try {
      const origin=JSON.parse(payload.view.private_metadata||'{}');
      if(origin.source!=='assigned')throw new TaskError('Edit tasks from Assigned by you.');
      const row=JSON.parse(payload.actions[0].value),task=store.get(row.id,teamId);
      if(!task||task.channelId!==allowedChannelId||task.creatorId!==actorId||task.deletedAt||task.version!==row.version)throw new TaskError('This task changed. Close and reopen it before editing.');
      const state=homeState(JSON.parse(payload.view.private_metadata||'{}').state);
      const operation=payload.actions[0].action_id==='ui_delete_details'?'archive':'edit';
      const view=modal(operation,state,task),meta=JSON.parse(view.private_metadata);meta.returnToDetails=true;view.private_metadata=JSON.stringify(meta);
      return {ackPayload:{},updateModal:{view_id:payload.view.id,hash:payload.view.hash,view}};
    } catch {return {ackPayload:{},updateModal:{view_id:payload.view.id,hash:payload.view.hash,view:failedModal('This task changed.').view}};}
  }
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
    if(name==='ui_details')return {ackPayload:{},openModal:{trigger_id:payload.trigger_id,view:taskDetails(task,actorId,state,action.action_id.split(':')[1]||'assigned')}};
    if(row.version!==task.version)throw new TaskError('This task changed. Refresh Relay and try again.');
    if(state.period==='past'&&['ui_choose_status','ui_status','ui_complete','ui_reopen'].includes(name))throw new TaskError('Move this task to Current before changing its status.');
    if(['ui_choose_status','ui_choose_archive'].includes(name)){
      const source=action.action_id.split(':')[1];
      if(name==='ui_choose_status'&&(source!=='mine'||task.assigneeId!==actorId||task.deletedAt||(task.status==='todo'&&task.archivedAt)))throw new TaskError('Only the assignee can change status on an active task.');
      if(name==='ui_choose_archive'&&(source!=='assigned'||task.creatorId!==actorId||task.deletedAt))throw new TaskError('Only the assigner can archive a task.');
      return {ackPayload:{},openModal:{trigger_id:payload.trigger_id,view:choiceModal(name==='ui_choose_status'?'status':'archive_state',state,task)}};
    }
    if(name==='ui_status'){
      if(!['todo','done'].includes(row.status)||task.deletedAt)throw new TaskError('Choose To do or Done on an active task.');
      if(task.status===row.status)return {ackPayload:{},home};
      store.transition({...context,id:task.id,version:task.version,action:row.status==='done'?'complete':'reopen',receiptKey});
      return {ackPayload:{},home:{...home,...(row.status==='done'?{completionTitle:task.title}:{}),notice:row.status==='done'?'Task marked done and moved to Past.':'Task reopened.'}};
    }
    if(['ui_edit','ui_due','ui_delete'].includes(name)){
      if(action.action_id.split(':')[1]==='mine'||task.creatorId!==actorId||task.deletedAt)throw new TaskError('Only the assigner can edit or archive a task.');
      return {ackPayload:{},openModal:{trigger_id:payload.trigger_id,view:modal(name==='ui_edit'?'edit':name==='ui_due'?'due':'archive',state,task)}};
    }
    if(['ui_archive','ui_unarchive'].includes(name))store.manage({...context,id:task.id,version:task.version,action:name.slice(3),receiptKey});
    else if(name==='ui_restore')store.manage({...context,id:task.id,version:task.version,action:'unarchive',receiptKey});
    else if(['ui_complete','ui_reopen'].includes(name))store.transition({...context,id:task.id,version:task.version,action:name.slice(3),receiptKey});
    else throw new TaskError('Unknown task action.');
    const notice=name==='ui_archive'?(task.status==='todo'?'Task archived for both people. Work is no longer required.':'Task moved to Past for you.'):name==='ui_unarchive'?(task.status==='todo'?'Task reactivated in Current for both people.':'Task moved to Current for you for seven days.'):name==='ui_complete'?'Task marked done. Its assigner will receive a completion mention.':name==='ui_reopen'?'Task reopened.':'Task moved to Current.';
    return {ackPayload:{},home:{...home,...(name==='ui_complete'?{completionTitle:task.title}:{}),notice}};
  }catch(error){return {ackPayload:{},home:{...home,notice:error instanceof TaskError?error.message:'Unable to update the task. Try again.'}};}
}
export async function runAppUiEffects(client,store,config,result){
  if(result?.updateModal){
    try{await client.call('views.update',result.updateModal);}catch(error){console.error('Relay could not update a task form:',error.message);return;}
  }
  if(result?.openModal){
    try{await client.call('views.open',result.openModal);}catch(error){
      console.error('Relay could not open a task form:',error.message);
      // No mutation happened. The user can safely click New task or Edit again.
      return;
    }
  }
  if(result?.home)await publishTaskHome(client,store,{teamId:config.teamId,channelId:config.allowedChannelId,...result.home});
}
