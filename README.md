# Relay

**Assign work. Mark it done. Keep everyone in the loop.**

Relay is a lightweight task manager for teams that want a clear owner and a clear next step, without opening another app.

## Get Relay in your Slack

Relay is currently an early, self-hosted release. A public **Add to Slack** installation is not available yet. Your workspace owner or a technical teammate needs to connect and run Relay once before your team can use it.

**Setting up a workspace?** Follow the [Slack installation guide](docs/INSTALL.md).

**Relay already installed in your workspace?**

1. Open the channel your workspace owner enabled for Relay.
2. Open the channel details, choose **Agents & apps**, and add **Relay** if it isn't there already.
3. Open **Relay → Home**, click **＋ New task**, and choose a teammate, task title, and optional due date and time.

That's all teammates need to get started. There is no separate Relay account or app download.

## See your tasks in Slack

Open **Relay → Home**. Your two task tables are already there:

- **Assigned to you** — the five newest tasks assigned to you, including self-assigned tasks.
- **Assigned by you** — the five newest tasks you created, including tasks assigned to yourself.

Both tables show task directions, the teammate, due date, and status. Click **To do** or **Done** in a row to change its status. Only the assignee can change a task’s status, including reopening it. Status in Assigned by you is read-only. Completing work mentions the assigner in the task’s channel thread.

Click a **task name** to open its details and requirements (plus attached images when uploads are enabled). Details opened from **Assigned to you** are read-only, including self-assigned tasks. The assigner can open the task under **Assigned by you** and choose **Edit** to update it. The assigner can also click the **Due** cell in **Assigned by you** to set or change the date and time, or click **Delete** directly in the row. Delete asks for confirmation and offers **Undo delete** afterward, without a separate Trash screen.

Each table starts with five tasks, newest first. **Show more** expands that list to 20 rows, with **Previous / Next** for older work; **Show fewer** returns to five. Self-assigned tasks appear in both tables. **Assigned to you** has no Delete column; delete from **Assigned by you**. The tables are private to you and cover the channel enabled for Relay.

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

Deadlines display as **MM/DD h:mm AM/PM** in Eastern time (for example, **11/06 5:30 PM**). A date without a time shows only **MM/DD**.

Task lists are visible only to the person requesting them. Shared task cards stay in the channel.

## A little more control

**Add a deadline:**

```text
/task @alex Update the landing page --due 11/06 05:30 PM
```

Deadlines use Eastern time. Relay picks the soonest future year for that date and time; a deadline already passed this year uses next year (February 29 uses the next leap year).

Use a two-digit month and day, followed by a 12-hour time and AM or PM.

## Access and privacy

Relay requests permission to receive its commands, post its task cards, and read files available to the app for task image attachments. It does not request permission to read channel history or your workspace's user directory.

Only the assignee can complete or reopen a task. The assigner can edit, delete, and restore it. Tasks and activity are stored by whoever runs Relay. The current release connects to one workspace, and local testing is restricted to one configured channel.

## Building on Relay

Want to run the demo, contribute code, or host your own copy? See the [developer guide](docs/DEVELOPMENT.md).

## License

[MIT](LICENSE).
