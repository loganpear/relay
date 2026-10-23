# Relay

A small task manager inside Slack. Assign work, send it for review, and sign it off without introducing another daily app.

## Run the local preview

Requires Node.js 24 or newer; there are no third-party packages to install.

```sh
npm run demo
```

Open http://127.0.0.1:3000. Switch between Logan, Alex, and Sam to try the permissions and review flow. Demo records persist in `data/demo.sqlite`. This preview never sends Slack messages, and its routes are disabled in Slack mode. It binds only to loopback.

```sh
npm test
```

## Slack commands

```text
/task @alex Polish the landing page --due 2026-11-06
/task @sam Update the team links --no-review
/tasks mine
/tasks team
/tasks review
/tasks all
/task changes 12 Please check the mobile spacing
```

Select the assignee from Slack's mention suggestions. Dates use explicit YYYY-MM-DD; natural-language dates are not interpreted. Review is required unless `--no-review` is supplied. The creator is the reviewer, including for self-assigned tasks.

| State | Available action | Who can act |
| --- | --- | --- |
| To do | Start | Assignee |
| To do / In progress | Ready for review | Assignee, when review is required |
| To do / In progress | Complete | Assignee, when review is not required |
| Ready for review | Approve & complete | Creator |
| Ready for review | Request changes | Creator |

Request changes returns work to In progress. The card button can request changes without a note; `/task changes ID Your feedback` adds a note. Lists are private to the person requesting them, limited to the current channel, and show up to 50 tasks. Completed tasks appear in `/tasks all`. The persistent task card is updated in place.

## Connect a Slack developer sandbox

### Local testing with Socket Mode

For local Slack testing, add your bot token and app-level token to a private `.env` file (`SLACK_BOT_TOKEN` and `SLACK_APP_TOKEN`). Set `SLACK_TEAM_ID` and `SLACK_ALLOWED_CHANNEL_ID` to your workspace and private test channel IDs. Run `npm run socket`. Socket Mode does not need a public HTTPS host or signing secret. The app must enable interactivity and declare `/task` and `/tasks`. This process needs to remain running for commands to work and reconnects when Slack refreshes its connection.

`slack-manifest.socket.json` is the matching Socket Mode app configuration; the HTTP manifest remains available for later hosted deployment. Do not run both delivery workers against the same database simultaneously.

### Hosted testing with HTTP

1. Provision your developer sandbox using the Handshake mission's instructions.
2. Host this service behind HTTPS on a persistent Node 24 server with a writable disk. Set `HOST=0.0.0.0` for a hosted container and `DEMO_MODE=false`. No demo routes are exposed in this mode.
3. Replace every `https://YOUR_HOST` value in `slack-manifest.json` with your HTTPS origin. Create a Slack app from this manifest inside the sandbox.
4. Upload an app icon in Slack's Basic Information page. The manifest supplies the name, description, and background color.
5. Install the app to the sandbox. It requests `commands` and `chat:write`: it does not read channel history or the user directory.
6. Copy `.env.example` to `.env`. Privately set the app's signing secret, bot token, and installed workspace ID. Never commit or share these values. On a host, use its private environment-variable settings.
7. Set `DATABASE_PATH` to a file on a persistent volume. Run `npm start`.
8. Invite `@Relay` to a test channel, then create a task. Have the assignee start it and send it for review. Have the creator request changes, then approve the next submission.
9. Restart the service and check `/tasks all` to verify persistence. Capture a screenshot of the task card for the Handshake submission.

The command Request URL is `/slack/commands`; the interactivity Request URL is `/slack/actions`. Slack's “escape channels, users, and links” option must remain enabled for both commands (set by the manifest).

## Delivery and security

- Incoming Slack requests require HMAC signature verification, a timestamp within five minutes, and the configured workspace ID.
- `SLACK_ALLOWED_CHANNEL_ID` restricts commands and button actions to one channel. Keep this set to a private test channel while testing in an existing workspace.
- Task mutations verify the channel, actor, current status, and card version. Duplicate delivery of an identical signed request is idempotent.
- Task changes, history, request receipts, and the outbound delivery queue are committed together in SQLite.
- Slack API calls run after the request acknowledgement. Failures remain in the outbox with backoff, including Slack rate limits; the queue resumes after restart.
- A local database is the source of truth. If a card is stale, `/tasks` still shows the saved status. Check `outbox.error` in the private database when diagnosing delivery failures; errors are not exposed by the public health endpoint.
- Task titles and review notes render as plain text in cards. List titles escape Slack markup.
- Secrets and database files are ignored by Git. The health endpoint reveals only service availability and mode.

## Current limits

This is a first single-workspace build. A live self-assigned task was verified in a private Slack test channel: create, start, submit for review, list the review queue, request changes with a note, resubmit, and approve. The same Slack card updated in place and the outbound queue drained. Testing with a separate assignee account is still pending. It has no OAuth installation flow for multiple workspaces, reminders, recurring tasks, edit/reassignment, or dashboard authentication. Use one service process and one local persistent database, not multiple replicas or an ephemeral filesystem. The local board is a workflow preview, not a production dashboard.

Outbox retries preserve changes but cannot promise exactly-once posting if Slack accepts a new message and the network loses the response before its timestamp is saved. Requests and receipts are currently retained indefinitely; choose retention and backup policies before wider deployment.

## Official references

- https://docs.slack.dev/interactivity/implementing-slash-commands/
- https://docs.slack.dev/interactivity/handling-user-interaction/
- https://docs.slack.dev/authentication/verifying-requests-from-slack/
- https://docs.slack.dev/reference/methods/chat.update/

## License

MIT. See [LICENSE](LICENSE).
