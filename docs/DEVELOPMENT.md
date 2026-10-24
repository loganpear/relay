# Relay developer guide

For workspace setup, start with the [installation guide](INSTALL.md). For everyday usage, see the [project overview](../README.md). Run commands below from the repository root.

A small task manager inside Slack. Assign work, mark it done, and notify the assigner without introducing another daily app.

## Run the local preview

Requires Node.js 24 or newer; there are no third-party packages to install.

```sh
npm run demo
```

Open http://127.0.0.1:3000. Switch between Logan, Alex, and Sam to try the permissions and completion flow. Demo records persist in `data/demo.sqlite`. This preview never sends Slack messages, and its routes are disabled in Slack mode. It binds only to loopback.

```sh
npm test
```

## Slack commands

```text
/task @alex Polish the landing page --due 2026-11-06
/task @sam Update the team links
/tasks mine
/tasks team
/tasks assigned
/tasks all
```

Select the assignee from Slack's mention suggestions. Dates use explicit YYYY-MM-DD. Tasks have just two statuses: **To do** and **Done**. Only the assignee can click **Mark done**. Relay updates the shared card and posts a threaded completion message mentioning the assigner. No additional Slack scopes are needed.

`/tasks assigned` lists unfinished tasks created by the requester. All lists are scoped to the current channel and limited to 50 tasks. Completed tasks appear in `/tasks all`.

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
8. Invite `@Relay` to a test channel, then create a task. Have the assignee click Mark done. Check the task thread for the completion mention to the assigner.
9. Restart the service and check `/tasks all` to verify persistence. Capture a screenshot of the task card for the Handshake submission.

The command Request URL is `/slack/commands`; the interactivity Request URL is `/slack/actions`; the Events API Request URL is `/slack/events`. Slack's “escape channels, users, and links” option must remain enabled for both commands (set by the manifest).

## Delivery and security

- Incoming Slack requests require HMAC signature verification, a timestamp within five minutes, and the configured workspace ID.
- `SLACK_ALLOWED_CHANNEL_ID` restricts commands and button actions to one channel. Keep this set to a private test channel while testing in an existing workspace.
- Task mutations verify the channel, actor, current status, and card version. Duplicate delivery of an identical signed request is idempotent.
- Task changes, history, request receipts, and the outbound card and completion-notification queues are committed together in SQLite.
- Slack API calls run after the request acknowledgement. Failures remain in the outbox with backoff, including Slack rate limits; the queue resumes after restart.
- A local database is the source of truth. If a card is stale, `/tasks` still shows the saved status. Check `outbox.error` in the private database when diagnosing delivery failures; errors are not exposed by the public health endpoint.
- Task titles render as plain text in cards and completion notices. List titles escape Slack markup.
- Secrets and database files are ignored by Git. The health endpoint reveals only service availability and mode.

## Current limits

This is a first single-workspace build. The redesigned Slack Home was manually verified with self-assigned tasks: inline completion and reopening, editing task directions, deletion and Undo, five-row previews, expansion, collapse, and Refresh retaining expansion. Creation and due-date editing were also verified in Slack forms. The same channel card updated in place, the completion notice was delivered, and the outbound queue drained. The automated suite also covers authorization, stale edits, duplicate submissions, and delivery retries. A separate assignee account was also manually tested: the creator assigned a task in Safari, the assignee completed it in another browser, both Home views showed Done, and a single threaded completion mention reached the creator. It has no OAuth installation flow for multiple workspaces, reminders, recurring tasks, or dashboard authentication. Use one service process and one local persistent database, not multiple replicas or an ephemeral filesystem. The local board is a workflow preview, not a production dashboard.

Outbox retries preserve changes but cannot promise exactly-once posting if Slack accepts a new card or completion notification and the network loses the response before its timestamp is saved. Requests and receipts are currently retained indefinitely; choose retention and backup policies before wider deployment.

## Official references

- https://docs.slack.dev/interactivity/implementing-slash-commands/
- https://docs.slack.dev/interactivity/handling-user-interaction/
- https://docs.slack.dev/authentication/verifying-requests-from-slack/
- https://docs.slack.dev/reference/methods/chat.update/

## License

MIT. See [LICENSE](../LICENSE).

## Upgrading from the review workflow

On first startup, the two-status migration preserves Done tasks, maps all other statuses to To do, invalidates old buttons, and queues refreshed task cards. Task history is retained. Old completed tasks do not trigger retrospective notifications. The legacy review columns remain in SQLite for compatibility, but are no longer used by the workflow. Completion notifications are queued atomically with the task transition and retried independently after the updated card is delivered. Duplicate delivery of the same interaction does not enqueue another notification.

## Personal Home tab

Both manifests enable App Home and subscribe to app_home_opened without adding bot scopes. Home immediately displays two data_table blocks: the newest five tasks assigned to the viewer and the newest five they assigned to others. Self-assigned work appears only in the first table. Each list expands independently to 20 rows and pages through older work, so payload sizes stay bounded. Refresh preserves expansion and page state; reopening Home returns to five rows per list. Opening Messages also initializes Home for first-time users.

Status, task directions (Edit), and Delete use action_cell buttons. Each button carries its own task ID and version, with a unique action_id per task and list. Only the assignee can complete or reopen work. Assigned-by-you status cells are read-only, and backend authorization also rejects old creator buttons. Queries and mutations use the authenticated actor plus the configured workspace and channel. Legacy clients that cannot render action cells show a text fallback; channel-card controls and slash commands remain available. Publishing Home sends no channel messages.

## Task management from Home

Home uses native Slack modals, users_select, and datepicker inputs. Every mutation rechecks workspace, channel, actor, version, and deletion state against SQLite. Modal submissions are deduplicated by Slack view ID. Delete requires confirmation, hides the record from active queries, and offers an immediate Undo delete button. There is no Trash view; the stored record and history remain intact. Undo checks ownership and the current deletion version. Reopened tasks can be completed again, producing a separate queued completion event for each completion version. Both HTTP and Socket Mode handlers support this UI.

## Due times

Deadlines store an ISO dueDate plus an optional 24-hour dueTime. Displays use MM/DD HH:MM; old date-only tasks keep a null time and display MM/DD. The form includes a native time picker. A time requires a date. TASK_TIMEZONE defaults to America/New_York and is shown in the form; set it before using Relay for a workspace. Changing it changes the interpretation of existing wall-clock deadlines. Overdue comparisons use that timezone, including its daylight-saving rules, rather than the server’s local or UTC date. Slash commands accept --at HH:MM alongside --due YYYY-MM-DD.
