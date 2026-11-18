import test from 'node:test';
import assert from 'node:assert/strict';
import { TaskStore, zonedMoment } from '../src/tasks.js';
import { dueReminders, reminderMessage, sendReminders, handleReminderAction } from '../src/reminders.js';
import { taskHome, homeState } from '../src/home.js';
import { handleAppUi } from '../src/ui.js';
import { handleEnvelope } from '../src/socket.js';

const NY = 'America/New_York', LA = 'America/Los_Angeles';
const base = { teamId: 'TTEST', creatorId: 'UBOSS', assigneeId: 'UME', title: 'Send the slides' };
// An instant given as wall-clock time in New York.
const ny = (date, time) => new Date(zonedMoment(date, time, NY) * 1000);
const kinds = (store, now) => dueReminders(store, { now }).map(r => `${r.kind}:${r.userId}`).sort();
// Creates tasks as if made well before the reminders being tested.
const make = (store, task) => { const made = store.create(task); store.db.prepare("UPDATE tasks SET createdAt='2026-10-01T00:00:00.000Z' WHERE id=?").run(made.id); return store.get(made.id, 'TTEST'); };

test('the morning summary goes out at 9 AM in each person’s own zone, catches up until noon, and only once a day', () => {
  const store = new TaskStore(); store.saveTimeZone('UME', NY); store.saveTimeZone('UWEST', LA);
  make(store, base); make(store, { ...base, assigneeId: 'UWEST' });
  assert.deepEqual(kinds(store, ny('2026-10-26', '08:59')), []);
  assert.deepEqual(kinds(store, ny('2026-10-26', '09:00')), ['digest:UME']);
  assert.deepEqual(kinds(store, ny('2026-10-26', '12:00')), ['digest:UWEST']);  // 9:00 AM Pacific
  for (const r of dueReminders(store, { now: ny('2026-10-26', '12:00') })) store.markReminderSent(r.key);
  store.markReminderSent('digest:UME:2026-10-26');
  assert.deepEqual(kinds(store, ny('2026-10-26', '13:00')), []);                 // sent; and past noon for New York
  assert.deepEqual(kinds(store, ny('2026-10-27', '11:59')), ['digest:UME']);     // late start still catches up the next day
  assert.deepEqual(kinds(store, ny('2026-10-28', '12:00')), ['digest:UWEST']);   // never after noon in New York; 9 AM in Los Angeles
  store.close();
});

test('nobody gets a summary without unfinished work, after turning reminders off, or when reminders are switched off', () => {
  const store = new TaskStore(); store.saveTimeZone('UME', NY);
  const task = make(store, base); const nine = ny('2026-10-26', '09:05');
  store.transition({ id: task.id, teamId: 'TTEST', actorId: 'UME', action: 'complete' });
  assert.deepEqual(kinds(store, nine), []);
  make(store, base); store.setReminders('UME', false);
  assert.deepEqual(kinds(store, nine), []);
  store.setReminders('UME', true); assert.deepEqual(kinds(store, nine), ['digest:UME']);
  process.env.RELAY_REMINDERS = 'off';
  try { assert.deepEqual(kinds(store, nine), []); } finally { delete process.env.RELAY_REMINDERS; }
  store.close();
});

test('timed deadlines get a heads-up one hour before, once per deadline, and not for work created inside that hour', () => {
  const store = new TaskStore(); store.saveTimeZone('UME', NY);
  const task = make(store, { ...base, dueDate: '2026-10-26', dueTime: '17:00', dueZone: NY });
  assert.deepEqual(kinds(store, ny('2026-10-26', '15:59')), []);
  assert.deepEqual(kinds(store, ny('2026-10-26', '16:00')), ['soon:UME']);
  assert.deepEqual(kinds(store, ny('2026-10-26', '17:00')), []);                 // at the deadline it is too late
  for (const r of dueReminders(store, { now: ny('2026-10-26', '16:10') })) store.markReminderSent(r.key);
  assert.deepEqual(kinds(store, ny('2026-10-26', '16:20')), []);
  // Moving the deadline earns a new heads-up.
  store.manage({ id: task.id, teamId: 'TTEST', actorId: 'UBOSS', version: task.version, action: 'edit', changes: { ...base, dueDate: '2026-10-26', dueTime: '18:00', dueZone: NY } });
  assert.deepEqual(kinds(store, ny('2026-10-26', '17:00')), ['soon:UME']);
  const late = store.create({ ...base, title: 'Last minute', dueDate: '2026-10-27', dueTime: '10:00', dueZone: NY });
  assert.equal(dueReminders(store, { now: new Date(Date.parse(late.createdAt) + 1000) }).some(r => r.tasks[0].id === late.id), false);
  store.close();
});

test('date-only deadlines get a 4 PM heads-up on the due day and appear as Due tomorrow in the morning before', () => {
  const store = new TaskStore(); store.saveTimeZone('UME', NY);
  make(store, { ...base, dueDate: '2026-10-27' });
  assert.deepEqual(kinds(store, ny('2026-10-27', '15:59')), []);
  assert.deepEqual(kinds(store, ny('2026-10-27', '16:00')), ['today:UME']);
  assert.deepEqual(kinds(store, ny('2026-10-26', '16:00')), []);
  const [digest] = dueReminders(store, { now: ny('2026-10-26', '09:00') });
  assert.match(JSON.stringify(reminderMessage(digest, ny('2026-10-26', '09:00'))), /⏰ Due tomorrow/);
  store.close();
});

