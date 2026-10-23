import { labels, TaskError } from './tasks.js';

const text = value => ({ type: 'raw_text', text: String(value) });
const person = userId => ({ type: 'rich_text', elements: [{ type: 'rich_text_section', elements: [{ type: 'user', user_id: userId }] }] });
const section = value => ({ type: 'section', text: { type: 'plain_text', text: value } });
const button = (actionId, label, state) => ({ type: 'button', action_id: actionId, text: { type: 'plain_text', text: label }, value: JSON.stringify(state) });

export function homeRequest(teamId, allowedChannelId, payload, event = false) {
  if (event) {
    if (!allowedChannelId || payload.team_id !== teamId || payload.event?.type !== 'app_home_opened' || payload.event.tab !== 'home' || !/^[UW][A-Z0-9]+$/.test(payload.event.user ?? '')) return null;
    return { userId: payload.event.user, mode: 'mine', page: 0 };
  }
  if (payload.team?.id !== teamId || payload.type !== 'block_actions' || payload.view?.type !== 'home' || !/^[UW][A-Z0-9]+$/.test(payload.user?.id ?? '') || !allowedChannelId || payload.actions?.length !== 1) return null;
  const action = payload.actions[0];
  if (!/^home_(mine|assigned|prev|next)$/.test(action.action_id)) return null;
  let state;
  try { state = JSON.parse(action.value ?? '{}'); } catch { throw new TaskError('Invalid task view. Reopen Relay’s Home tab.'); }
  if (!['mine', 'assigned'].includes(state.mode) || !Number.isSafeInteger(state.page) || state.page < 0) throw new TaskError('Invalid task page. Reopen Relay’s Home tab.');
  // The user always comes from Slack's authenticated actor, never from button values.
  return { userId: payload.user.id, mode: action.action_id === 'home_mine' ? 'mine' : action.action_id === 'home_assigned' ? 'assigned' : state.mode, page: state.page };
}

export function taskHome(store, { teamId, channelId, userId, mode = 'mine', page = 0 }) {
  if (!['mine', 'assigned'].includes(mode)) throw new TaskError('Invalid task view.');
  const data = store.personalPage({ teamId, channelId, userId, direction: mode, page, othersOnly: mode === 'assigned' });
  const blocks = [
    { type: 'header', text: { type: 'plain_text', text: 'Your tasks, at a glance' } },
    section('Choose the work you want to see. Each table includes To do and Done tasks, with unfinished work first.'),
    { type: 'actions', elements: [
      { ...button('home_mine', 'Show tasks assigned to me', { mode: 'mine', page: 0 }), ...(mode === 'mine' ? { style: 'primary' } : {}) },
      { ...button('home_assigned', 'Show tasks I’ve assigned to others', { mode: 'assigned', page: 0 }), ...(mode === 'assigned' ? { style: 'primary' } : {}) }
    ] },
    { type: 'context', elements: [{ type: 'mrkdwn', text: `Private to you · Tasks from <#${channelId}> · Click either button to refresh.` }] },
    { type: 'divider' },
    { type: 'header', text: { type: 'plain_text', text: `${mode === 'mine' ? 'Tasks assigned to you' : 'Tasks you assigned to others'} · ${data.total - data.done} to do / ${data.done} done` } }
  ];
  if (!data.tasks.length) {
    blocks.push(section(mode === 'mine' ? 'No tasks have been assigned to you in this channel yet.' : 'You haven’t assigned any tasks to other people in this channel yet.'));
  } else {
    blocks.push({ type: 'table', column_settings: [{ is_wrapped: true }, { is_wrapped: true }, { is_wrapped: false }, { is_wrapped: false }], rows: [
      [text('Task'), text(mode === 'mine' ? 'Assigned by' : 'Assigned to'), text('Status'), text('Due')],
      ...data.tasks.map(task => [text(`#${task.id} ${task.title.length > 160 ? task.title.slice(0, 159) + '…' : task.title}`), person(mode === 'mine' ? task.creatorId : task.assigneeId), text(labels[task.status]), text(task.dueDate ?? '—')])
    ] });
    blocks.push({ type: 'context', elements: [{ type: 'plain_text', text: `Showing ${data.page * data.size + 1}–${data.page * data.size + data.tasks.length} of ${data.total}` }] });
    const navigation = [];
    if (data.page > 0) navigation.push(button('home_prev', 'Previous', { mode, page: data.page - 1 }));
    if (data.page < data.lastPage) navigation.push(button('home_next', 'Next', { mode, page: data.page + 1 }));
    if (navigation.length) blocks.push({ type: 'actions', elements: navigation });
  }
  blocks.push({ type: 'divider' }, section('Create a task with /task @person Task title in your Relay channel. Assignees use Mark done on the task card; the assigner receives a completion mention.'));
  return { type: 'home', callback_id: 'relay_task_home', blocks };
}

export async function publishTaskHome(client, store, { teamId, channelId, ...request }) {
  return client.call('views.publish', { user_id: request.userId, view: taskHome(store, { teamId, channelId, ...request }) });
}
