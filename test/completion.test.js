import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaskStore } from '../src/tasks.js';
import { taskMessage, flushOutbox, SlackClient } from '../src/slack.js';
import { handleInteraction } from '../src/server.js';

const input = { teamId: 'TTEST', channelId: 'CTEST', title: 'Finish the task', assigneeId: 'UASSIGNEE', creatorId: 'UCREATOR' };
function complete(store, task, receiptKey = 'completion') {
  return store.transition({ id: task.id, teamId: task.teamId, channelId: task.channelId, actorId: task.assigneeId, action: 'complete', version: task.version, receiptKey });
}

test('cards have only To do / Done and one Mark done button', () => {
  const store = new TaskStore(); const task = store.create(input);
  const card = taskMessage(task);
  const actions = card.blocks.find(b => b.type === 'actions').elements;
  assert.equal(actions.length, 1);
  assert.equal(actions[0].text.text, 'Mark done');
  assert.equal(actions[0].action_id, 'task_complete');
  assert.doesNotMatch(JSON.stringify(card), /Reviewer|Ready for review|Start task|Approve/);
  const done = complete(store, task);
  assert.equal(taskMessage(done).blocks.some(b => b.type === 'actions'), false);
  assert.match(JSON.stringify(taskMessage(done)), /assigner can send it back to To do from Relay Home/);
  // Reopen buttons on cards posted before this change point to Relay Home and change nothing.
  const oldReopen = { type: 'block_actions', team: { id: 'TTEST' }, channel: { id: 'CTEST' }, user: { id: 'UCREATOR' }, actions: [{ action_id: 'task_reopen', value: JSON.stringify({ id: done.id, version: done.version }) }] };
  assert.throws(() => handleInteraction(store, oldReopen, 'old-card'), /Relay Home/);
  assert.equal(store.get(done.id, 'TTEST').status, 'done');
  store.close();
});

test('completion mentions the assigner in the original task thread exactly once on successful delivery', async () => {
  const store = new TaskStore(); const task = store.create({ ...input, title: '<!channel> confidential *format*' });
  const calls = [];
  const client = new SlackClient('test', async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return { ok: true, status: 200, json: async () => ({ ok: true, ts: url.endsWith('chat.update') ? JSON.parse(options.body).ts : `100.${calls.length}` }) };
  });
  await flushOutbox(store, client);
  complete(store, task); complete(store, task);
  await flushOutbox(store, client); await flushOutbox(store, client);
  const messages = calls.filter(c => c.url.endsWith('chat.postMessage'));
  assert.equal(messages.length, 2); // Original card and one notification.
  assert.equal(messages[1].body.thread_ts, '100.1');
  assert.equal(messages[1].body.channel, 'CTEST');
  assert.equal(messages[1].body.reply_broadcast, false);
  assert.match(messages[1].body.text, /<@UCREATOR>/);
  assert.doesNotMatch(messages[1].body.text, /<!channel>/);
  assert.equal(messages[1].body.blocks[1].text.type, 'plain_text');
  assert.equal(store.db.prepare('SELECT sentTs FROM completion_notifications').get().sentTs, '100.3');
  store.close();
});

test('failed notification retries independently without losing completion or duplicating the card', async () => {
  const store = new TaskStore(); const task = store.create(input);
  let notifications = 0, deliveries = 0;
  const client = {
    deliver: async () => { deliveries++; return '10.1'; },
    notifyCompletion: async () => { notifications++; if (notifications === 1) throw new Error('temporarily_unavailable'); return '10.2'; }
  };
  complete(store, task); await flushOutbox(store, client);
  assert.equal(store.get(task.id, 'TTEST').status, 'done');
  assert.equal(store.db.prepare('SELECT error FROM completion_notifications').get().error, 'temporarily_unavailable');
  store.db.exec('UPDATE completion_notifications SET nextAttempt=0');
  await flushOutbox(store, client);
  assert.equal(deliveries, 1); assert.equal(notifications, 2);
  assert.equal(store.pendingNotifications().length, 0); store.close();
});

test('sending work back mentions the assignee in the task thread and replaces an unsent completion mention', async () => {
  const store = new TaskStore(); let task = store.create(input);
  const calls = [];
  const client = new SlackClient('test', async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return { ok: true, status: 200, json: async () => ({ ok: true, ts: url.endsWith('chat.update') ? JSON.parse(options.body).ts : `200.${calls.length}` }) };
  });
  const sendBack = done => store.transition({ id: done.id, teamId: 'TTEST', channelId: 'CTEST', actorId: 'UCREATOR', action: 'reopen', version: done.version });
  await flushOutbox(store, client);
  // Sent back before the completion mention goes out: only the send-back mention is posted.
  task = sendBack(complete(store, task));
  await flushOutbox(store, client); await flushOutbox(store, client);
  const mentions = calls.filter(c => c.url.endsWith('chat.postMessage') && c.body.thread_ts);
  assert.equal(mentions.length, 1);
  assert.equal(mentions[0].body.thread_ts, '200.1');
  assert.equal(mentions[0].body.reply_broadcast, false);
  assert.match(mentions[0].body.text, /^<@UASSIGNEE> — <@UCREATOR> sent task #\d+ back to To do/);
  assert.equal(store.pendingNotifications().length, 0); store.close();
});

