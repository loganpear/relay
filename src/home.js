import { formatDue, isTaskArchived, zoneLabel } from './task-store.js';
import { learnTimeZone } from './slack.js';

// Created times are shown in the viewer's own time zone.
const createdCell = (value, timeZone) => {
  const timestamp=Date.parse(value);
  return Number.isFinite(timestamp)?{type:'raw_number',value:timestamp,text:new Intl.DateTimeFormat('en-US',{timeZone,year:'numeric',month:'2-digit',day:'2-digit',hour:'numeric',minute:'2-digit',hour12:true}).format(new Date(timestamp)).replace(',','')}:text('—');
};
const text = value => ({ type: 'raw_text', text: String(value) });
const person = userId => ({ type: 'rich_text', elements: [{ type: 'rich_text_section', elements: [{ type: 'user', user_id: userId }] }] });
export const section = value => ({ type: 'section', text: { type: 'plain_text', text: value } });
export const button = (actionId, label, value, extra = {}) => ({ type: 'button', action_id: actionId, text: { type: 'plain_text', text: label }, value: JSON.stringify(value), ...extra });
export function homeState(value = {}) {
  const state = {period:value.period==='past'?'past':'current'};
  for (const mode of ['mine','assigned']) {
    state[`${mode}Expanded`] = value[`${mode}Expanded`] === true;
    state[`${mode}Page`] = state[`${mode}Expanded`] && Number.isSafeInteger(value[`${mode}Page`]) ? Math.max(0,value[`${mode}Page`]) : 0;
  }
  return state;
}
export function viewState(payload) {
  try { return homeState(JSON.parse(payload.view?.private_metadata || '{}')); } catch { return homeState(); }
}
export function homeRequest(teamId, payload, event = false) {
  if (event) {
    if (payload.team_id !== teamId || payload.event?.type !== 'app_home_opened' || !['home','messages'].includes(payload.event.tab) || !/^[UW][A-Z0-9]+$/.test(payload.event.user ?? '')) return null;
    return { userId: payload.event.user, ...homeState() };
  }
  if (payload.team?.id !== teamId || payload.type !== 'block_actions' || payload.view?.type !== 'home' || !/^[UW][A-Z0-9]+$/.test(payload.user?.id ?? '') || payload.actions?.length !== 1) return null;
  const action = payload.actions[0];
  const state = viewState(payload);
  const match = /^home_(expand|collapse|prev|next)_(mine|assigned)$/.exec(action.action_id);
  if (match) {
    const [,operation,mode] = match;
    if (operation === 'expand' || operation === 'collapse') { state[`${mode}Expanded`] = operation === 'expand'; state[`${mode}Page`] = 0; }
    else state[`${mode}Page`] = Math.max(0,state[`${mode}Page`] + (operation === 'next' ? 1 : -1));
  } else if (['home_current','home_past','home_view_past'].includes(action.action_id)) {
    state.period=action.action_id==='home_current'?'current':'past';
    for(const mode of ['mine','assigned']){state[`${mode}Expanded`]=false;state[`${mode}Page`]=0;}
  } else if (action.action_id !== 'home_refresh') return null;
  return { userId: payload.user.id, ...homeState(state) };
}
// Fits Slack's 75-character button limit, cutting only between whole characters so an emoji is never split.
const graphemes = new Intl.Segmenter();
export function shorten(value) {
  if (value.length <= 75) return value;
  let result = '';
  for (const { segment } of graphemes.segment(value)) { if (result.length + segment.length > 72) break; result += segment; }
  return result + '…';
}
const cellAction = (action, label, mode, task) => ({ type:'action_cell',element:button(`${action}:${mode}:${task.id}`,label,{id:task.id,version:task.version}),fallback:text(label) });
export function taskHome(store, { teamId, userId, notice, completionTitle, ...input }) {
  const state = homeState(input), timeZone = store.timeZoneOf(userId);
  const blocks = [{type:'actions',elements:[button('home_current','Current',{},state.period==='current'?{style:'primary'}:{}),button('home_past','Past',{},state.period==='past'?{style:'primary'}:{})]}];
  if(completionTitle)blocks.push({type:'section',text:{type:'plain_text',text:`✅ “${completionTitle}” marked Done and moved to Past. The assigner will receive a completion notification.`},accessory:button('home_view_past','View Past',{})});
  for (const mode of ['mine','assigned']) {
    const expanded = state[`${mode}Expanded`];
    const data = store.personalPage({teamId,userId,direction:mode,period:state.period,size:expanded?20:5,page:state[`${mode}Page`],recentFirst:true});
    state[`${mode}Page`] = data.page;
    const title = mode === 'mine' ? 'Assigned to you' : 'Assigned by you';
    const showManagement = mode === 'assigned';
    const headers = ['Task',mode==='mine'?'From':'To','Due','Status',...(showManagement?['Archive']:[]),...(state.period==='past'?['Created at']:[])];
    if (!data.tasks.length) blocks.push({type:'data_table',caption:`${title} · 0`,page_size:5,rows:[headers.map(text),headers.map((_,index)=>text(index===0?'No records':'\u00a0'))]});
    else {
      blocks.push({type:'data_table',caption:`${title} · ${data.total}`,page_size:expanded?20:5,rows:[headers.map(text),...data.tasks.map(task=>{
        const canToggle = state.period === 'current' && mode === 'mine' && task.assigneeId === userId && !task.deletedAt && !(task.status==='todo'&&task.archivedAt);
        // The assigner can mark active work Done or send Done work back, so their status cell is editable too.
        const canManageStatus = state.period === 'current' && mode === 'assigned' && task.creatorId === userId && !task.deletedAt && !isTaskArchived(task);
        const due = formatDue(task,{markOverdue:true,timeZone});
        const taskLabel = `#${task.id} · ${task.title}`;
        return [cellAction('ui_details',shorten(taskLabel),mode,task),person(mode==='mine'?task.creatorId:task.assigneeId),showManagement && state.period==='current' && !task.deletedAt ? cellAction('ui_due',task.dueDate?due:'Set due date',mode,task) : text(due),
          canToggle || canManageStatus ? cellAction('ui_choose_status',task.status==='todo'?'▾ 🔲 To do':'▾ ✅ Done',mode,task) : text(task.status==='done'?'✅ Done':'🔲 To do'),
          ...(showManagement ? [cellAction('ui_choose_archive',isTaskArchived(task)?'▾ Archived':'▾ Active',mode,task)] : []),
          ...(state.period==='past'?[createdCell(task.createdAt,timeZone)]:[])];
      })]});
      // Show more counts the hidden tasks; the line below the table gives the total.
      const navigation=[];
      if (expanded) {
        if(data.page>0)navigation.push(button(`home_prev_${mode}`,'Previous',{}));
        if(data.page<data.lastPage)navigation.push(button(`home_next_${mode}`,'Next',{}));
        navigation.push(button(`home_collapse_${mode}`,'Show fewer',{}));
      } else if (data.total>5) navigation.push(button(`home_expand_${mode}`,`Show ${data.total-data.tasks.length} more`,{}));
      if(navigation.length)blocks.push({type:'actions',elements:navigation});
      if(data.total>5)blocks.push({type:'context',elements:[{type:'plain_text',text:`${data.page*data.size+1}–${data.page*data.size+data.tasks.length} of ${data.total} · Newest first`} ]});
    }
    blocks.push({type:'divider'});
  }
  if(notice&&!completionTitle)blocks.push(section(notice));
  blocks.push({type:'context',elements:[{type:'mrkdwn',text:`Private to you · Times in ${zoneLabel(timeZone)} · Click a task name for details, a due date in Assigned by you to change it, or an editable Status or Archive cell to choose a value. Assignees and assigners can mark tasks done; only assigners can send Done tasks back to To do. Done stays Current for the assigner for seven days. Archiving To do stops the task for both people.`}]},
    {type:'actions',elements:[button('ui_new','＋ New task',{}, {style:'primary'}),button('home_refresh','Refresh',{}),
      // Shows the current setting; clicking flips it.
      button('ui_reminders',store.remindersOn(userId)?'🔔 Reminders: on':'🔕 Reminders: off',{on:!store.remindersOn(userId)})]});
  return {type:'home',callback_id:'relay_task_home',private_metadata:JSON.stringify(state),blocks};
}
export async function publishTaskHome(client,store,{teamId,...request}){
  // This publish is current, so remember the person's place and drop any pending refresh for them.
  store.homeViews.set(request.userId,homeState(request));
  store.staleHomes.delete(request.userId);
  await learnTimeZone(store,client,request.userId);
  return client.call('views.publish',{user_id:request.userId,view:taskHome(store,{teamId,...request})});
}
// Republishes Home for people whose tasks changed elsewhere, keeping their view. Only people who opened Home since startup.
export async function refreshStaleHomes(client,store){
  for(const [userId,teamId] of store.staleHomes){
    store.staleHomes.delete(userId);
    if(store.homeViews.has(userId))await publishTaskHome(client,store,{teamId,userId,...store.homeViews.get(userId)}).catch(()=>{});
  }
}
