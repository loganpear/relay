import {TaskError,parseTask,labels,isTaskArchived,formatDue} from './task-store.js';
import {escapeSlack} from './slack.js';

const help = 'Create: /task @person Task title --due fri 5pm --details "Requirements or notes"\nDeadlines: --due tomorrow, --due 11/6, --due nov 6 at noon, --due 11/06 5:30 PM\nThe assignee clicks Mark done; the assigner gets a completion mention in the task thread.\nLists: /tasks mine · /tasks assigned · /tasks team · /tasks all';
const ephemeral = text => ({ response_type: 'ephemeral', text });

export function handleCommand(store, form, receiptKey) {
  const context = { teamId: form.team_id, channelId: form.channel_id, userId: form.user_id };
  if (!context.teamId || !context.channelId || !context.userId) throw new TaskError('Missing Slack workspace, channel, or user.');
  const text = (form.text ?? '').trim();
  if (form.command === '/tasks') {
    const mode = text || 'mine';
    if (!['mine', 'assigned', 'team', 'all'].includes(mode)) return ephemeral(help);
    const tasks = store.list({ ...context, mode, includeDone: mode === 'all' });
    if (!tasks.length) return ephemeral('No matching tasks. Create one with /task @person Task title.');
    const heading = { mine: 'Your unfinished tasks', assigned: 'Unfinished tasks you assigned', team: 'Unfinished tasks in this channel', all: 'Tasks in this channel' }[mode];
    return ephemeral(`*${heading}*\n` + tasks.map(task => `• #${task.id} · ${escapeSlack(task.title)} — *${labels[task.status]}*${isTaskArchived(task)?' · Archived':''} · <@${task.assigneeId}>${task.dueDate ? ` · due ${formatDue(task,{timeZone:store.timeZoneOf(context.userId)})}` : ''}`).join('\n') + '\nMark tasks done from their card or Relay Home. Showing up to 50 tasks.');
  }
  if (form.command !== '/task') throw new TaskError('Unknown command. Use /task or /tasks.');
  if (!text || text === 'help') return ephemeral(help);
  // Deadlines typed in /task are on the author's own clock.
  const timeZone = store.timeZoneOf(context.userId);
  const task = store.create({ ...context, creatorId: context.userId, dueZone: timeZone, ...parseTask(text, { timeZone }) }, receiptKey);
  return ephemeral(`Task #${task.id} saved. Its card will appear here. If Relay can’t post in this conversation, the task stays in Relay Home and the assignee gets a direct message.`);
}

export function handleInteraction(store, payload, receiptKey) {
  if (payload.type !== 'block_actions' || payload.actions?.length !== 1) throw new TaskError('Unsupported interaction.');
  const selected = payload.actions[0];
  if (selected.action_id === 'task_reopen') throw new TaskError('Reopen moved to Relay Home. The assigner can send a Done task back to To do from Assigned by you.');
  if (selected.action_id !== 'task_complete') throw new TaskError('This is an older task button. Use the updated card.');
  let value;
  try { value = JSON.parse(selected.value); } catch { throw new TaskError('Invalid task button.'); }
  if (!Number.isSafeInteger(value.id) || !Number.isSafeInteger(value.version)) throw new TaskError('Invalid task button.');
  return store.transition({ id: value.id, version: value.version, teamId: payload.team?.id,
    channelId: payload.channel?.id, actorId: payload.user?.id,
    action: 'complete', receiptKey });
}
