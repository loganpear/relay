import { createHmac, timingSafeEqual } from 'node:crypto';
import { labels, formatDue, dueTimezoneLabel } from './tasks.js';

export function verifySlack(raw, headers, secret, now = Date.now()) {
  const timestamp = headers['x-slack-request-timestamp'];
  const signature = headers['x-slack-signature'];
  if (!secret || !/^\d+$/.test(timestamp ?? '') || Math.abs(now / 1000 - Number(timestamp)) > 300 || !/^v0=[a-f0-9]{64}$/.test(signature ?? '')) return false;
  const expected = 'v0=' + createHmac('sha256', secret).update(`v0:${timestamp}:`).update(raw).digest('hex');
  return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}
export const escapeSlack = text => String(text).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

export function taskMessage(task) {
  const choices = [];
  if (!task.deletedAt) choices.push(task.status === 'todo' ? ['complete', 'Mark done'] : ['reopen', 'Reopen']);
  const blocks = [
    { type: 'header', text: { type: 'plain_text', text: `Relay · Task #${task.id}` } },
    { type: 'section', text: { type: 'plain_text', text: task.title } },
    { type: 'section', fields: [
      { type: 'mrkdwn', text: `*Status*\n${task.deletedAt ? 'Deleted' : labels[task.status]}` },
      { type: 'mrkdwn', text: `*Assigned to*\n<@${task.assigneeId}>` },
      { type: 'mrkdwn', text: `*Assigned by*\n<@${task.creatorId}>` },
      { type: 'mrkdwn', text: `*Due*\n${task.dueDate ? formatDue(task)+' ('+dueTimezoneLabel+')' : 'No deadline'}` }
    ] }
  ];
  if (choices.length) blocks.push({ type: 'actions', elements: choices.map(([action, text]) => ({
    type: 'button', action_id: `task_${action}`, text: { type: 'plain_text', text },
    value: JSON.stringify({ id: task.id, version: task.version }),
    ...(action === 'complete' ? { style: 'primary' } : {})
  })) });
  blocks.push({ type: 'context', elements: [{ type: 'plain_text', text: task.deletedAt ? 'Relay · Deleted.' : task.status === 'done' ? 'Relay · Done. Only the assignee can reopen it.' : 'Relay · The assignee marks this done. The assigner gets a completion mention in this task’s thread.' }] });
  return { text: `Task #${task.id}: ${task.title} — ${task.deletedAt ? 'Deleted' : labels[task.status]}`, blocks };
}

export class SlackClient {
  constructor(token, fetcher = fetch) { this.token = token; this.fetcher = fetcher; }
  async call(method, payload) {
    const response = await this.fetcher(`https://slack.com/api/${method}`, {
      method: 'POST', headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(payload), signal: AbortSignal.timeout(8000)
    });
    if (response.status === 429) {
      const error = new Error('Slack rate limited delivery');
      error.retryAfter = Math.max(1000, Number(response.headers.get('retry-after') ?? 1) * 1000);
      throw error;
    }
    const body = await response.json();
    if (!response.ok || !body.ok) throw new Error(body.error ?? `Slack HTTP ${response.status}`);
    return body;
  }
  async deliver(task) {
    const message = taskMessage(task);
    const method = task.messageTs ? 'chat.update' : 'chat.postMessage';
    const result = await this.call(method, { channel: task.channelId, ...message,
      ...(task.messageTs ? { ts: task.messageTs } : {}),
      unfurl_links: false, unfurl_media: false });
    return result.ts;
  }
  async notifyCompletion(task) {
    const result = await this.call('chat.postMessage', {
      channel: task.channelId, thread_ts: task.messageTs, reply_broadcast: false,
      text: `<@${task.creatorId}> — <@${task.assigneeId}> marked task #${task.id} done: ${escapeSlack(task.title)}`,
      blocks: [
        { type: 'section', text: { type: 'mrkdwn', text: `<@${task.creatorId}> — <@${task.assigneeId}> marked task #${task.id} *Done*.` } },
        { type: 'section', text: { type: 'plain_text', text: task.title } }
      ], unfurl_links: false, unfurl_media: false
    });
    return result.ts;
  }
}

export async function flushOutbox(store, client) {
  for (const item of store.pending()) {
    const task = store.get(item.taskId, item.teamId);
    try { store.delivered(task, await client.deliver(task)); }
    catch (error) { store.deliveryFailed(task.id, error.message, error.retryAfter); }
  }
  for (const task of store.pendingNotifications()) {
    try { store.notificationDelivered(task.notificationId, await client.notifyCompletion(task)); }
    catch (error) { store.notificationFailed(task.notificationId, error.message, error.retryAfter); }
  }
}
