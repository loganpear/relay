import test from 'node:test';
import assert from 'node:assert/strict';
import { TaskStore } from '../src/tasks.js';
import { publishTaskHome, refreshStaleHomes, homeState, shorten, taskHome } from '../src/home.js';
import { handleAppUi, runAppUiEffects } from '../src/ui.js';

const config = { teamId: 'TTEST' };
// A fake Slack client that records each Home published and for whom.
function slack() {
  const published = [];
  return { published, call: async (method, payload) => { if (method === 'views.publish') published.push({ userId: payload.user_id, view: payload.view }); return { ok: true }; } };
}

test('a change refreshes the other person’s open Home in place, without overwriting the actor’s notice', async () => {
  const store = new TaskStore(), client = slack();
  let task = store.create({ teamId: 'TTEST', title: 'Shared work', creatorId: 'UME', assigneeId: 'UOTHER' });
  // Both people have Home open; the assignee is looking at Past.
  await publishTaskHome(client, store, { teamId: 'TTEST', userId: 'UME' });
  await publishTaskHome(client, store, { teamId: 'TTEST', userId: 'UOTHER', period: 'past' });
  assert.equal(store.staleHomes.size, 0);
  client.published.length = 0;
  // The assigner archives from Home: their Home gets the result now, the assignee's on the next refresh.
  const payload = { type: 'block_actions', team: { id: 'TTEST' }, user: { id: 'UME' }, view: { type: 'home', private_metadata: JSON.stringify(homeState()) },
    actions: [{ action_id: `ui_archive:assigned:${task.id}`, value: JSON.stringify({ id: task.id, version: task.version }) }] };
  await runAppUiEffects(client, store, config, handleAppUi(store, config, payload, 'archive'));
  await refreshStaleHomes(client, store);
  assert.deepEqual(client.published.map(p => p.userId), ['UME', 'UOTHER']);
  assert.equal(JSON.parse(client.published[1].view.private_metadata).period, 'past');
  assert.equal(store.staleHomes.size, 0); store.close();
});

test('card clicks and reassignments refresh everyone involved who has Home open, and nobody else', async () => {
  const store = new TaskStore(), client = slack();
  let task = store.create({ teamId: 'TTEST', channelId: 'CTEST', title: 'Card work', creatorId: 'UME', assigneeId: 'UOTHER' });
  for (const userId of ['UME', 'UOTHER', 'UNEW']) await publishTaskHome(client, store, { teamId: 'TTEST', userId });
  client.published.length = 0;
  task = store.transition({ id: task.id, teamId: 'TTEST', channelId: 'CTEST', actorId: 'UOTHER', action: 'complete', version: task.version });
  await refreshStaleHomes(client, store);
  assert.deepEqual(client.published.map(p => p.userId).sort(), ['UME', 'UOTHER']);
  client.published.length = 0;
  store.manage({ id: task.id, teamId: 'TTEST', actorId: 'UME', version: task.version, action: 'edit', changes: { title: task.title, assigneeId: 'UNEW' } });
  store.create({ teamId: 'TTEST', title: 'Never opened Home', creatorId: 'UME', assigneeId: 'USTRANGER' });
  await refreshStaleHomes(client, store);
  assert.deepEqual(client.published.map(p => p.userId).sort(), ['UME', 'UNEW', 'UOTHER']);
  store.close();
});

test('long task names are shortened between whole characters, never through an emoji', () => {
  const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
  for (let pad = 60; pad < 80; pad++) {
    const label = shorten('x'.repeat(pad) + '🎉👩‍💻 party time');
    assert.ok(label.length <= 75); assert.doesNotMatch(label, lone);
  }
  assert.equal(shorten('Short name'), 'Short name');
  const store = new TaskStore(); store.create({ teamId: 'TTEST', title: 'x'.repeat(66) + '🎉 party', creatorId: 'UME', assigneeId: 'UME' });
  const label = taskHome(store, { teamId: 'TTEST', userId: 'UME' }).blocks.find(b => b.type === 'data_table').rows[1][0].element.text.text;
  assert.match(label, /x…$/); store.close();
});
