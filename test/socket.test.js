import test from 'node:test';
import assert from 'node:assert/strict';
import { TaskStore } from '../src/tasks.js';
import { handleEnvelope } from '../src/socket.js';

const command = (channel = 'CTEST', team = 'TTEST') => ({
  envelope_id: 'test-envelope', type: 'slash_commands', accepts_response_payload: true,
  payload: { team_id: team, channel_id: channel, user_id: 'UCREATOR', command: '/task', text: '<@UASSIGNEE> Test socket task' }
});
test('Socket Mode acknowledges commands, persists them, and deduplicates retries', () => {
  const store = new TaskStore(); const context = { store, teamId: 'TTEST', allowedChannelId: 'CTEST' };
  const result = handleEnvelope(context, command());
  assert.equal(result.ack.envelope_id, 'test-envelope');
  assert.match(result.ack.payload.text, /saved/);
  handleEnvelope(context, command());
  assert.equal(store.list({ teamId: 'TTEST', channelId: 'CTEST' }).length, 1);
  store.close();
});
test('Socket Mode ignores events outside the private workspace/channel', () => {
  const store = new TaskStore(); const context = { store, teamId: 'TTEST', allowedChannelId: 'CTEST' };
  assert.match(handleEnvelope(context, command('CGENERAL')).ack.payload.text, /restricted/);
  assert.match(handleEnvelope(context, command('CTEST', 'TOTHER')).ack.payload.text, /restricted/);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM tasks').get().n, 0);
  store.close();
});
test('Socket Mode buttons use the same authorization and version checks', () => {
  const store = new TaskStore(); const context = { store, teamId: 'TTEST', allowedChannelId: 'CTEST' };
  handleEnvelope(context, command());
  const event = { envelope_id: 'button-1', type: 'interactive', payload: { type: 'block_actions', team: { id: 'TTEST' }, channel: { id: 'CTEST' }, user: { id: 'USTRANGER' }, actions: [{ action_id: 'task_complete', value: JSON.stringify({ id: 1, version: 0 }) }] } };
  const result = handleEnvelope(context, event);
  assert.match(result.feedback.text, /unavailable/);
  assert.equal(store.get(1, 'TTEST').status, 'todo');
  event.envelope_id = 'button-2'; event.payload.user.id = 'UASSIGNEE';
  assert.equal(handleEnvelope(context, event).feedback, undefined);
  assert.equal(store.get(1, 'TTEST').status, 'done');
  store.close();
});
