import { TaskError, clockParts, dueInZone, formatDue } from './tasks.js';
import { escapeSlack, learnTimeZone, unreachableUser } from './slack.js';

// Reminders DM the assignee so the assigner never has to nag:
// - a morning summary of their unfinished tasks (with "Due tomorrow" for the day before a deadline),
// - a heads-up one hour before a timed deadline,
// - a heads-up in the afternoon of the due day for a deadline with no time.
// Times are each person's own; settings can move them (useful for testing) or turn reminders off.
const clock = (value, fallback) => (/^([01]\d|2[0-3]):[0-5]\d$/.test(value ?? '') ? value : fallback);
const settings = () => ({
  on: process.env.RELAY_REMINDERS !== 'off',
  digest: clock(process.env.REMINDER_DIGEST_TIME, '09:00'),
  dueDay: clock(process.env.REMINDER_DUE_DAY_TIME, '16:00')
});
const minutes = time => Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
const hourLabel = time => { const hour = Number(time.slice(0, 2)); return `${hour % 12 || 12}${time.slice(3) === '00' ? '' : ':' + time.slice(3)} ${hour < 12 ? 'AM' : 'PM'}`; };
export const digestTimeLabel = () => hourLabel(settings().digest);
const nextDay = date => new Date(Date.parse(`${date}T00:00:00Z`) + 864e5).toISOString().slice(0, 10);
const DIGEST_LIMIT = 10;

// Which bucket a task falls in on the recipient's own calendar.
function bucket(task, timeZone, now) {
  const today = clockParts(now, timeZone).date, due = dueInZone(task, timeZone);
  if (!due.date) return 'none';
  if (task.dueAt ? task.dueAt * 1000 <= now.getTime() : due.date < today) return 'overdue';
  return due.date === today ? 'today' : due.date === nextDay(today) ? 'tomorrow' : 'later';
}
const sections = { overdue: 'Overdue', today: 'Due today', tomorrow: '⏰ Due tomorrow', later: 'Coming up', none: 'No deadline' };

// Every reminder that should go out now and has not been sent yet.
export function dueReminders(store, { now = new Date() } = {}) {
  const { on, digest, dueDay } = settings();
  if (!on) return [];
  const byPerson = new Map();
  for (const task of store.openTasks()) {
    if (!store.remindersOn(task.assigneeId)) continue;
    if (!byPerson.has(task.assigneeId)) byPerson.set(task.assigneeId, []);
    byPerson.get(task.assigneeId).push(task);
  }
  const reminders = [], nowSeconds = now.getTime() / 1000;
  for (const [userId, tasks] of byPerson) {
    const timeZone = store.timeZoneOf(userId), local = clockParts(now, timeZone), at = minutes(local.time);
    // The summary goes out at the digest time; if Relay was down then, it catches up for three hours, never later in the day.
    const digestKey = `digest:${userId}:${local.date}`;
    if (at >= minutes(digest) && at < minutes(digest) + 180 && !store.reminderSent(digestKey)) reminders.push({ kind: 'digest', key: digestKey, userId, timeZone, tasks });
    for (const task of tasks) {
      if (task.dueAt) {
        // One hour ahead, but not for work created inside that hour: the assignee was just told about it.
        const warnAt = task.dueAt - 3600, key = `soon:${task.id}:${task.dueAt}:${userId}`;
        if (nowSeconds >= warnAt && nowSeconds < task.dueAt && Date.parse(task.createdAt) / 1000 < warnAt && !store.reminderSent(key)) reminders.push({ kind: 'soon', key, userId, timeZone, tasks: [task] });
      } else if (task.dueDate) {
        const key = `today:${task.id}:${task.dueDate}:${userId}`;
        if (task.dueDate === local.date && at >= minutes(dueDay) && !store.reminderSent(key)) reminders.push({ kind: 'today', key, userId, timeZone, tasks: [task] });
      }
    }
  }
  return reminders;
}

const doneButton = task => ({ type: 'button', action_id: 'remind_done', text: { type: 'plain_text', text: 'Mark done' }, style: 'primary', value: JSON.stringify({ id: task.id }) });
const from = task => task.creatorId === task.assigneeId ? 'your own task' : `from <@${task.creatorId}>`;
const taskLine = (task, detail) => ({ type: 'section', text: { type: 'mrkdwn', text: `*#${task.id} · ${escapeSlack(task.title)}*\n${detail} · ${from(task)}` }, accessory: doneButton(task) });
const footer = { type: 'context', elements: [{ type: 'mrkdwn', text: 'Relay reminds you so nobody has to nag. Turn reminders off in Relay Home.' }] };

