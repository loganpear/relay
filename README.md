# Relay

**Assign work. Mark it done. Keep everyone in the loop.**

Relay is a lightweight task manager for teams that want a clear owner and a clear next step, without opening another app.

## Get Relay in your Slack

Relay is currently an early, self-hosted release. A public **Add to Slack** installation is not available yet. Your workspace owner or a technical teammate needs to connect and run Relay once before your team can use it.

**Setting up a workspace?** Follow the [Slack installation guide](docs/INSTALL.md).

**Relay already installed in your workspace?**

1. Open the channel your workspace owner enabled for Relay.
2. Open the channel details, choose **Agents & apps**, and add **Relay** if it isn't there already.
3. Open **Relay → Home**, click **＋ New task**, and choose a teammate, task title, and optional due date.

That's all teammates need to get started. There is no separate Relay account or app download.

## See your tasks in Slack

Open **Relay → Home**. Your two task tables are already there:

- **Assigned to you** — the five newest tasks assigned to you, including self-assigned tasks.
- **Assigned by you** — the five newest tasks you assigned to other people.

Both tables show task directions, the teammate, due date, and status. Click **To do** or **Done** in a row to change its status. Only the assignee can mark work done; either the assignee or assigner can reopen it. Completing work mentions the assigner in the task’s channel thread.

The assigner can click the **task directions** to edit the directions, assignee, or due date, or click **Delete** directly in the row. Delete asks for confirmation and offers **Undo delete** afterward, without a separate Trash screen.

Each table starts with five tasks, newest first. **Show more** expands that list to 20 rows, with **Previous / Next** for older work; **Show fewer** returns to five. Self-assigned tasks appear only once. The tables are private to you and cover the channel enabled for Relay.

**＋ New task** and **Refresh** sit at the bottom. Refresh preserves expanded lists and their pages. No task selector or view switching is needed.

## Your first task

In **Relay → Home**, click **＋ New task**, enter a title, select a teammate, and optionally pick a due date. Click **Create task**. No slash command is required.

Prefer a shortcut? In your Relay channel:

```text
/task @alex Update the landing page
```

Choose Alex from Slack's mention suggestions. Relay posts a task card in the channel with the owner, status, and buttons to move it forward.

**To do → Done**

The assignee clicks **Mark done**. Relay updates the card and posts a completion message in its thread, mentioning the person who assigned it. No review or approval step is needed. Slack delivers mention alerts according to the recipient’s notification settings.

## Find what needs your attention

| Type this in your Relay channel | What you see |
| --- | --- |
| `/tasks mine` | Your unfinished tasks |
| `/tasks assigned` | Unfinished tasks you assigned |
| `/tasks team` | The channel's unfinished tasks |
| `/tasks all` | The channel's tasks, including completed work |

Task lists are visible only to the person requesting them. Shared task cards stay in the channel.

## A little more control

**Add a deadline:**

```text
/task @alex Update the landing page --due 2026-11-06
```

Use year-month-day for dates.

## Access and privacy

Relay requests permission to receive its commands and post its task cards. It does not request permission to read channel history or your workspace's user directory.

Only the assignee can mark a task done. The assigner can edit, delete, and restore it; either person can reopen it. Tasks and activity are stored by whoever runs Relay. The current release connects to one workspace, and local testing is restricted to one configured channel.

## Building on Relay

Want to run the demo, contribute code, or host your own copy? See the [developer guide](docs/DEVELOPMENT.md).

## License

[MIT](LICENSE).
