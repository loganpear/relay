import test from 'node:test';
import assert from 'node:assert/strict';
import { TaskStore } from '../src/tasks.js';
import { taskHome, homeRequest, publishTaskHome } from '../src/home.js';
import { handleEnvelope } from '../src/socket.js';

const base = { teamId: 'TTEST', channelId: 'CTEST', title: 'Visible task', assigneeId: 'UME', creatorId: 'UOTHER' };
const context = { teamId: 'TTEST', channelId: 'CTEST', userId: 'UME' };
const table = view => view.blocks.find(block => block.type === 'table');
const action = (id = 'home_assigned', value = { mode: 'assigned', page: 0 }) => ({ type: 'block_actions', team: { id: 'TTEST' }, user: { id: 'UME' }, view: { type: 'home' }, actions: [{ action_id: id, value: JSON.stringify(value) }] });

test('Home has two clearly named buttons and shows both statuses in a private personal table', () => {
  const store = new TaskStore();
  const done = store.create({ ...base, title: 'Finished work' });
  store.transition({ id: done.id, teamId: 'TTEST', channelId: 'CTEST', actorId: 'UME', action: 'complete' });
  store.create({ ...base, title: 'Open work' });
  store.create({ ...base, teamId: 'TOTHER', title: 'Wrong workspace' });
  store.create({ ...base, channelId: 'COTHER', title: 'Wrong channel' });
  store.create({ ...base, assigneeId: 'USTRANGER', title: 'Someone else’s task' });
  const view = taskHome(store, context);
  const buttons = view.blocks.find(block => block.type === 'actions').elements;
  assert.deepEqual(buttons.map(button => button.text.text), ['Show tasks assigned to me', 'Show tasks I’ve assigned to others']);
  assert.equal(table(view).rows.length, 3);
  assert.equal(table(view).rows[1][2].text, 'To do');
  assert.equal(table(view).rows[2][2].text, 'Done');
  assert.equal(table(view).rows[0][1].text, 'Assigned by');
  assert.doesNotMatch(JSON.stringify(view), /Wrong workspace|Wrong channel|Someone else/);
  store.close();
});

test('Assigned to others excludes self-assigned work and other creators', () => {
  const store = new TaskStore();
  store.create({ ...base, creatorId: 'UME', assigneeId: 'UOTHER', title: 'Handed off' });
  store.create({ ...base, creatorId: 'UME', title: 'Self assigned' });
  store.create({ ...base, title: 'Someone else assigned this' });
  const view = taskHome(store, { ...context, mode: 'assigned' });
  assert.equal(table(view).rows.length, 2);
  assert.equal(table(view).rows[0][1].text, 'Assigned to');
  assert.match(JSON.stringify(view), /Handed off/);
  assert.doesNotMatch(JSON.stringify(view), /Self assigned|Someone else assigned this/);
  assert.equal(table(view).rows[1][1].elements[0].elements[0].user_id, 'UOTHER');
  store.close();
});

test('Home handles empty results, paginates beyond 20 tasks, and clamps invalid offsets', () => {
  const store = new TaskStore();
  assert.equal(table(taskHome(store, context)), undefined);
  for (let i = 0; i < 25; i++) store.create({ ...base, title: `Task ${i}` });
  const first = taskHome(store, context);
  assert.equal(table(first).rows.length, 21);
  const next = first.blocks.flatMap(block => block.elements ?? []).find(element => element.action_id === 'home_next');
  assert.deepEqual(JSON.parse(next.value), { mode: 'mine', page: 1 });
  const second = taskHome(store, { ...context, page: 999999 });
  assert.equal(table(second).rows.length, 6);
  assert.equal(store.personalPage({ ...context, direction: 'mine', page: -1 }).page, 0);
  assert.throws(() => store.personalPage({ ...context, direction: 'unsafe SQL' }));
  store.close();
});

test('Home refresh uses the authenticated actor, rejects cross-workspace and non-Home actions', () => {
  assert.deepEqual(homeRequest('TTEST', 'CTEST', action('home_assigned', { mode: 'assigned', page: 0, userId: 'USTRANGER' })), { userId: 'UME', mode: 'assigned', page: 0 });
  const wrong = action(); wrong.team.id = 'TOTHER';
  assert.equal(homeRequest('TTEST', 'CTEST', wrong), null);
  const channel = action(); delete channel.view;
  assert.equal(homeRequest('TTEST', 'CTEST', channel), null);
  assert.throws(() => homeRequest('TTEST', 'CTEST', action('home_next', { mode: 'mine', page: -1 })));
  assert.throws(() => homeRequest('TTEST', 'CTEST', action('home_next', { mode: 'other', page: 0 })));
});

test('Socket Mode acknowledges App Home events and private button actions without requiring a channel in the payload', () => {
  const store = new TaskStore(); const config = { store, teamId: 'TTEST', allowedChannelId: 'CTEST' };
  const opened = { envelope_id: 'home-event', type: 'events_api', payload: { team_id: 'TTEST', event: { type: 'app_home_opened', user: 'UME', tab: 'home' } } };
  assert.deepEqual(handleEnvelope(config, opened), { ack: { envelope_id: 'home-event' }, home: { userId: 'UME', mode: 'mine', page: 0 } });
  opened.payload.event.tab = 'messages';
  assert.equal(handleEnvelope(config, opened).home, undefined);
  const clicked = handleEnvelope(config, { envelope_id: 'home-button', type: 'interactive', payload: action() });
  assert.equal(clicked.home.mode, 'assigned');
  assert.equal(clicked.home.userId, 'UME');
  store.close();
});

test('Home publishes only to the requesting user and keeps task titles as plain text', async () => {
  const store = new TaskStore(); store.create({ ...base, title: '<!channel> *not markup*' });
  let call;
  await publishTaskHome({ call: async (method, args) => { call = { method, args }; } }, store, context);
  assert.equal(call.method, 'views.publish');
  assert.equal(call.args.user_id, 'UME');
  assert.equal(table(call.args.view).rows[1][0].type, 'raw_text');
  assert.match(table(call.args.view).rows[1][0].text, /<!channel>/);
  store.close();
});
