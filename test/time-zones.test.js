import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaskStore, formatDue, zonedMoment } from '../src/tasks.js';
import { taskHome, homeState } from '../src/home.js';
import { taskMessage, learnTimeZone, SlackClient } from '../src/slack.js';
import { handleAppUi } from '../src/ui.js';
import { handleCommand } from '../src/server.js';

const LA = 'America/Los_Angeles', NY = 'America/New_York';
const base = { teamId: 'TTEST', title: 'Zone check', creatorId: 'UME', assigneeId: 'UOTHER' };
const config = { teamId: 'TTEST' };
const action = (name, task, actor) => ({ type: 'block_actions', team: { id: 'TTEST' }, user: { id: actor }, trigger_id: 't', view: { type: 'home', private_metadata: JSON.stringify(homeState()) },
  actions: [{ action_id: name, value: JSON.stringify({ id: task?.id, version: task?.version }) }] });
const submit = (view, values, actor, id) => ({ type: 'view_submission', team: { id: 'TTEST' }, user: { id: actor },
  view: { id, type: 'modal', callback_id: 'relay_task_form', private_metadata: view.private_metadata, state: { values } } });
const form = (date, time, extra = {}) => ({ title: { value: { value: extra.title ?? 'Zone check' } }, assignee: { value: { selected_user: 'UOTHER' } },
  due_date: { value: { selected_date: date } }, due_time: { value: { selected_time: time } }, details: { value: { value: '' } } });

test('a deadline is one moment that each viewer sees on their own clock, and overdue is exact', () => {
  const store = new TaskStore();
  const task = store.create({ ...base, dueDate: '2026-11-06', dueTime: '17:30', dueZone: LA });
  assert.equal(task.dueAt, zonedMoment('2026-11-06', '17:30', LA)); assert.equal(task.dueZone, LA);
  assert.equal(formatDue(task, { timeZone: LA }), '11/06 5:30 PM');
  assert.equal(formatDue(task, { timeZone: NY }), '11/06 8:30 PM');
  assert.equal(formatDue(task, { timeZone: 'Europe/London' }), '11/07 1:30 AM');
  const after = new Date((task.dueAt + 60) * 1000), before = new Date((task.dueAt - 60) * 1000);
  for (const timeZone of [LA, NY]) {
    assert.match(formatDue(task, { timeZone, now: after, markOverdue: true }), /^Overdue/);
    assert.doesNotMatch(formatDue(task, { timeZone, now: before, markOverdue: true }), /^Overdue/);
  }
  // Date-only deadlines read the same everywhere.
  assert.equal(formatDue(store.create({ ...base, dueDate: '2026-11-06' }), { timeZone: LA }), '11/06'); store.close();
});

