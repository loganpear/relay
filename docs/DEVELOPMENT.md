# Relay developer guide

For workspace setup, start with the [installation guide](INSTALL.md). For everyday usage, see the [project overview](../README.md). Run commands below from the repository root.

A small task manager inside Slack. Assign work, mark it done, and notify the assigner without introducing another daily app.

## Run the local preview

Requires Node.js 24 or newer. The Node service has no third-party runtime dependencies. Run `npm install` to install Cloudflare deployment/testing tools before running the full test suite.

```sh
npm run demo
```

Open http://127.0.0.1:3000. Switch between Logan, Alex, and Sam to try the permissions and completion flow. Demo records persist in `data/demo.sqlite`. This preview never sends Slack messages, and its routes are disabled in Slack mode. It binds only to loopback.

```sh
npm test
```

## Slack commands

```text
/task @alex Polish the landing page --due 11/06 05:30 PM
/task @sam Update the team links
/tasks mine
/tasks team
/tasks assigned
/tasks all
```

Select the assignee from Slack's mention suggestions. Deadlines accept natural text such as `fri 5pm`, `tomorrow`, `11/6`, or an explicit ISO date. Tasks have just two statuses: **To do** and **Done**. The assignee or the assigner can click **Mark done**; whoever did not act gets the mention. Relay updates the shared card and posts a threaded completion message mentioning the assigner. No additional Slack scopes are needed.

`/tasks assigned` lists unfinished tasks created by the requester. Personal lists span your tasks across channels; team/all lists stay in the current channel. Lists are limited to 50 tasks. Completed tasks appear in `/tasks all`.

## Connect a Slack developer sandbox

For free cloud hosting with persistent storage and scheduled reminders, see [Cloudflare deployment](CLOUDFLARE.md).

### Local testing with Socket Mode

For local Slack testing, add your bot token and app-level token to a private `.env` file (`SLACK_BOT_TOKEN` and `SLACK_APP_TOKEN`). Set `SLACK_TEAM_ID` to your workspace ID, and optionally `SLACK_ALLOWED_CHANNEL_ID` to a private test channel ID. Run `npm run socket`. Socket Mode does not need a public HTTPS host or signing secret. The app must enable interactivity and declare `/task` and `/tasks`. This process needs to remain running for commands to work and reconnects when Slack refreshes its connection.

`slack-manifest.socket.json` is the matching Socket Mode app configuration; the HTTP manifest remains available for later hosted deployment. Do not run both delivery workers against the same database simultaneously.

### Hosted testing with HTTP