test('the summary orders work by urgency, shows each person’s own clock, caps its length, and offers Mark done', () => {
  const store = new TaskStore(); store.saveTimeZone('UME', LA);
  const now = ny('2026-10-26', '12:30');  // 9:30 AM in Los Angeles
  make(store, { ...base, title: 'Someday' });
  make(store, { ...base, title: 'Late', dueDate: '2026-10-25' });
  make(store, { ...base, title: 'This evening', dueDate: '2026-10-26', dueTime: '20:00', dueZone: NY });
  make(store, { ...base, title: 'Own reminder', creatorId: 'UME', dueDate: '2026-11-02' });
  const [digest] = dueReminders(store, { now });
  const message = reminderMessage(digest, now), text = JSON.stringify(message);
  assert.equal(message.channel, 'UME');
  assert.deepEqual(message.blocks.filter(b => b.type === 'context').map(b => b.elements[0].text).slice(0, 4), ['*Overdue*', '*Due today*', '*Coming up*', '*No deadline*']);
  assert.match(text, /This evening\*\\nDue 10\/26 5:00 PM · from <@UBOSS>/);  // 8 PM New York is 5 PM Pacific
  assert.match(text, /Own reminder\*\\nDue 11\/02 · your own task/);
  assert.equal(message.blocks.filter(b => b.accessory?.action_id === 'remind_done').length, 4);
  for (let i = 0; i < 9; i++) make(store, { ...base, title: `Extra ${i}` });
  const long = reminderMessage(dueReminders(store, { now })[0], now);
  assert.equal(long.blocks.filter(b => b.accessory).length, 10); assert.match(JSON.stringify(long), /and 3 more in Relay Home/);
  store.close();
});

test('sending posts DMs once, retries passing failures, and gives up on people Slack cannot reach', async () => {
  const store = new TaskStore(); store.saveTimeZone('UME', NY); store.saveTimeZone('UGONE', NY);
  make(store, base); make(store, { ...base, assigneeId: 'UGONE' });
  let fail = 'ratelimited'; const posts = [];
  const client = { call: async (method, payload) => {
    if (method === 'users.info') return { ok: true, user: { tz: NY } };
    if (payload.channel === 'UGONE') throw new Error('user_not_found');
    if (fail) { const error = fail; fail = null; throw new Error(error); }
    posts.push(payload); return { ok: true, ts: '1.1' };
  } };
  const now = ny('2026-10-26', '09:00'), quiet = { error() {} };
  assert.deepEqual(await sendReminders(store, client, { now, logger: quiet }), []);
  assert.deepEqual(await sendReminders(store, client, { now, logger: quiet }), ['digest:UME:2026-10-26']);
  assert.deepEqual(await sendReminders(store, client, { now, logger: quiet }), []);
  assert.equal(posts.length, 1); assert.equal(store.reminderSent('digest:UGONE:2026-10-26'), true); store.close();
});

test('Mark done in a reminder DM finishes the task, updates the DM, and works while a test channel lock is on', () => {
  const store = new TaskStore(); store.saveTimeZone('UME', NY);
  const task = make(store, { ...base, channelId: 'CTEST' }), other = make(store, { ...base, title: 'Other' });
  const message = reminderMessage(dueReminders(store, { now: ny('2026-10-26', '09:00') })[0]);
  const click = (user, id = task.id) => ({ envelope_id: `e-${user}-${id}`, type: 'interactive', payload: { type: 'block_actions', team: { id: 'TTEST' }, user: { id: user }, channel: { id: 'DREMIND' },
    message: { ts: '5.5', text: message.text, blocks: message.blocks }, actions: [{ action_id: 'remind_done', value: JSON.stringify({ id }) }] } });
  const denied = handleEnvelope({ store, teamId: 'TTEST', allowedChannelId: 'CTEST' }, click('USTRANGER'));
  assert.match(denied.feedback.text, /assignee or assigner/); assert.equal(store.get(task.id, 'TTEST').status, 'todo');
  const result = handleEnvelope({ store, teamId: 'TTEST', allowedChannelId: 'CTEST' }, click('UME'));
  assert.equal(store.get(task.id, 'TTEST').status, 'done'); assert.equal(store.get(other.id, 'TTEST').status, 'todo');
  assert.equal(result.update.channel, 'DREMIND'); assert.equal(result.update.ts, '5.5');
  const done = result.update.blocks.find(b => /Send the slides/.test(b.text?.text ?? '') && !b.accessory);
  assert.match(done.text.text, /✅ Done$/);
  assert.equal(result.update.blocks.filter(b => b.accessory?.action_id === 'remind_done').length, 1);
  // A second click (e.g. on an old copy of the DM) just confirms it is done.
  assert.equal(handleReminderAction(store, { teamId: 'TTEST' }, click('UME').payload, 'again').update.ts, '5.5');
  store.close();
});

test('Relay Home has a reminders switch that each person controls', () => {
  const store = new TaskStore();
  const toggle = on => handleAppUi(store, { teamId: 'TTEST' }, { type: 'block_actions', team: { id: 'TTEST' }, user: { id: 'UME' }, view: { type: 'home', private_metadata: JSON.stringify(homeState()) },
    actions: [{ action_id: 'ui_reminders', value: JSON.stringify({ on }) }] });
  const button = () => taskHome(store, { teamId: 'TTEST', userId: 'UME' }).blocks.at(-1).elements.find(e => e.action_id === 'ui_reminders');
  assert.equal(button().text.text, '🔔 Reminders: on');
  assert.match(toggle(false).home.notice, /off/); assert.equal(store.remindersOn('UME'), false);
  assert.equal(button().text.text, '🔕 Reminders: off'); assert.equal(store.remindersOn('UOTHER'), true);
  assert.match(toggle(true).home.notice, /9 AM summary/); assert.equal(store.remindersOn('UME'), true); store.close();
});