test('reassigning active work mentions only the latest new assignee in the task thread', async () => {
  const store = new TaskStore(); let task = store.create(input);
  const calls = [];
  const client = new SlackClient('test', async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return { ok: true, status: 200, json: async () => ({ ok: true, ts: url.endsWith('chat.update') ? JSON.parse(options.body).ts : `300.${calls.length}` }) };
  });
  const reassign = (assigneeId, actorId = 'UCREATOR') => (task = store.manage({ id: task.id, teamId: 'TTEST', channelId: 'CTEST', actorId, version: task.version, action: 'edit', changes: { title: task.title, assigneeId } }));
  const mentions = () => calls.filter(c => c.url.endsWith('chat.postMessage') && c.body.thread_ts && /assigned task/.test(c.body.text));
  await flushOutbox(store, client);
  // Two quick reassignments: the unsent mention for the first new assignee is dropped.
  reassign('UFIRST'); reassign('USECOND');
  await flushOutbox(store, client); await flushOutbox(store, client);
  assert.equal(mentions().length, 1);
  assert.equal(mentions()[0].body.thread_ts, '300.1');
  assert.match(mentions()[0].body.text, /^<@USECOND> — <@UCREATOR> assigned task #\d+ to you\./);
  // Saving with the same assignee, assigning to yourself, or reassigning finished work sends nothing.
  store.manage({ id: task.id, teamId: 'TTEST', channelId: 'CTEST', actorId: 'UCREATOR', version: task.version, action: 'edit', changes: { title: 'Renamed', assigneeId: 'USECOND' } });
  task = store.get(task.id, 'TTEST'); reassign('UCREATOR');
  reassign('UTHIRD'); task = store.transition({ id: task.id, teamId: 'TTEST', channelId: 'CTEST', actorId: 'UTHIRD', action: 'complete', version: task.version });
  const before = mentions().length;
  reassign('UFOURTH');
  await flushOutbox(store, client); await flushOutbox(store, client);
  assert.equal(mentions().length, before);
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM completion_notifications WHERE kind='assign' AND assigneeId IN ('UCREATOR','UFOURTH')").get().n, 0);
  store.close();
});

test('no completion mention is sent before the task card is delivered', async () => {
  const store = new TaskStore(); const task = store.create(input); complete(store, task);
  let notified = false;
  await flushOutbox(store, { deliver: async () => { throw new Error('internal_error'); }, notifyCompletion: async () => { notified = true; } });
  assert.equal(notified, false);
  assert.equal(store.get(task.id, 'TTEST').status, 'done'); store.close();
});

test('migration preserves history and finished work, and never sends retrospective completion notifications', () => {
  const folder = mkdtempSync(join(tmpdir(), 'relay-migrate-')); const path = join(folder, 'old.sqlite');
  try {
    let store = new TaskStore(path);
    const ids = ['todo', 'in_progress', 'review', 'done'].map((status, i) => {
      const task = store.create({ ...input, title: `Old task ${i}` });
      store.db.prepare('UPDATE tasks SET status=?,requiresReview=1,lastComment=? WHERE id=?').run(status, 'Legacy feedback', task.id);
      return task.id;
    });
    store.db.exec('DELETE FROM schema_migrations'); store.close();
    store = new TaskStore(path);
    assert.deepEqual(ids.map(id => store.get(id, 'TTEST').status), ['todo', 'todo', 'todo', 'done']);
    assert.equal(store.pending().length, 4);
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM completion_notifications').get().n, 0);
    assert.equal(store.history(ids[2]).length, 1);
    assert.equal(store.get(ids[2], 'TTEST').version, 1); store.close();
    store = new TaskStore(path); assert.equal(store.get(ids[2], 'TTEST').version, 1); store.close();
  } finally { rmSync(folder, { recursive: true }); }
});

test('a queued completion notification survives restarting the app', () => {
  const folder = mkdtempSync(join(tmpdir(), 'relay-notify-')); const path = join(folder, 'tasks.sqlite');
  try {
    let store = new TaskStore(path); const task = store.create(input);
    complete(store, task); store.delivered(store.get(task.id, 'TTEST'), '1.1'); store.close();
    store = new TaskStore(path);
    assert.equal(store.pendingNotifications().length, 1);
    assert.equal(store.pendingNotifications()[0].creatorId, 'UCREATOR'); store.close();
  } finally { rmSync(folder, { recursive: true }); }
});