1. Provision your developer sandbox using the Handshake mission's instructions.
2. Host this service behind HTTPS on a persistent Node 24 server with a writable disk. Set `HOST=0.0.0.0` for a hosted container and `DEMO_MODE=false`. No demo routes are exposed in this mode.
3. Replace every `https://YOUR_HOST` value in `slack-manifest.json` with your HTTPS origin. Create a Slack app from this manifest inside the sandbox.
4. Upload an app icon in Slack's Basic Information page. The manifest supplies the name, description, and background color.
5. Install the app to the sandbox. It requests `commands`, `chat:write`, and `users:read` (only to read each person's time zone): it does not read channel history.
6. Copy `.env.example` to `.env`. Privately set the app's signing secret, bot token, and installed workspace ID. Never commit or share these values. On a host, use its private environment-variable settings.
7. Set `DATABASE_PATH` to a file on a persistent volume. Run `npm start`.
8. Invite `@Relay` to a test channel, then create a task. Have the assignee click Mark done. Check the task thread for the completion mention to the assigner.
9. Restart the service and check `/tasks all` to verify persistence. Capture a screenshot of the task card for the Handshake submission.

The command Request URL is `/slack/commands`; the interactivity Request URL is `/slack/actions`; the Events API Request URL is `/slack/events`. Slack's “escape channels, users, and links” option must remain enabled for both commands (set by the manifest).

### Portable container deployment

A `Dockerfile` is included for a host that supports a continuously running container and persistent volumes. Set the private runtime variables from `.env.example` using the host's secret settings. Mount a persistent volume at `/app/data`, use one replica, expose port 3000 behind HTTPS, and run the container's default HTTP command. `/health` is the health-check endpoint. The image excludes local credentials, task databases, and development screenshots. Do not migrate the club's test database into a public demo; use a separate sandbox app and a fresh database.

For a local container check, build with `docker build -t relay .`, then supply a private env file and a named volume when starting it. Hosting services may charge for continuous compute and storage; review the provider's plan before creating a service.

## Delivery and security

- Incoming Slack requests require HMAC signature verification, a timestamp within five minutes, and the configured workspace ID.
- `SLACK_ALLOWED_CHANNEL_ID` is optional. When set, it restricts slash commands and card buttons to one channel; keep it set to a private test channel while testing in an existing workspace. Relay Home is never channel-bound.
- Task mutations verify the channel, actor, current status, and card version. Duplicate delivery of an identical signed request is idempotent.
- Task changes, history, request receipts, and the outbound card and completion-notification queues are committed together in SQLite.
- Slack API calls run after the request acknowledgement. Failures remain in the outbox with backoff, including Slack rate limits; the queue resumes after restart.
- A local database is the source of truth. If a card is stale, `/tasks` still shows the saved status. Check `outbox.error` in the private database when diagnosing delivery failures; errors are not exposed by the public health endpoint.
- Task titles render as plain text in cards and completion notices. List titles escape Slack markup.
- Secrets and database files are ignored by Git. The health endpoint reveals only service availability and mode.

## Current limits

Relay currently supports one workspace per running instance. Automated tests cover task permissions, signed HTTP requests, duplicate submissions, lifecycle transitions, deadline parsing, time zones, reminders, delivery retries, and live Home refreshes. The local handoff records earlier two-account Slack testing; validate the deployed version in your own sandbox before release.

Relay has no public multi-workspace OAuth installation flow or recurring tasks. Reminders run inside the long-lived service, so keep one instance continuously running with a persistent SQLite volume. Multiple replicas and ephemeral filesystems are unsupported. The local demo is a workflow preview, not a hosted user dashboard.

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

Both manifests enable App Home and subscribe to app_home_opened without adding bot scopes. Home immediately displays two data_table blocks: the newest five tasks assigned to the viewer and the newest five they created, including self-assigned tasks. Current/Past filters apply per role. Only Assigned by you has a management-action column; only Current Assigned to you has status buttons. Past statuses are always plain text; UI handlers reject old Past buttons, dropdowns, and status-form submissions. Each list expands independently to 20 rows and pages through older work, so payload sizes stay bounded. Refresh preserves expansion and page state; reopening Home returns to five rows per list. Opening Messages also initializes Home for first-time users.

Status, task details, deadline, archive, and reactivation controls use action_cell buttons. Each button carries its own task ID and version, with a unique action_id per task and list. Either person can complete work, and only the assigner can send unarchived Done work back to To do. Assigned-by-you status cells are editable for unarchived tasks in Current; backend authorization rejects old assignee reopen controls and archived work. Queries and mutations use the authenticated actor plus the configured workspace and channel. Legacy clients that cannot render action cells show a text fallback; channel-card controls and slash commands remain available. Publishing Home sends no channel messages.

## Task management from Home

Home uses native Slack modals, users_select, and datepicker inputs. Every mutation rechecks workspace, channel, actor, version, and deletion state against SQLite. Modal submissions are deduplicated by Slack view ID. Archive moves records out of Current while preserving details and history. There is no Delete or Trash UI. Older delete/restore controls are safely mapped to archive/unarchive with the same ownership and version checks. Reopened tasks can be completed again, producing a separate queued completion event for each completion version. Both HTTP and Socket Mode handlers support this UI.

## Due times

Deadlines store an ISO dueDate, plus for timed deadlines the wall-clock dueTime, the zone it was entered in (dueZone), and the exact moment (dueAt, Unix seconds, UTC). Date-only deadlines keep dueTime/dueZone/dueAt null and read the same everywhere. Each person's Slack time zone comes from users.info (users:read) and is saved in user_time_zones, re-checked daily (hourly while unavailable); until it is known, TASK_TIMEZONE (default America/New_York) is used. Home, task details, forms, and /tasks show deadlines on the viewer's clock; channel cards use Slack's <!date^…> formatting so each reader sees their own time, with an Eastern fallback. Forms set the time picker to the author's zone and save it with the deadline, so re-saving never shifts the moment; editing Past work keeps the original deadline. Overdue compares dueAt with now; date-only deadlines are overdue after the date ends on the viewer's clock. Slash commands read --due naturally in the author's zone (readDeadline: today/tomorrow, weekdays, M/D[/YY], month names, ISO, then optional "at" and 5pm/5:30 PM/17:30/noon; words after the deadline stay in the title) and infer the next future occurrence, including leap years; the worker waits up to 1.5 s to learn that zone first. A spring-forward gap time moves forward by the gap. The due-moments migration converted older deadlines as Eastern and refreshed their cards. Older ISO --due YYYY-MM-DD and --at HH:MM commands remain supported for compatibility.

Task names open a Task details modal for the creator or assignee. Only creators can open Edit from that modal. Details are plain text (up to 3,000 characters); up to five PNG/JPEG/GIF images are stored as private Slack file IDs. Image uploads are disabled unless SLACK_IMAGE_UPLOADS=true and Relay has been reinstalled with the files:read bot scope. Add that scope only when enabling image uploads. Removing attachments unlinks them from the task; it does not delete the underlying Slack files. Existing task data migrates with empty details and no images.

Slash commands accept optional --details "Text" before or after --due. Parsing removes quoted details before interpreting other flags, so option-like text inside notes stays literal. Escaped double quotes and backslashes are supported, as are mobile smart quotes. Repeated flags, unclosed quotes, and notes above 3,000 characters are rejected before creating a task.

Home lifecycle uses Current (default) and Past. Assignee Current is active To do work; assigner Current includes To do and unarchived Done tasks for seven days from completedAt. The boundary is computed on each render, without destructive cleanup or background notification jobs. completedAt is recorded on completion and backfilled from the most recent complete history entry (updatedAt fallback for old data). Sending work back to To do queues a threaded mention of the assignee (same queue as completion mentions, kind=reopen; an unsent mention for the previous status change is dropped) and clears completedAt, archivedAt, and creatorCurrentUntil. Creator-only archive sets archivedAt; unarchive sets a seven-day creatorCurrentUntil without changing the completion timestamp or status. Edits never reset the completion window. Older soft-deleted records migrate to archived work, clearing deletedAt while preserving history; pending historical completion notifications are suppressed. Past sorts by archive or completion activity, with ID as a stable tie breaker. Each view has independent bounded pagination; switching views resets pages.

Archiving To do uses archivedAt to suspend the unfinished task for both roles. Assignee Current excludes these rows; Past keeps their To do status with no completion control. Store-level transition guards also reject stale channel cards or crafted completion actions. The channel card removes Mark done and explains that work is no longer required. Creator-only unarchive clears archivedAt and returns To do work to both Current lists; it does not set creatorCurrentUntil. Archiving Done retains the existing personal-list behavior. Past Home status is read-only.

Archive state is independent of task progress everywhere. Home replaces Action with an Archive column for assigners: ui_choose_archive opens a focused modal with Active/Archived choices; ui_choose_status opens To do/Done choices for assignees. Both use a static_select and require Save, with Cancel making no change. Modal submissions validate ownership, task version, and explicit allowed values before mutation. Status stays To do/Done in tables, task details, cards, and command lists. isTaskArchived also accounts for the assigner’s automatic seven-day expiry and temporary reactivation window.

## Cards and direct messages

Only tasks created with /task have a channel card: tasks.channelId is the channel where the command ran and messageTs is the posted card. Tasks created in Relay Home store channelId NULL and are never enqueued for delivery. Home and /tasks mine|assigned list a person's tasks across all channels; /tasks team|all list tasks whose card is in the current channel.

Completion, send-back, and reassignment notices share the completion_notifications queue (kind = complete when the assignee finishes, closed when the assigner marks it Done, reopen, assign). A notice waits until the card is up to date, then replies in the card's thread; without a card it is a direct message from Relay to the recipient (chat.postMessage to the user ID, which needs only chat:write and the Messages tab). Nobody is notified about their own task. Each status change drops any unsent notice for the previous one.

If Slack reports the card can never be posted or updated (message_not_found, not_in_channel, channel_not_found, is_archived, and similar), detachCard clears channelId and messageTs, removes the outbox row, and falls back to direct messages; a card that was never posted also queues an assignee DM. A direct message that can never be delivered (for example user_not_found) keeps its error and is not retried. Transient errors still retry with backoff.

The cardless-tasks migration rebuilds the tasks table so channelId can be NULL, with foreign keys switched off only for the table swap.

## Keeping Home current

Every task change marks the assigner, the assignee, and a new assignee on reassignment as having an outdated Home (TaskStore.staleHomes, in memory). After each delivery flush, refreshStaleHomes republishes Home for those people, keeping the view they last had open (Current or Past, expanded lists, pages), which publishTaskHome records in TaskStore.homeViews. Publishing someone's Home clears their pending refresh, so the actor's own notice is never overwritten. Only people who opened Relay Home since the worker started are refreshed; anyone else gets a fresh Home from app_home_opened when they open it.

Home task buttons are shortened to Slack's 75-character limit on whole characters (Intl.Segmenter), so emoji and other multi-part characters are never split.

## Reminders

src/reminders.js DMs assignees so assigners never have to nag. The worker (and HTTP server) checks once a minute, and on connect:

- **Morning summary** at REMINDER_DIGEST_TIME (default 09:00) in each person's own time zone, every day, listing their unfinished, unarchived tasks: Overdue, Due today, ⏰ Due tomorrow (the day-before reminder), Coming up, No deadline. Up to ten tasks, then "…and N more in Relay Home". If Relay was down at that time it catches up for three hours, never later. Nothing is sent to people with no open work.
- **Timed deadlines**: a heads-up one hour before dueAt, unless the task was created inside that hour. A new deadline gets its own heads-up.
- **Date-only deadlines**: a heads-up at REMINDER_DUE_DAY_TIME (default 16:00) on the due day, plus the morning summary's Due tomorrow the day before.

Every reminder has a key (digest:user:date, soon:task:dueAt:user, today:task:date:user) stored in reminders_sent, so it is sent at most once, even across restarts; passing Slack errors retry next minute, unreachable people are skipped. Each task line has a Mark done button (action remind_done), handled before the test channel lock because reminders arrive in DMs; it completes the task as the clicker (assignee or assigner rules apply) and edits the DM in place. People turn reminders on or off with the 🔔 Reminders switch in Relay Home (reminder_settings; on by default). RELAY_REMINDERS=off disables all reminders. Reminders only go to assignees, never to assigners.
