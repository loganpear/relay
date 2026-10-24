import { labels } from './tasks.js';

export const section = value => ({ type: 'section', text: { type: 'plain_text', text: value } });
export const button = (actionId, label, value, extra = {}) => ({ type: 'button', action_id: actionId, text: { type: 'plain_text', text: label }, value: JSON.stringify(value), ...extra });
export function homeState(value = {}) {
  const state = {};
  for (const mode of ['mine','assigned']) {
    state[`${mode}Expanded`] = value[`${mode}Expanded`] === true;
    state[`${mode}Page`] = state[`${mode}Expanded`] && Number.isSafeInteger(value[`${mode}Page`]) ? Math.max(0,value[`${mode}Page`]) : 0;
  }
  state.undoId = Number.isSafeInteger(value.undoId) ? value.undoId : null;
  state.undoVersion = Number.isSafeInteger(value.undoVersion) ? value.undoVersion : null;
  return state;
}
export function viewState(payload) {
  try { return homeState(JSON.parse(payload.view?.private_metadata || '{}')); } catch { return homeState(); }
}
export function homeRequest(teamId, allowedChannelId, payload, event = false) {
  if (event) {
    if (!allowedChannelId || payload.team_id !== teamId || payload.event?.type !== 'app_home_opened' || !['home','messages'].includes(payload.event.tab) || !/^[UW][A-Z0-9]+$/.test(payload.event.user ?? '')) return null;
    return { userId: payload.event.user, ...homeState() };
  }
  if (payload.team?.id !== teamId || payload.type !== 'block_actions' || payload.view?.type !== 'home' || !/^[UW][A-Z0-9]+$/.test(payload.user?.id ?? '') || !allowedChannelId || payload.actions?.length !== 1) return null;
  const action = payload.actions[0];
  const state = viewState(payload);
  const match = /^home_(expand|collapse|prev|next)_(mine|assigned)$/.exec(action.action_id);
  if (match) {
    const [,operation,mode] = match;
    if (operation === 'expand' || operation === 'collapse') { state[`${mode}Expanded`] = operation === 'expand'; state[`${mode}Page`] = 0; }
    else state[`${mode}Page`] = Math.max(0,state[`${mode}Page`] + (operation === 'next' ? 1 : -1));
  } else if (action.action_id !== 'home_refresh') return null;
  return { userId: payload.user.id, ...homeState(state) };
}
export function taskHome(store, { teamId, channelId, userId, notice, ...input }) {
  const state = homeState(input);
  const blocks = [];
  for (const mode of ['mine','assigned']) {
    const expanded = state[`${mode}Expanded`];
    const data = store.personalPage({teamId,channelId,userId,direction:mode,othersOnly:mode==='assigned',size:expanded?20:5,page:state[`${mode}Page`],recentFirst:true});
    state[`${mode}Page`] = data.page;
    const title = mode === 'mine' ? 'Assigned to you' : 'Assigned by you';
    if (!data.tasks.length) blocks.push({type:'header',text:{type:'plain_text',text:`${title} · 0`}},section(mode==='mine'?'No tasks assigned to you yet.':'No tasks assigned to others yet.'));
    else {
      blocks.push({type:'header',text:{type:'plain_text',text:`${title} · ${data.total}`}});
      for (const task of data.tasks) {
        const canChange = task.assigneeId === userId || task.status === 'done';
        const due = task.dueDate ? (task.dueDate<new Date().toISOString().slice(0,10)&&task.status==='todo'?'Overdue · ':'')+task.dueDate : 'No deadline';
        const options=['todo','done'].map(status=>({text:{type:'plain_text',text:labels[status]},value:JSON.stringify({id:task.id,version:task.version,status})}));
        blocks.push({type:'section',block_id:`task:${mode}:${task.id}:${task.version}`,text:{type:'plain_text',text:task.title},fields:[
          {type:'mrkdwn',text:`${mode==='mine'?'From':'To'} <@${mode==='mine'?task.creatorId:task.assigneeId}>`},
          {type:'plain_text',text:`Due: ${due}${canChange?'':' · '+labels[task.status]}`}
        ]});
        const controls=[];
        if(canChange)controls.push({type:'static_select',action_id:`ui_status:${mode}:${task.id}`,placeholder:{type:'plain_text',text:'Status'},initial_option:options.find(o=>JSON.parse(o.value).status===task.status),options});
        if(task.creatorId===userId)controls.push(button(`ui_edit:${mode}:${task.id}`,'Edit',{id:task.id,version:task.version}),button(`ui_delete:${mode}:${task.id}`,'Delete',{id:task.id,version:task.version}));
        if(controls.length)blocks.push({type:'actions',block_id:`controls:task:${mode}:${task.id}:${task.version}`,elements:controls});
      }
      const navigation=[];
      if (expanded) {
        if(data.page>0)navigation.push(button(`home_prev_${mode}`,'Previous',{}));
        if(data.page<data.lastPage)navigation.push(button(`home_next_${mode}`,'Next',{}));
        navigation.push(button(`home_collapse_${mode}`,'Show fewer',{}));
      } else if (data.total>5) navigation.push(button(`home_expand_${mode}`,`Show more (${data.total})`,{}));
      if(navigation.length)blocks.push({type:'actions',elements:navigation});
      if(data.total>5)blocks.push({type:'context',elements:[{type:'plain_text',text:`${data.page*data.size+1}–${data.page*data.size+data.tasks.length} of ${data.total} · Newest first`} ]});
    }
    blocks.push({type:'divider'});
  }
  const deleted = state.undoId ? store.get(state.undoId,teamId) : null;
  if(deleted?.channelId===channelId && deleted.creatorId===userId && deleted.deletedAt && deleted.version===state.undoVersion) {
    blocks.push({type:'section',text:{type:'plain_text',text:'Task deleted.'},accessory:button('ui_restore','Undo delete',{id:deleted.id,version:deleted.version})});
  } else { state.undoId=null; state.undoVersion=null; if(notice)blocks.push(section(notice)); }
  blocks.push({type:'context',elements:[{type:'mrkdwn',text:`Private to you · <#${channelId}> · Choose To do / Done directly from a task’s dropdown. Only assignees can mark done.`}]},
    {type:'actions',elements:[button('ui_new','＋ New task',{}, {style:'primary'}),button('home_refresh','Refresh',{})]});
  return {type:'home',callback_id:'relay_task_home',private_metadata:JSON.stringify(state),blocks};
}
export async function publishTaskHome(client,store,{teamId,channelId,...request}){
  return client.call('views.publish',{user_id:request.userId,view:taskHome(store,{teamId,channelId,...request})});
}
