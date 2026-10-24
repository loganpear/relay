import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { TaskStore, TaskError, parseTask, labels, formatDue } from './tasks.js';
import { SlackClient, verifySlack, flushOutbox, escapeSlack } from './slack.js';
import { homeRequest, publishTaskHome } from './home.js';
import { handleAppUi, runAppUiEffects } from './ui.js';

const help = 'Create: /task @person Task title --due MM/DD HH:MM AM/PM --details "Requirements or notes"\nThe assignee clicks Mark done; the assigner gets a completion mention in the task thread.\nLists: /tasks mine · /tasks assigned · /tasks team · /tasks all';
const ephemeral = text => ({ response_type: 'ephemeral', text });

export function handleCommand(store, form, receiptKey) {
  const context = { teamId: form.team_id, channelId: form.channel_id, userId: form.user_id };
  if (!context.teamId || !context.channelId || !context.userId) throw new TaskError('Missing Slack workspace, channel, or user.');
  const text = (form.text ?? '').trim();
  if (form.command === '/tasks') {
    const mode = text || 'mine';
    if (!['mine', 'assigned', 'team', 'all'].includes(mode)) return ephemeral(help);
    const tasks = store.list({ ...context, mode, includeDone: mode === 'all' });
    if (!tasks.length) return ephemeral('No matching tasks in this channel. Create one with /task @person Task title.');
    return ephemeral(`*${mode === 'assigned' ? 'Unfinished tasks you assigned' : 'Tasks in this channel'}*\n` + tasks.map(task => `• #${task.id} · ${escapeSlack(task.title)} — *${task.status==='todo'&&task.archivedAt?'Archived':labels[task.status]}* · <@${task.assigneeId}>${task.dueDate ? ` · due ${formatDue(task)}` : ''}`).join('\n') + '\nUse Mark done on each original task card. Showing up to 50 tasks.');
  }
  if (form.command !== '/task') throw new TaskError('Unknown command. Use /task or /tasks.');
  if (!text || text === 'help') return ephemeral(help);
  const task = store.create({ ...context, creatorId: context.userId, ...parseTask(text) }, receiptKey);
  return ephemeral(`Task #${task.id} saved and queued for this channel. If its card doesn’t appear, invite @Relay to the channel and check delivery health.`);
}

export function handleInteraction(store, payload, receiptKey) {
  if (payload.type !== 'block_actions' || payload.actions?.length !== 1) throw new TaskError('Unsupported interaction.');
  const selected = payload.actions[0];
  if (!['task_complete','task_reopen'].includes(selected.action_id)) throw new TaskError('This is an older task button. Use the updated card.');
  let value;
  try { value = JSON.parse(selected.value); } catch { throw new TaskError('Invalid task button.'); }
  if (!Number.isSafeInteger(value.id) || !Number.isSafeInteger(value.version)) throw new TaskError('Invalid task button.');
  return store.transition({ id: value.id, version: value.version, teamId: payload.team?.id,
    channelId: payload.channel?.id, actorId: payload.user?.id,
    action: selected.action_id.slice(5), receiptKey });
}

async function readBody(req) {
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 100_000) throw new TaskError('Request too large.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
function send(res, code, body) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(JSON.stringify(body));
}

