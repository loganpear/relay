import { fileURLToPath } from 'node:url';
import { TaskStore, TaskError } from './tasks.js';
import { SlackClient, flushOutbox } from './slack.js';
import { handleCommand, handleInteraction } from './server.js';
import { homeRequest, publishTaskHome } from './home.js';
import { handleAppUi, runAppUiEffects } from './ui.js';

export function handleEnvelope({ store, teamId, allowedChannelId }, envelope) {
  const ack = { envelope_id: envelope.envelope_id };
  const payload = envelope.payload;
  if (!envelope.envelope_id || !payload) return { ack };
  if (envelope.type === 'events_api') {
    const home = homeRequest(teamId, allowedChannelId, payload, true);
    return { ack, ...(home ? { home } : {}) };
  }
  if (envelope.type === 'interactive' && (['home','modal'].includes(payload.view?.type) || payload.type === 'view_submission')) {
    try {
      const ui = handleAppUi(store,{teamId,allowedChannelId},payload,`socket:${envelope.envelope_id}`);
      if (ui?.ackPayload && envelope.accepts_response_payload) ack.payload=ui.ackPayload;
      return {ack,...(ui?.home?{home:ui.home}:{}),...(ui?.openModal?{openModal:ui.openModal}:{}),...(ui?.updateModal?{updateModal:ui.updateModal}:{})};
    } catch { return { ack }; }
  }
  const actualTeam = envelope.type === 'slash_commands' ? payload.team_id : payload.team?.id;
  const actualChannel = envelope.type === 'slash_commands' ? payload.channel_id : payload.channel?.id;
  if (actualTeam !== teamId || actualChannel !== allowedChannelId) {
    if (envelope.accepts_response_payload && envelope.type === 'slash_commands') ack.payload = { response_type: 'ephemeral', text: 'Relay testing is restricted to the private test channel. No task was created.' };
    return { ack };
  }
  try {
    const receiptKey = `socket:${envelope.envelope_id}`;
    if (envelope.type === 'slash_commands') ack.payload = handleCommand(store, payload, receiptKey);
    else if (envelope.type === 'interactive') handleInteraction(store, payload, receiptKey);
    return { ack };
  } catch (error) {
    const text = error instanceof TaskError ? error.message : 'Relay could not process this request. Please try again.';
    if (envelope.type === 'slash_commands' && envelope.accepts_response_payload) {
      ack.payload = { response_type: 'ephemeral', text };
      return { ack };
    }
    return { ack, feedback: { channel: actualChannel, user: payload.user?.id, text } };
  }
}

export function startSocket({ store, client, appToken, teamId, allowedChannelId, WebSocketImpl = WebSocket, fetcher = fetch, logger = console }) {
  if (!appToken || !teamId || !allowedChannelId) throw new Error('Socket testing requires app token, workspace ID, and private channel ID.');
  let socket, reconnectTimer, stopped = false, flushing = false, attempts = 0, ready = false;
  const flush = async () => {
    if (flushing || stopped) return;
    flushing = true;
    try { await flushOutbox(store, client); }
    catch { logger.error('Relay delivery queue failed; it will retry.'); }
    finally { flushing = false; }
  };
  const retry = () => {
    ready = false;
    if (stopped || reconnectTimer) return;
    reconnectTimer = setTimeout(() => { reconnectTimer = null; void connect(); }, Math.min(30000, 1000 * 2 ** Math.min(attempts++, 5)));
  };
  const connect = async () => {
    if (stopped) return;
    try {
      const response = await fetcher('https://slack.com/api/apps.connections.open', {
        method: 'POST', headers: { authorization: `Bearer ${appToken}`, 'content-type': 'application/json' },
        body: '{}', signal: AbortSignal.timeout(10000)
      });
      const body = await response.json();
      if (!response.ok || !body.ok || typeof body.url !== 'string') throw new Error('connection_failed');
      const url = new URL(body.url);
      if (url.protocol !== 'wss:' || !url.hostname.endsWith('.slack.com')) throw new Error('invalid_socket_url');
      if (stopped) return;
      const current = new WebSocketImpl(url.href);
      socket = current;
      const openTimeout = setTimeout(() => { if (!ready) { current.close(); retry(); } }, 15000);
      current.addEventListener('message', event => {
        if (stopped || current !== socket) return;
        try {
          const envelope = JSON.parse(String(event.data));
          if (envelope.type === 'hello') {
            clearTimeout(openTimeout); ready = true; attempts = 0;
            logger.log('Relay connected to Slack. Testing is restricted to the configured private channel.');
            void flush(); return;
          }
          if (envelope.type === 'disconnect') { current.close(); retry(); return; }
          if (!envelope.envelope_id) return;
          const { ack, feedback, home, openModal, updateModal } = handleEnvelope({ store, teamId, allowedChannelId }, envelope);
          current.send(JSON.stringify(ack));
          if (home || openModal || updateModal) void runAppUiEffects(client,store,{teamId,allowedChannelId},{home,openModal,updateModal}).catch(() => logger.error('Relay could not refresh Home. Use Refresh or reopen Home.'));
          if (feedback?.user) void client.call('chat.postEphemeral', feedback).catch(() => {});
          void flush();
        } catch { logger.error('Relay could not process a socket event.'); }
      });
      current.addEventListener('close', () => { clearTimeout(openTimeout); if (current === socket) retry(); });
      current.addEventListener('error', () => { clearTimeout(openTimeout); current.close(); if (current === socket) retry(); });
    } catch { logger.error('Slack connection unavailable; retrying shortly.'); retry(); }
  };
  const queueTimer = setInterval(() => { if (ready) void flush(); }, 1500);
  void connect();
  return { stop() { stopped = true; clearInterval(queueTimer); clearTimeout(reconnectTimer); socket?.close(); } };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { SLACK_BOT_TOKEN: token, SLACK_APP_TOKEN: appToken, SLACK_TEAM_ID: teamId, SLACK_ALLOWED_CHANNEL_ID: allowedChannelId } = process.env;
  if (!token || !appToken || !teamId || !allowedChannelId) throw new Error('Set Slack bot/app tokens, workspace ID, and private channel ID in .env.');
  const store = new TaskStore(process.env.DATABASE_PATH || './data/relay.sqlite');
  const runner = startSocket({ store, client: new SlackClient(token), appToken, teamId, allowedChannelId });
  // Let an in-flight Slack delivery finish before closing the database.
  const shutdown = () => { runner.stop(); setTimeout(() => { store.close(); process.exit(0); }, 9000).unref(); };
  process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
}
