import { createHmac, timingSafeEqual } from 'node:crypto';
import { labels, isTaskArchived, formatDue, dueTimezoneLabel } from './tasks.js';

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
  if (!task.deletedAt && task.status==='todo' && !task.archivedAt) choices.push(['complete', 'Mark done']);
  const blocks = [
    { type: 'header', text: { type: 'plain_text', text: `Relay · Task #${task.id}` } },
    { type: 'section', text: { type: 'plain_text', text: task.title } },
    { type: 'section', fields: [
      { type: 'mrkdwn', text: `*Status*\n${labels[task.status]}` },
      { type: 'mrkdwn', text: `*Archived*\n${isTaskArchived(task)?'Archived':'Active'}` },
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
  blocks.push({ type: 'context', elements: [{ type: 'plain_text', text: task.deletedAt ? 'Relay · Archived. The assigner can move it to Current again.' : task.status==='todo'&&task.archivedAt?'Relay · Archived. Work is no longer required. The assigner can move it to Current to reactivate it.':task.status === 'done' ? 'Relay · Done. The assigner can send it back to To do from Relay Home.' : 'Relay · The assignee marks this done. The assigner gets a completion mention in this task’s thread.' }] });
  return { text: `Task #${task.id}: ${task.title} — ${labels[task.status]}${isTaskArchived(task)?' · Archived':''}`, blocks };
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
    return this.mention(task, task.creatorId, task.assigneeId, `marked task #${task.id} *Done*.`);
  }
  async notifySentBack(task) {
    return this.mention(task, task.assigneeId, task.creatorId, `sent task #${task.id} back to *To do*.`);
  }
  async notifyAssigned(task) {
    return this.mention(task, task.assigneeId, task.creatorId, `assigned task #${task.id} to you.`);
  }
  // Replies in the task card's thread when there is one; otherwise DMs the recipient from Relay.
  async mention(task, recipientId, actorId, change) {
    const lead = task.messageTs ? `<@${recipientId}> — <@${actorId}>` : `<@${actorId}>`;
    const result = await this.call('chat.postMessage', {
      ...(task.messageTs ? { channel: task.channelId, thread_ts: task.messageTs, reply_broadcast: false } : { channel: recipientId }),
      text: `${lead} ${change.replaceAll('*', '')} ${escapeSlack(task.title)}`,
      blocks: [
        { type: 'section', text: { type: 'mrkdwn', text: `${lead} ${change}` } },
        { type: 'section', text: { type: 'plain_text', text: task.title } }
      ], unfurl_links: false, unfurl_media: false
    });
    return result.ts;
  }
}

// Slack errors meaning the card can never be posted or updated (deleted, or Relay can't post there).
const lostCard = new Set(['message_not_found', 'cant_update_message', 'edit_window_closed', 'channel_not_found', 'not_in_channel', 'is_archived', 'restricted_action', 'thread_not_found']);
// Slack errors meaning a DM can never reach the person.
const unreachableUser = new Set(['user_not_found', 'user_disabled', 'account_inactive', 'cannot_dm_bot', 'channel_not_found', 'not_in_channel', 'restricted_action']);

export async function flushOutbox(store, client) {
  for (const item of store.pending()) {
    const task = store.get(item.taskId, item.teamId);
    try { store.delivered(task, await client.deliver(task)); }
    catch (error) {
      if (lostCard.has(error.message)) store.detachCard(task.id);
      else store.deliveryFailed(task.id, error.message, error.retryAfter);
    }
  }
  for (const task of store.pendingNotifications()) {
    try { store.notificationDelivered(task.notificationId, await (task.kind === 'reopen' ? client.notifySentBack(task) : task.kind === 'assign' ? client.notifyAssigned(task) : client.notifyCompletion(task))); }
    catch (error) {
      // A lost thread falls back to a DM on the next flush; an unreachable person is not retried.
      if (task.messageTs && lostCard.has(error.message)) store.detachCard(task.id);
      else if (!task.messageTs && unreachableUser.has(error.message)) store.notificationDropped(task.notificationId, error.message);
      else store.notificationFailed(task.notificationId, error.message, error.retryAfter);
    }
  }
}