export function createApp({ store, secret, teamId, allowedChannelId, client, demo = false }) {
  let flushing = false;
  const flush = async () => {
    if (!client || flushing) return;
    flushing = true;
    try { await flushOutbox(store, client); }
    finally { flushing = false; }
  };
  const server = createServer(async (req, res) => {
    try {
      const path = new URL(req.url, 'http://localhost').pathname;
      if (req.method === 'GET' && path === '/health') return send(res, 200, { ok: true, mode: demo ? 'demo' : 'slack' });
      if (demo && (path === '/' || path.startsWith('/demo/'))) {
        const host = req.headers.host ?? '';
        if (!/^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(host)) return send(res, 403, { error: 'Demo is local only.' });
        if (path === '/' && req.method === 'GET') {
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
            'content-security-policy': "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'" });
          return res.end(await readFile(new URL('../public/index.html', import.meta.url)));
        }
        const context = { teamId: 'TDEMO', channelId: 'CDEMO' };
        if (req.method === 'GET' && path === '/demo/tasks') return send(res, 200, { tasks: store.list({ ...context, includeDone: true }), delivery: 'Local simulation — no Slack messages are sent.' });
        if (req.method === 'GET' && /^\/demo\/history\/\d+$/.test(path)) {
          const id = Number(path.split('/').pop());
          if (!store.get(id, 'TDEMO')) return send(res, 404, { error: 'Task not found.' });
          return send(res, 200, { history: store.history(id) });
        }
        if (req.method !== 'POST' || req.headers['x-relay-demo'] !== '1' || (req.headers.origin && req.headers.origin !== `http://${host}`)) return send(res, 403, { error: 'Use the local demo page.' });
        const input = JSON.parse((await readBody(req)).toString());
        if (!['UALEX', 'ULOGAN', 'USAM'].includes(input.actorId)) throw new TaskError('Choose a demo user.');
        if (path === '/demo/create') {
          if (!['UALEX', 'ULOGAN', 'USAM'].includes(input.assigneeId)) throw new TaskError('Choose an assignee.');
          const task = store.create({ ...context, creatorId: input.actorId,
            ...parseTask(`<@${input.assigneeId}> ${input.title ?? ''}${input.dueDate ? ` --due ${input.dueDate}` : ''}`) });
          return send(res, 201, { task });
        }
        if (path === '/demo/action') return send(res, 200, { task: store.transition({ ...context, id: input.id, actorId: input.actorId, action: input.action, version: input.version, comment: input.comment }) });
        return send(res, 404, { error: 'Not found.' });
      }
      if (req.method !== 'POST' || !['/slack/commands', '/slack/actions', '/slack/events'].includes(path)) return send(res, 404, { error: 'Not found.' });
      if (demo) return send(res, 503, { error: 'Slack is disabled in demo mode.' });
      const raw = await readBody(req);
      if (!verifySlack(raw, req.headers, secret)) return send(res, 401, { error: 'Invalid Slack signature.' });
      if (path === '/slack/events') {
        const payload = JSON.parse(raw.toString());
        if (payload.type === 'url_verification') return send(res, 200, { challenge: payload.challenge });
        const home = homeRequest(teamId, allowedChannelId, payload, true);
        send(res, 200, {});
        if (home && client) void publishTaskHome(client, store, { teamId, channelId: allowedChannelId, ...home }).catch(() => {});
        return;
      }
      const form = Object.fromEntries(new URLSearchParams(raw.toString()));
      const key = createHash('sha256').update(req.headers['x-slack-request-timestamp']).update(raw).digest('hex');
      if (path === '/slack/commands') {
        if (form.team_id !== teamId) return send(res, 403, { error: 'Workspace not configured.' });
        if (allowedChannelId && form.channel_id !== allowedChannelId) return send(res, 200, ephemeral('Relay testing is restricted to the private test channel. No task was created.'));
        try { send(res, 200, handleCommand(store, form, key)); }
        catch (error) { if (!(error instanceof TaskError)) throw error; send(res, 200, ephemeral(error.message)); }
      } else {
        const payload = JSON.parse(form.payload ?? '{}');
        if (payload.team?.id !== teamId) return send(res, 403, { error: 'Workspace not configured.' });
        if (['home','modal'].includes(payload.view?.type) || payload.type === 'view_submission') {
          const ui=handleAppUi(store,{teamId,allowedChannelId},payload,key);
          send(res,200,ui?.ackPayload??{});
          if(ui&&client)void runAppUiEffects(client,store,{teamId,allowedChannelId},ui).catch(()=>{});
          void flush();
          return;
        }
        if (allowedChannelId && payload.channel?.id !== allowedChannelId) return send(res, 200, {});
        try { handleInteraction(store, payload, key); send(res, 200, {}); }
        catch (error) {
          if (!(error instanceof TaskError)) throw error;
          // Return feedback to the actor without publishing it to the channel.
          send(res, 200, {});
          if (payload.channel?.id && payload.user?.id) void client.call('chat.postEphemeral', { channel: payload.channel.id, user: payload.user.id, text: error.message }).catch(() => {});
        }
      }
      void flush();
    } catch (error) {
      if (!res.headersSent) send(res, error instanceof TaskError || error instanceof SyntaxError ? 400 : 500, { error: error instanceof TaskError ? error.message : 'Unable to process request.' });
    }
  });
  const timer = client ? setInterval(() => { void flush(); }, 1500) : null;
  timer?.unref();
  server.on('close', () => clearInterval(timer));
  server.headersTimeout = 10_000;
  server.requestTimeout = 15_000;
  return server;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const demo = process.env.DEMO_MODE === 'true';
  const host = process.env.HOST || '127.0.0.1';
  if (demo && !['localhost', '127.0.0.1', '::1'].includes(host)) throw new Error('Demo must bind to loopback.');
  const secret = process.env.SLACK_SIGNING_SECRET;
  const token = process.env.SLACK_BOT_TOKEN;
  const teamId = process.env.SLACK_TEAM_ID;
  if (!demo && (!secret || !token || !teamId)) throw new Error('Set SLACK_SIGNING_SECRET, SLACK_BOT_TOKEN, and SLACK_TEAM_ID in .env, or run npm run demo.');
  const store = new TaskStore(demo ? './data/demo.sqlite' : (process.env.DATABASE_PATH || './data/relay.sqlite'));
  if (demo && !store.list({ teamId: 'TDEMO', channelId: 'CDEMO', includeDone: true }).length) {
    const base = { teamId: 'TDEMO', channelId: 'CDEMO', creatorId: 'ULOGAN', assigneeId: 'UALEX' };
    store.create({ ...base, title: 'Polish the landing page' });
    store.create({ ...base, assigneeId: 'USAM', title: 'Check the mobile onboarding flow' });
  }
  const server = createApp({ store, secret, teamId, allowedChannelId: process.env.SLACK_ALLOWED_CHANNEL_ID, client: demo ? null : new SlackClient(token), demo });
  server.listen(Number(process.env.PORT || 3000), host, () => console.log(`Relay ${demo ? 'local demo' : 'Slack service'} running at http://${host}:${process.env.PORT || 3000}`));
  const shutdown = () => server.close(() => { store.close(); process.exit(0); });
  process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
}