// The DM for one reminder, written on the recipient's own clock.
export function reminderMessage(reminder, now = new Date()) {
  const { kind, userId, timeZone, tasks } = reminder;
  if (kind === 'soon') {
    const [task] = tasks;
    return { channel: userId, text: `⏰ #${task.id} ${task.title} is due within the hour`, blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: '⏰ *Due within the hour*' } }, taskLine(task, `Due ${formatDue(task, { timeZone })}`), footer] };
  }
  if (kind === 'today') {
    const [task] = tasks;
    return { channel: userId, text: `⏰ #${task.id} ${task.title} is due today`, blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: '⏰ *Due today*' } }, taskLine(task, 'Due today'), footer] };
  }
  const order = Object.keys(sections), sorted = tasks.map(task => ({ task, bucket: bucket(task, timeZone, now) }))
    .sort((a, b) => order.indexOf(a.bucket) - order.indexOf(b.bucket) || (a.task.dueAt ?? Infinity) - (b.task.dueAt ?? Infinity) || String(a.task.dueDate).localeCompare(String(b.task.dueDate)) || a.task.id - b.task.id);
  const blocks = [{ type: 'section', text: { type: 'mrkdwn', text: `Good morning! You have *${tasks.length}* unfinished task${tasks.length === 1 ? '' : 's'}.` } }];
  let current = null;
  for (const { task, bucket: group } of sorted.slice(0, DIGEST_LIMIT)) {
    if (group !== current) { blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `*${sections[group]}*` }] }); current = group; }
    blocks.push(taskLine(task, group === 'none' ? 'No deadline' : `${group === 'overdue' ? 'Was due' : 'Due'} ${formatDue(task, { timeZone })}`));
  }
  if (tasks.length > DIGEST_LIMIT) blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `…and ${tasks.length - DIGEST_LIMIT} more in Relay Home.` }] });
  blocks.push(footer);
  return { channel: userId, text: `Good morning! You have ${tasks.length} unfinished task${tasks.length === 1 ? '' : 's'}.`, blocks };
}

// Sends whatever is due. A reminder that fails for a passing reason is tried again next minute.
export async function sendReminders(store, client, { now = new Date(), logger = console } = {}) {
  if (!settings().on) return [];
  for (const userId of new Set(store.openTasks().map(task => task.assigneeId))) await learnTimeZone(store, client, userId);
  const sent = [];
  for (const reminder of dueReminders(store, { now })) {
    try { await client.call('chat.postMessage', reminderMessage(reminder, now)); store.markReminderSent(reminder.key); sent.push(reminder.key); }
    catch (error) {
      if (unreachableUser.has(error.message)) store.markReminderSent(reminder.key);
      else logger.error(`Relay could not send a reminder (${error.message}); it will retry.`);
    }
  }
  return sent;
}

// "Mark done" in a reminder DM. Reminders are for the assignee, so they can finish the task from the DM even while a
// test channel lock is on. The DM is updated in place to show the task is done.
export function handleReminderAction(store, { teamId }, payload, receiptKey) {
  const action = payload.actions?.[0];
  if (payload.type !== 'block_actions' || payload.team?.id !== teamId || action?.action_id !== 'remind_done') return null;
  const feedback = text => ({ feedback: { channel: payload.channel?.id, user: payload.user?.id, text } });
  let id;
  try { id = JSON.parse(action.value).id; } catch { return feedback('This reminder is out of date. Open Relay Home instead.'); }
  const task = store.get(id, teamId);
  if (!task) return feedback('That task no longer exists.');
  if (task.status !== 'done') {
    // The latest version is used on purpose: the intent "this is done" holds even if the deadline was edited since.
    try { store.transition({ id, teamId, actorId: payload.user?.id, action: 'complete', receiptKey }); }
    catch (error) { if (error instanceof TaskError) return feedback(error.message); throw error; }
  }
  const blocks = (payload.message?.blocks ?? []).map(block => {
    if (block.accessory?.action_id !== 'remind_done') return block;
    let value; try { value = JSON.parse(block.accessory.value); } catch { return block; }
    if (value.id !== id) return block;
    const { accessory, ...rest } = block;
    return { ...rest, text: { ...block.text, text: `${block.text.text}\n✅ Done` } };
  });
  return { update: { channel: payload.channel?.id, ts: payload.message?.ts ?? payload.container?.message_ts, text: payload.message?.text ?? 'Relay reminder', blocks } };
}
