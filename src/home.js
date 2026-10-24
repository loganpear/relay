import { formatDue, dueTimezoneLabel } from './tasks.js';

const text = value => ({ type: 'raw_text', text: String(value) });
const person = userId => ({ type: 'rich_text', elements: [{ type: 'rich_text_section', elements: [{ type: 'user', user_id: userId }] }] });
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
const cellAction = (action, label, mode, task) => ({ type:'action_cell',element:button(`${action}:${mode}:${task.id}`,label,{id:task.id,version:task.version}),fallback:text(label) });
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
      const showManagement = mode === 'assigned' || data.tasks.some(t=>t.creatorId===userId);
      const headers = ['Task',mode==='mine'?'From':'To','Due','Status',...(showManagement?['Delete']:[])];
      blocks.push({type:'data_table',caption:`${title} · ${data.total}`,page_size:expanded?20:5,rows:[headers.map(text),...data.tasks.map(task=>{
        const canToggle = task.assigneeId === userId;
        const due = formatDue(task,{markOverdue:true});
        return [task.creatorId===userId ? cellAction('ui_edit',task.title.length>75?task.title.slice(0,72)+'…':task.title,mode,task) : text(task.title),person(mode==='mine'?task.creatorId:task.assigneeId),text(due),
          canToggle ? cellAction(task.status==='todo'?'ui_complete':'ui_reopen',task.status==='todo'?'⬜ To do':'✅ Done',mode,task) : text(task.status==='done'?'✅ Done':'⬜ To do'),
          ...(showManagement ? task.creatorId===userId ? [cellAction('ui_delete','Delete',mode,task)] : [text('—')] : [])];
      })]});
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
  blocks.push({type:'context',elements:[{type:'mrkdwn',text:`Private to you · <#${channelId}> · ${dueTimezoneLabel} · Click task directions to edit, or a status to toggle it. Only assignees can change status.`}]},
    {type:'actions',elements:[button('ui_new','＋ New task',{}, {style:'primary'}),button('home_refresh','Refresh',{})]});
  return {type:'home',callback_id:'relay_task_home',private_metadata:JSON.stringify(state),blocks};
}
export async function publishTaskHome(client,store,{teamId,channelId,...request}){
  return client.call('views.publish',{user_id:request.userId,view:taskHome(store,{teamId,channelId,...request})});
}
