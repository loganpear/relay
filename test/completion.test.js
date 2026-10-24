import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaskStore } from '../src/tasks.js';
import { taskMessage, flushOutbox, SlackClient } from '../src/slack.js';

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
  assert.equal(taskMessage(complete(store, task)).blocks.find(b => b.type === 'actions').elements[0].text.text, 'Reopen');
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

test('no completion mention is sent before the task card is delivered', async () => {
  const store = new TaskStore(); const task = store.create(input); complete(store, task);
  let notified = false;
  await flushOutbox(store, { deliver: async () => { throw new Error('not_in_channel'); }, notifyCompletion: async () => { notified = true; } });
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
