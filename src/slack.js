import { createHmac, timingSafeEqual } from 'node:crypto';
import { labels } from './tasks.js';

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
  if (task.status === 'todo') choices.push(['start', 'Start task']);
  if (['todo', 'in_progress'].includes(task.status)) choices.push(task.requiresReview ? ['ready', 'Ready for review'] : ['complete', 'Complete']);
  if (task.status === 'review') choices.push(['approve', 'Approve & complete'], ['changes', 'Request changes']);
  const blocks = [
    { type: 'header', text: { type: 'plain_text', text: `Relay · Task #${task.id}` } },
    { type: 'section', text: { type: 'plain_text', text: task.title } },
    { type: 'section', fields: [
      { type: 'mrkdwn', text: `*Status*\n${labels[task.status]}` },
      { type: 'mrkdwn', text: `*Assigned to*\n<@${task.assigneeId}>` },
      { type: 'mrkdwn', text: `*${task.requiresReview ? 'Reviewer' : 'Created by'}*\n<@${task.creatorId}>` },
      { type: 'mrkdwn', text: `*Due*\n${task.dueDate ?? 'No deadline'}` }
    ] }
  ];
  if (task.lastComment) blocks.push({ type: 'section', text: { type: 'plain_text', text: `Review note: ${task.lastComment}` } });
  if (choices.length) blocks.push({ type: 'actions', elements: choices.map(([action, text]) => ({
    type: 'button', action_id: `task_${action}`, text: { type: 'plain_text', text },
    value: JSON.stringify({ id: task.id, version: task.version }),
    ...(action === 'approve' || action === 'complete' ? { style: 'primary' } : {})
  })) });
  blocks.push({ type: 'context', elements: [{ type: 'plain_text', text: task.status === 'review' ? 'Waiting for the task creator. Add feedback with /task changes ID Your note.' : 'Relay · Tasks stay open until completed. /tasks mine shows your work.' }] });
  return { text: `Task #${task.id}: ${task.title} — ${labels[task.status]}`, blocks };
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
}

export async function flushOutbox(store, client) {
  for (const item of store.pending()) {
    const task = store.get(item.taskId, item.teamId);
    try { store.delivered(task, await client.deliver(task)); }
    catch (error) { store.deliveryFailed(task.id, error.message, error.retryAfter); }
  }
}
