import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { TaskStore, parseTask, TaskError } from '../src/tasks.js';
import { verifySlack, taskMessage, SlackClient, flushOutbox } from '../src/slack.js';
import { createApp, handleCommand, handleInteraction } from '../src/server.js';

const base = { teamId: 'T1', channelId: 'C1', creatorId: 'UCREATOR', assigneeId: 'UASSIGNEE', title: 'Ship it' };
const transition = (store, task, action, actorId = 'UASSIGNEE', extra = {}) => store.transition({ id: task.id, teamId: 'T1', channelId: 'C1', actorId, action, ...extra });

test('parses Slack mentions, options, and valid dates without guessing', () => {
  assert.deepEqual(parseTask('<@U123|Alex> Fix mobile spacing --due 2026-11-02 --no-review'), { assigneeId: 'U123', title: 'Fix mobile spacing', dueDate: '2026-11-02' });
  for (const text of ['@alex Fix it', '<@U123> Fix --due Friday', '<@U123> Fix --due 2026-02-30', '<@U123> --no-review', '<@U123> Fix --unknown yes']) assert.throws(() => parseTask(text), TaskError);
});

test('only the assignee can complete a task, within its workspace and channel', () => {
  const store = new TaskStore(); const task = store.create(base);
  for (const actor of ['USTRANGER', 'UCREATOR']) assert.throws(() => transition(store, task, 'complete', actor), TaskError);
  assert.throws(() => transition(store, task, 'complete', 'UASSIGNEE', { channelId: 'COTHER' }), TaskError);
  assert.throws(() => transition(store, task, 'complete', 'UASSIGNEE', { teamId: 'TOTHER' }), TaskError);
  assert.throws(() => transition(store, task, 'complete', 'UASSIGNEE', { version: 99 }), TaskError);
  for (const action of ['start', 'ready', 'approve', 'changes']) assert.throws(() => transition(store, task, action), TaskError);
  assert.equal(store.history(task.id).length, 1);
  const done = transition(store, task, 'complete', 'UASSIGNEE', { version: 0 });
  assert.equal(done.status, 'done');
  assert.equal(store.history(task.id).length, 2);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM completion_notifications').get().n, 1);
  assert.throws(() => transition(store, task, 'complete'), TaskError);
  store.close();
});

test('retries do not create duplicate tasks or duplicate transitions', () => {
  const store = new TaskStore();
  const task = store.create(base, 'create-retry');
  assert.equal(store.create(base, 'create-retry').id, task.id);
  transition(store, task, 'complete', 'UASSIGNEE', { receiptKey: 'action-retry', version: 0 });
  transition(store, task, 'complete', 'UASSIGNEE', { receiptKey: 'action-retry', version: 0 });
  assert.equal(store.history(task.id).length, 2);
  assert.equal(store.list({ teamId: 'T1', channelId: 'C1', includeDone: true }).length, 1);
  store.close();
});

test('tasks, audit history, and delivery queue survive a restart', () => {
  const directory = mkdtempSync(join(tmpdir(), 'relay-test-')); const path = join(directory, 'tasks.sqlite');
  try {
    let store = new TaskStore(path); const task = store.create(base); transition(store, task, 'complete'); store.close();
    store = new TaskStore(path);
    assert.equal(store.get(task.id, 'T1').status, 'done');
    assert.equal(store.history(task.id).length, 2);
    assert.equal(store.pending().length, 1); store.close();
  } finally { rmSync(directory, { recursive: true }); }
});

test('personal lists span channels, team lists stay in their channel, workspaces stay isolated, and completed work is hidden by default', () => {
  const store = new TaskStore();
  store.create(base); store.create({ ...base, teamId: 'T2' }); store.create({ ...base, channelId: 'C2' }); store.create({ ...base, channelId: null });
  const done = store.create({ ...base }); transition(store, done, 'complete');
  const context = { teamId: 'T1', channelId: 'C1', userId: 'UASSIGNEE' };
  assert.equal(store.list({ ...context, mode: 'mine' }).length, 3);
  assert.equal(store.list({ ...context, includeDone: true }).length, 2);
  assert.equal(store.list({ ...context, userId: 'USTRANGER', mode: 'mine' }).length, 0);
  store.close();
});

test('validates signatures and rejects tampering, old timestamps, and bad headers', () => {
  const raw = Buffer.from('command=%2Ftask&text=hello'); const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = 'v0=' + createHmac('sha256', 'secret').update(`v0:${timestamp}:`).update(raw).digest('hex');
  const headers = { 'x-slack-request-timestamp': timestamp, 'x-slack-signature': signature };
  assert.equal(verifySlack(raw, headers, 'secret'), true);
  assert.equal(verifySlack(Buffer.from('tampered'), headers, 'secret'), false);
  assert.equal(verifySlack(raw, headers, 'secret', Date.now() + 301000), false);
  assert.equal(verifySlack(raw, {}, 'secret'), false);
  assert.equal(verifySlack(raw, headers, ''), false);
});