test('Home and details use the viewer’s zone, and channel cards let Slack localize the time', () => {
  const store = new TaskStore(); store.saveTimeZone('UOTHER', LA);
  const task = store.create({ ...base, channelId: 'CTEST', dueDate: '2026-11-06', dueTime: '17:30', dueZone: NY });
  const view = taskHome(store, { teamId: 'TTEST', userId: 'UOTHER' });
  assert.match(view.blocks.find(b => b.type === 'data_table').rows[1][2].text, /11\/06 2:30 PM$/);
  assert.match(JSON.stringify(view.blocks.at(-2)), /Times in Pacific/);
  const details = handleAppUi(store, config, action(`ui_details:mine:${task.id}`, task, 'UOTHER')).openModal.view;
  assert.match(JSON.stringify(details), /Due: 11\/06 2:30 PM \(Pacific/);
  const card = JSON.stringify(taskMessage(task));
  assert.match(card, new RegExp(`<!date\\^${task.dueAt}\\^\\{date_short_pretty\\} at \\{time\\}\\|11/06 5:30 PM Eastern time>`)); store.close();
});

test('forms read times on the author’s clock, show them on each editor’s clock, and keep the moment', () => {
  const store = new TaskStore(); store.saveTimeZone('UME', LA); store.saveTimeZone('UOTHER', NY);
  const create = handleAppUi(store, config, action('ui_new', null, 'UME')).openModal.view;
  assert.equal(create.blocks.find(b => b.block_id === 'due_time').element.timezone, LA);
  handleAppUi(store, config, submit(create, form('2026-11-06', '09:00'), 'UME', 'VCREATE'), 'k1');
  let task = store.list({ teamId: 'TTEST', userId: 'UME', mode: 'assigned' })[0];
  assert.equal(task.dueZone, LA); assert.equal(task.dueAt, zonedMoment('2026-11-06', '09:00', LA));
  // The assigner edits from New York after moving: the form shows noon, and saving unchanged keeps the same moment.
  store.saveTimeZone('UME', NY, Date.now());
  const edit = handleAppUi(store, config, action(`ui_due:assigned:${task.id}`, task, 'UME')).openModal.view;
  assert.equal(edit.blocks.find(b => b.block_id === 'due_time').element.initial_time, '12:00');
  handleAppUi(store, config, submit(edit, { due_date: { value: { selected_date: '2026-11-06' } }, due_time: { value: { selected_time: '12:00' } } }, 'UME', 'VEDIT'));
  task = store.get(task.id, 'TTEST');
  assert.equal(task.dueAt, zonedMoment('2026-11-06', '09:00', LA)); assert.equal(task.dueZone, NY); store.close();
});

test('editing Past work never moves its deadline, even from another zone', () => {
  const store = new TaskStore(); store.saveTimeZone('UME', LA);
  let task = store.create({ ...base, dueDate: '2026-11-06', dueTime: '17:30', dueZone: NY, details: 'Old' });
  task = store.transition({ id: task.id, teamId: 'TTEST', actorId: 'UOTHER', action: 'complete', version: task.version });
  const original = task.dueAt;
  const pastAction = action(`ui_details:assigned:${task.id}`, task, 'UME'); pastAction.view.private_metadata = JSON.stringify(homeState({ period: 'past' }));
  const details = handleAppUi(store, config, pastAction).openModal.view;
  const meta = JSON.parse(details.private_metadata);
  const editView = { private_metadata: JSON.stringify({ operation: 'edit', state: meta.state, timeZone: LA, taskId: task.id, version: task.version }) };
  const values = form(null, null, { title: 'Renamed' }); delete values.due_date; delete values.due_time;
  assert.deepEqual(handleAppUi(store, config, submit(editView, values, 'UME', 'VPAST')).ackPayload, {});
  task = store.get(task.id, 'TTEST');
  assert.equal(task.title, 'Renamed'); assert.equal(task.dueAt, original); assert.equal(task.dueZone, NY); store.close();
});

test('/task deadlines use the author’s zone', () => {
  const store = new TaskStore(); store.saveTimeZone('UME', LA);
  handleCommand(store, { team_id: 'TTEST', channel_id: 'CTEST', user_id: 'UME', command: '/task', text: '<@UOTHER> Ship --due 11/06 05:30 PM' }, 'k');
  const task = store.get(1, 'TTEST');
  assert.equal(task.dueZone, LA); assert.equal(task.dueAt, zonedMoment(task.dueDate, '17:30', LA));
  const list = handleCommand(store, { team_id: 'TTEST', channel_id: 'CTEST', user_id: 'UOTHER', command: '/tasks', text: 'mine' }).text;
  assert.match(list, /due 11\/06 8:30 PM/); store.close();
});

test('Relay learns time zones from Slack, retries hourly without permission, and daily once known', async () => {
  const store = new TaskStore(); let answer = { ok: false, error: 'missing_scope' }, calls = 0;
  const client = { call: async () => { calls++; if (!answer.ok) throw new Error(answer.error); return answer; } };
  await learnTimeZone(store, client, 'UME');
  assert.equal(store.timeZoneOf('UME'), NY); assert.equal(store.timeZoneDue('UME'), false);
  assert.equal(store.timeZoneDue('UME', Date.now() + 61 * 60 * 1000), true);
  answer = { ok: true, user: { tz: LA } }; store.saveTimeZone('UME', null, 0);
  await learnTimeZone(store, client, 'UME');
  assert.equal(store.timeZoneOf('UME'), LA); assert.equal(calls, 2);
  assert.equal(store.timeZoneDue('UME', Date.now() + 2 * 60 * 60 * 1000), false);
  answer = { ok: false, error: 'ratelimited' }; store.saveTimeZone('UME', null, 0);
  await learnTimeZone(store, client, 'UME');
  assert.equal(store.timeZoneOf('UME'), LA); store.close();
});

test('the real Slack client asks for time zones form-encoded, which users.info requires', async () => {
  const store = new TaskStore(), requests = [];
  const client = new SlackClient('test', async (url, options) => {
    requests.push({ url, options });
    return { ok: true, status: 200, json: async () => ({ ok: true, user: { tz: LA } }) };
  });
  await learnTimeZone(store, client, 'UME');
  assert.match(requests[0].url, /users\.info$/);
  assert.equal(requests[0].options.headers['content-type'], 'application/x-www-form-urlencoded');
  assert.equal(requests[0].options.body, 'user=UME');
  assert.equal(store.timeZoneOf('UME'), LA); store.close();
});

test('the migration turns older Eastern deadlines into exact moments', () => {
  const dir = mkdtempSync(join(tmpdir(), 'relay-zones-')), path = join(dir, 'tasks.sqlite');
  try {
    let store = new TaskStore(path);
    const task = store.create({ ...base, dueDate: '2026-11-06', dueTime: '17:30' });
    store.db.exec("UPDATE tasks SET dueAt=NULL,dueZone=NULL; DELETE FROM schema_migrations WHERE name='due-moments'"); store.close();
    store = new TaskStore(path);
    const migrated = store.get(task.id, 'TTEST');
    assert.equal(migrated.dueZone, NY); assert.equal(migrated.dueAt, zonedMoment('2026-11-06', '17:30', NY)); store.close();
  } finally { rmSync(dir, { recursive: true }); }
});
