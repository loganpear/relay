import { labels, TaskError } from './tasks.js';

const text = value => ({ type: 'raw_text', text: String(value) });
const person = userId => ({ type: 'rich_text', elements: [{ type: 'rich_text_section', elements: [{ type: 'user', user_id: userId }] }] });
export const section = value => ({ type: 'section', text: { type: 'plain_text', text: value } });
export const button = (actionId, label, state, extra = {}) => ({ type: 'button', action_id: actionId, text: { type: 'plain_text', text: label }, value: JSON.stringify(state), ...extra });
export function homeState(value = {}) {
  return { mode: ['mine','assigned','trash'].includes(value.mode) ? value.mode : 'mine', filter: ['todo','done','all'].includes(value.filter) ? value.filter : 'todo', page: Number.isSafeInteger(value.page) ? Math.max(0,value.page) : 0, selectedId: Number.isSafeInteger(value.selectedId) ? value.selectedId : null, selectedVersion: Number.isSafeInteger(value.selectedVersion) ? value.selectedVersion : null };
}
export function viewState(payload) {
  try { return homeState(JSON.parse(payload.view?.private_metadata || '{}')); } catch { return homeState(); }
}
export function homeRequest(teamId, allowedChannelId, payload, event = false) {
  if (event) {
    if (!allowedChannelId || payload.team_id !== teamId || payload.event?.type !== 'app_home_opened' || payload.event.tab !== 'home' || !/^[UW][A-Z0-9]+$/.test(payload.event.user ?? '')) return null;
    return { userId: payload.event.user, ...homeState() };
  }
  if (payload.team?.id !== teamId || payload.type !== 'block_actions' || payload.view?.type !== 'home' || !/^[UW][A-Z0-9]+$/.test(payload.user?.id ?? '') || !allowedChannelId || payload.actions?.length !== 1) return null;
  const action = payload.actions[0];
  let state = viewState(payload);
  if (['home_mine','home_assigned','home_trash'].includes(action.action_id)) state = homeState({ mode: action.action_id.slice(5), filter: state.filter });
  else if (action.action_id === 'home_filter') state = homeState({ ...state, filter: action.selected_option?.value, page: 0, selectedId: null });
  else if (action.action_id === 'home_select') state = homeState({ ...state, selectedId: Number(action.selected_option?.value) });
  else if (['home_prev','home_next'].includes(action.action_id)) state = homeState({ ...state, page: state.page + (action.action_id === 'home_next' ? 1 : -1), selectedId: null });
  else if (action.action_id !== 'home_refresh') return null;
  return { userId: payload.user.id, ...state };
}
export function taskHome(store, { teamId, channelId, userId, notice, ...input }) {
  const state = homeState(input);
  const data = store.personalPage({ teamId, channelId, userId, direction: state.mode, page: state.page, othersOnly: state.mode === 'assigned', filter: state.filter });
  state.page = data.page;
  const selected = data.tasks.find(t => t.id === state.selectedId);
  state.selectedId = selected?.id ?? null; state.selectedVersion = selected?.version ?? null;
  const blocks = [
    { type: 'header', text: { type: 'plain_text', text: 'Your tasks, at a glance' } },
    { type: 'actions', elements: [button('ui_new','＋ New task',state,{style:'primary'}),button('home_refresh','Refresh',state)] },
    { type: 'actions', elements: [button('home_mine','Show tasks assigned to me',state,state.mode==='mine'?{style:'primary'}:{}),button('home_assigned','Show tasks I’ve assigned to others',state,state.mode==='assigned'?{style:'primary'}:{}),button('home_trash','Trash',state)] },
    { type: 'context', elements: [{ type: 'mrkdwn', text: `Private to you · Tasks from <#${channelId}> · ${state.mode === 'trash' ? 'Only tasks you created can be restored here.' : 'Choose a task below to manage it.'}` }] }
  ];
  if (notice) blocks.push(section(notice));
  if (state.mode !== 'trash') blocks.push({ type:'actions',elements:[{type:'static_select',action_id:'home_filter',placeholder:{type:'plain_text',text:'Filter tasks'},initial_option:{text:{type:'plain_text',text:state.filter==='todo'?'To do':state.filter==='done'?'Done':'All'},value:state.filter},options:['todo','done','all'].map(value=>({text:{type:'plain_text',text:value==='todo'?'To do':value==='done'?'Done':'All'},value}))}] });
  blocks.push({type:'divider'}, {type:'header',text:{type:'plain_text',text:`${state.mode==='mine'?'Tasks assigned to you':state.mode==='assigned'?'Tasks you assigned to others':'Your Trash'} · ${data.total}`}});
  if (!data.tasks.length) blocks.push(section(state.mode==='trash'?'Your Trash is empty.':`No ${state.filter==='all'?'':state.filter==='todo'?'unfinished ':'completed '}tasks in this view. Create a task or change the filter.`));
  else {
    blocks.push({type:'table',column_settings:[{is_wrapped:true},{is_wrapped:true},{is_wrapped:false},{is_wrapped:false}],rows:[
      [text('Task'),text(state.mode==='mine'?'Assigned by':'Assigned to'),text('Status'),text('Due')],
      ...data.tasks.map(task=>[text(`#${task.id} ${task.title.length>160?task.title.slice(0,159)+'…':task.title}`),person(state.mode==='mine'?task.creatorId:task.assigneeId),text(labels[task.status]),text(task.dueDate?(task.dueDate<new Date().toISOString().slice(0,10)&&task.status==='todo'?'Overdue · ':'')+task.dueDate:'—')])
    ]});
    const options=data.tasks.map(task=>({text:{type:'plain_text',text:`#${task.id} ${task.title.slice(0,65)} · ${labels[task.status]}`},value:String(task.id)}));
    blocks.push({type:'actions',elements:[{type:'static_select',action_id:'home_select',placeholder:{type:'plain_text',text:'Choose a task to manage'},options,...(selected?{initial_option:options.find(o=>o.value===String(selected.id))}:{})}]});
    if(selected){
      const actions=[];
      if(selected.deletedAt){if(selected.creatorId===userId)actions.push(button('ui_restore','Restore task',state,{style:'primary'}));}
      else {
        if(selected.creatorId===userId)actions.push(button('ui_edit','Edit task',state));
        if(selected.status==='todo'&&selected.assigneeId===userId)actions.push(button('ui_complete','Mark done',state,{style:'primary'}));
        if(selected.status==='done'&&[selected.assigneeId,selected.creatorId].includes(userId))actions.push(button('ui_reopen','Reopen task',state));
        if(selected.creatorId===userId)actions.push(button('ui_delete','Delete task',state,{style:'danger'}));
      }
      if(actions.length)blocks.push({type:'actions',elements:actions});
    }
    blocks.push({type:'context',elements:[{type:'plain_text',text:`Showing ${data.page*data.size+1}–${data.page*data.size+data.tasks.length} of ${data.total}`} ]});
    const navigation=[];
    if(data.page>0)navigation.push(button('home_prev','Previous',state));
    if(data.page<data.lastPage)navigation.push(button('home_next','Next',state));
    if(navigation.length)blocks.push({type:'actions',elements:navigation});
  }
  return {type:'home',callback_id:'relay_task_home',private_metadata:JSON.stringify(state),blocks};
}
export async function publishTaskHome(client,store,{teamId,channelId,...request}){
  return client.call('views.publish',{user_id:request.userId,view:taskHome(store,{teamId,channelId,...request})});
}
