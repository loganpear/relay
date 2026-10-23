# Relay

**Assign work. Track progress. Get it approved. All inside Slack.**

Relay is a lightweight task manager for teams that want a clear owner and a clear next step, without opening another app.

## Get Relay in your Slack

Relay is currently an early, self-hosted release. A public **Add to Slack** installation is not available yet. Your workspace owner or a technical teammate needs to connect and run Relay once before your team can use it.

**Setting up a workspace?** Follow the [Slack installation guide](docs/INSTALL.md).

**Relay already installed in your workspace?**

1. Open the channel your workspace owner enabled for Relay.
2. Open the channel details, choose **Agents & apps**, and add **Relay** if it isn't there already.
3. Type `/task`, choose a teammate, and describe the work.

That's all teammates need to get started. There is no separate Relay account or app download.

## Your first task

```text
/task @alex Update the landing page
```

Choose Alex from Slack's mention suggestions. Relay posts a task card in the channel with the owner, status, and buttons to move it forward.

**To do → In progress → Ready for review → Done**

The assignee starts the task and sends it for review. The person who created it can approve it or request changes. The same card updates, so everyone can see where the work stands.

## Find what needs your attention

| Type this in your Relay channel | What you see |
| --- | --- |
| `/tasks mine` | Your unfinished tasks |
| `/tasks review` | Tasks waiting for your approval |
| `/tasks team` | The channel's unfinished tasks |
| `/tasks all` | The channel's tasks, including completed work |

Task lists are visible only to the person requesting them. Shared task cards stay in the channel.

## A little more control

**Add a deadline:**

```text
/task @alex Update the landing page --due 2026-11-06
```

Use year-month-day for dates.

**Skip approval for a simple task:**

```text
/task @sam Update the team links --no-review
```

**Explain a requested change:**

```text
/task changes 12 Please check the mobile spacing
```

Replace `12` with the task number. The note appears on the task card, and the task returns to **In progress**.

## Access and privacy

Relay requests permission to receive its commands and post its task cards. It does not request permission to read channel history or your workspace's user directory.

Assignees update their work; task creators review it. Tasks and activity are stored by whoever runs Relay. The current release connects to one workspace, and local testing is restricted to one configured channel.

## Building on Relay

Want to run the demo, contribute code, or host your own copy? See the [developer guide](docs/DEVELOPMENT.md).

## License

[MIT](LICENSE).
