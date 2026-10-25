import test from 'node:test';
import assert from 'node:assert/strict';
import { TaskStore } from '../src/tasks.js';
import { SlackClient, flushOutbox } from '../src/slack.js';
import { handleEnvelope } from '../src/socket.js';

const base = { teamId: 'TTEST', title: 'No card needed', assigneeId: 'UASSIGNEE', creatorId: 'UCREATOR' };
// A fake Slack that records calls and answers each method with `reply(method, body)`, or ok with a fresh ts.
function slack(reply = () => null) {
  const calls = [];
  const client = new SlackClient('test', async (url, options) => {
    const method = url.split('/').pop(), body = JSON.parse(options.body);
    calls.push({ method, body });
    const error = reply(method, body);
    return { ok: true, status: 200, json: async () => error ? { ok: false, error } : { ok: true, ts: body.ts ?? `9.${calls.length}` } };
  });
  return { client, calls, posts: () => calls.filter(c => c.method === 'chat.postMessage') };
}
const complete = (store, task) => store.transition({ id: task.id, teamId: 'TTEST', actorId: task.assigneeId, action: 'complete', version: store.get(task.id, 'TTEST').version });
const flush = async (store, client) => { await flushOutbox(store, client); await flushOutbox(store, client); };

test('Home tasks post no card and reach people by DM, never notifying someone about their own task', async () => {
  const store = new TaskStore(), { client, posts } = slack();
  const task = store.create(base); store.create({ ...base, assigneeId: 'UCREATOR', title: 'Self assigned' });
  assert.equal(task.channelId, null); assert.equal(store.pending().length, 0);
  await flush(store, client);
  assert.equal(posts().length, 1);
  assert.equal(posts()[0].body.channel, 'UASSIGNEE'); assert.equal(posts()[0].body.thread_ts, undefined);
  assert.match(posts()[0].body.text, /^<@UCREATOR> assigned task #1 to you\./);
  complete(store, task); await flush(store, client);
  assert.equal(posts()[1].body.channel, 'UCREATOR');
  assert.match(posts()[1].body.text, /^<@UASSIGNEE> marked task #1 Done\./);
  complete(store, store.get(2, 'TTEST')); await flush(store, client);
  assert.equal(posts().length, 2); store.close();
});

test('a /task card Relay cannot post is dropped and the assignee gets a DM instead', async () => {
  const store = new TaskStore(), { client, posts } = slack((method, body) => body.channel === 'CPRIVATE' ? 'not_in_channel' : null);
  const task = store.create({ ...base, channelId: 'CPRIVATE' });
  await flush(store, client);
  assert.equal(store.get(task.id, 'TTEST').channelId, null); assert.equal(store.pending().length, 0);
  assert.deepEqual(posts().map(p => p.body.channel), ['CPRIVATE', 'UASSIGNEE']);
  complete(store, task); await flush(store, client);
  assert.equal(posts().at(-1).body.channel, 'UCREATOR'); store.close();
});

test('a deleted card stops being referenced and later mentions go by DM without endless retries', async () => {
  let deleted = false;
  const store = new TaskStore(), { client, calls, posts } = slack(method => deleted && method === 'chat.update' ? 'message_not_found' : null);
  const task = store.create({ ...base, channelId: 'CTEST' });
  await flush(store, client);
  assert.equal(store.get(task.id, 'TTEST').messageTs, '9.1');
  deleted = true; complete(store, task); await flush(store, client);
  const saved = store.get(task.id, 'TTEST');
  assert.equal(saved.status, 'done'); assert.equal(saved.channelId, null); assert.equal(saved.messageTs, null);
  assert.equal(calls.filter(c => c.method === 'chat.update').length, 1);
  assert.equal(posts().at(-1).body.channel, 'UCREATOR'); assert.equal(posts().at(-1).body.thread_ts, undefined);
  assert.equal(store.pending().length, 0); assert.equal(store.pendingNotifications().length, 0); store.close();
});

test('a DM that can never be delivered is kept with its error but not retried', async () => {
  const store = new TaskStore(), { client, posts } = slack(() => 'user_not_found');
  store.create(base);
  await flush(store, client); await flush(store, client);
  assert.equal(posts().length, 1);
  assert.equal(store.db.prepare('SELECT error FROM completion_notifications').get().error, 'user_not_found');
  assert.equal(store.pendingNotifications().length, 0); store.close();
});

test('without a test lock, /task works in any channel and its card lives there; the lock still restricts when set', () => {
  const store = new TaskStore();
  const command = (channel, id) => ({ envelope_id: id, type: 'slash_commands', accepts_response_payload: true,
    payload: { team_id: 'TTEST', channel_id: channel, user_id: 'UCREATOR', command: '/task', text: '<@UASSIGNEE> Anywhere task' } });
  assert.match(handleEnvelope({ store, teamId: 'TTEST' }, command('CGENERAL', 'open')).ack.payload.text, /saved/);
  assert.equal(store.get(1, 'TTEST').channelId, 'CGENERAL'); assert.equal(store.pending().length, 1);
  assert.match(handleEnvelope({ store, teamId: 'TTEST', allowedChannelId: 'CTEST' }, command('CGENERAL', 'locked')).ack.payload.text, /restricted/);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM tasks').get().n, 1); store.close();
});
