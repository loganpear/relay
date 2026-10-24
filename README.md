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

Open **Relay → Home**. **Current** shows two tables:

- **Assigned to you** — unfinished work assigned to you. Marking it Done moves it to your Past list immediately. A confirmation at the top names the task and includes **View Past** so you can find it again.
- **Assigned by you** — work you created. Completed tasks stay here for seven days after completion so you can see the result; click the **Archive** cell, choose **Archived**, and save to move them to your Past list sooner.

Switch to **Past** to find completed and archived work. Both Past tables include **Created at**, with the original creation date, year, and time in Eastern time. Each table starts with the five newest matching tasks. **Show more** expands that list to 20 rows, with **Previous / Next** for older records. Refresh keeps your selected view and page. Automatic seven-day moves are applied when Home opens or refreshes.

Only assignees can change **🔲 To do / ✅ Done**, including reopening work from Past. Reopening brings the task back to both Current lists and clears its archive state. Completing work mentions the assigner in the task’s channel thread. Archiving **Done** only affects the assigner’s list. Archiving **To do** stops the work for both people: it moves to both Past lists with **Archive** set to **Archived**, and cannot be completed until the assigner sets it back to **Active**. Archiving sends no completion notification. Setting **Archived** back to **Active** reactivates an archived To do task for both people; for completed tasks it gives the assigner another seven days in Current without changing status.

Click a **task name** for requirements and notes (plus attached images when uploads are enabled). Details opened from **Assigned to you** are read-only, including self-assigned tasks. The assigner can open it under **Assigned by you** and choose **Edit**. The **Due** cell there also opens the deadline editor.

For mistakes or canceled work, use **Archive**. Task details and history stay available in Past; the assigner can set **Archived** back to **Active** to reactivate work. There is no separate Delete or Trash flow.

**＋ New task** and **Refresh** stay at the bottom. Self-assigned tasks follow each table’s role: after completion they are Past under Assigned to you and remain Current under Assigned by you for up to seven days.

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

**Add short requirements or notes:**

```text
/task @alex Build signup page --due 11/06 05:30 PM --details "Include email validation and a confirmation screen."
```

Both flags are optional and can appear in either order. Put details in double quotes (up to 3,000 characters). Longer notes can also be edited from the task’s details window.

## Access and privacy

Relay requests permission to receive its commands, post its task cards, and read files available to the app for task image attachments. It does not request permission to read channel history or your workspace's user directory.

Only the assignee can complete or reopen a task. The assigner can edit, archive, and reactivate it. Tasks and activity are stored by whoever runs Relay. The current release connects to one workspace, and local testing is restricted to one configured channel.

## Building on Relay

Want to run the demo, contribute code, or host your own copy? See the [developer guide](docs/DEVELOPMENT.md).

## License

[MIT](LICENSE).

The **Status** column always shows **To do** or **Done**. Archiving is separate: the assigner’s **Archive** column shows **Active** or **Archived**; click an editable cell to open a small dropdown window, choose a value, and save. Cancel closes the window without making changes. Archived unfinished tasks keep their To do status while work is suspended.