test('delivery retries preserve saved work and use chat.update after posting', async () => {
  const store = new TaskStore(); const task = store.create(base);
  let calls = [], fail = true;
  const client = new SlackClient('fake-token', async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return { ok: true, status: 200, json: async () => fail ? { ok: false, error: 'internal_error' } : { ok: true, ts: '123.456' } };
  });
  await flushOutbox(store, client);
  assert.equal(store.get(task.id, 'T1').status, 'todo');
  assert.equal(store.db.prepare('SELECT error FROM outbox').get().error, 'internal_error');
  fail = false; store.db.exec('UPDATE outbox SET nextAttempt=0'); await flushOutbox(store, client);
  assert.equal(store.pending().length, 0);
  assert.equal(store.get(task.id, 'T1').messageTs, '123.456');
  transition(store, task, 'complete'); await flushOutbox(store, client);
  assert.match(calls.at(-2).url, /chat.update$/);
  assert.equal(calls.at(-2).body.ts, '123.456');
  assert.equal(calls.at(-1).body.thread_ts, '123.456');
  store.close();
});

test('completion arriving during a message delivery is not lost', async () => {
  const store = new TaskStore(); const task = store.create(base);
  await flushOutbox(store, { deliver: async () => { transition(store, task, 'complete'); return '1.2'; } });
  assert.equal(store.pending().length, 1);
  assert.equal(store.get(task.id, 'T1').messageTs, '1.2');
  await flushOutbox(store, { deliver: async task => { assert.equal(task.status, 'done'); return task.messageTs; } });
  assert.equal(store.pending().length, 0); store.close();
});

test('card titles cannot inject Slack markup; buttons carry versions', () => {
  const store = new TaskStore(); const task = store.create({ ...base, title: '<!channel> *hello* ' + 'x'.repeat(220) });
  const message = taskMessage(task);
  assert.ok(message.blocks[0].text.text.length <= 150);
  assert.equal(message.blocks[1].text.type, 'plain_text');
  const button = message.blocks.find(block => block.type === 'actions').elements[0];
  assert.deepEqual(JSON.parse(button.value), { id: task.id, version: 0 }); store.close();
});

test('Slack commands and button payloads complete the workflow', () => {
  const store = new TaskStore();
  handleCommand(store, { command: '/task', text: '<@UASSIGNEE> Build the app', team_id: 'T1', channel_id: 'C1', user_id: 'UCREATOR' }, 'command');
  const task = store.list({ teamId: 'T1', channelId: 'C1' })[0];
  handleInteraction(store, { type: 'block_actions', team: { id: 'T1' }, channel: { id: 'C1' }, user: { id: 'UASSIGNEE' }, actions: [{ action_id: 'task_complete', value: JSON.stringify({ id: task.id, version: 0 }) }] }, 'button');
  const list = handleCommand(store, { command: '/tasks', text: 'all', team_id: 'T1', channel_id: 'C1', user_id: 'UCREATOR' });
  assert.match(list.text, /Build the app/);
  assert.match(list.text, /Done/);
  assert.equal(store.get(task.id, 'T1').status, 'done'); store.close();
});

test('HTTP rejects unsigned and wrong-workspace requests; demo routes are off in Slack mode', async t => {
  const store = new TaskStore(); const server = createApp({ store, secret: 'test-secret', teamId: 'T1', allowedChannelId: 'C1' });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { await new Promise(resolve => server.close(resolve)); store.close(); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(origin + '/demo/tasks')).status, 404);
  assert.equal((await fetch(origin + '/slack/commands', { method: 'POST', body: 'x=1' })).status, 401);
  async function signed(team, channel = 'C1') {
    const body = new URLSearchParams({ team_id: team, channel_id: channel, user_id: 'UCREATOR', command: '/task', text: '<@UASSIGNEE> Test' }).toString();
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = 'v0=' + createHmac('sha256', 'test-secret').update(`v0:${timestamp}:${body}`).digest('hex');
    return fetch(origin + '/slack/commands', { method: 'POST', body, headers: { 'x-slack-request-timestamp': timestamp, 'x-slack-signature': signature } });
  }
  assert.equal((await signed('TOTHER')).status, 403);
  assert.match((await (await signed('T1', 'CGENERAL')).json()).text, /restricted/);
  assert.equal(store.list({ teamId: 'T1', channelId: 'CGENERAL' }).length, 0);
  assert.equal((await signed('T1')).status, 200);
  assert.equal(store.list({ teamId: 'T1', channelId: 'C1' }).length, 1);
});

test('demo saves tasks and rejects cross-origin mutations', async t => {
  const store = new TaskStore(); const server = createApp({ store, demo: true });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { await new Promise(resolve => server.close(resolve)); store.close(); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const payload = { actorId: 'ULOGAN', assigneeId: 'UALEX', title: 'Try the demo' };
  const options = { method: 'POST', headers: { 'content-type': 'application/json', 'x-relay-demo': '1' }, body: JSON.stringify(payload) };
  assert.equal((await fetch(origin + '/demo/create', { ...options, headers: { ...options.headers, origin: 'https://evil.example' } })).status, 403);
  assert.equal((await fetch(origin + '/demo/create', options)).status, 201);
  assert.equal((await (await fetch(origin + '/demo/tasks')).json()).tasks.length, 1);
});
