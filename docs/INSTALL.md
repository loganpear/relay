# Install Relay in your Slack workspace

This guide is for the workspace owner or technical teammate setting up Relay. Once it's connected, teammates use Slack commands and task-card buttons without installing anything themselves.

**Current availability:** Relay does not yet offer a hosted, one-click **Add to Slack** service. You need a computer or server to keep Relay running. Downloading this repository alone does not connect it to Slack.

## What you need

- Permission to install a custom Slack app in your workspace.
- A computer with [Node.js 24 or newer](https://nodejs.org/) that will stay on while Relay is in use.
- A copy of this repository: choose **Code → Download ZIP** on GitHub and unzip it.

## 1. Create your Slack app

1. Open [Slack's app setup page](https://api.slack.com/apps).
2. Choose **Create an App → From a manifest**. Slack may show **Continue** between steps.
3. Select your workspace.
4. Open `slack-manifest.socket.json` from this repository in a text editor. Copy its contents into Slack's **JSON** manifest field.
5. Review the app named **Relay** and create it. Install it to your workspace if Slack does not install it during creation.

Relay needs **commands** and **chat:write** permissions. If your workspace requires approval, ask its owner to approve the app.

## 2. Choose a private test channel

Create a private channel for trying Relay. Open its channel details and copy the **Channel ID**. Under **Agents & apps**, add **Relay** to this channel.

Use this channel first so you can try the workflow before involving the rest of your team.

## 3. Connect the app

In your downloaded Relay folder, make a copy of `.env.example` named `.env`. Files beginning with a dot may be hidden in your file browser. Keep this file private.

Fill in these four settings:

| Setting | Where to find it |
| --- | --- |
| `SLACK_BOT_TOKEN` | Slack app settings → **OAuth & Permissions** → **Bot User OAuth Token**, beginning `xoxb-`. It appears after installation. |
| `SLACK_APP_TOKEN` | **Basic Information → App-Level Tokens**. Use the existing token with **connections:write**, or generate one with only that scope. It begins `xapp-`. |
| `SLACK_TEAM_ID` | Your workspace ID: the `T…` part of `https://app.slack.com/client/T…` when you open Slack in a browser. |
| `SLACK_ALLOWED_CHANNEL_ID` | The private test channel's ID from step 2. |

In app settings, check that **Socket Mode** and **Interactivity & Shortcuts** are enabled. The supplied manifest enables both, plus the Home tab and its app_home_opened event. This connection does not need a public website or a signing secret.

Never paste app tokens into a Slack conversation, GitHub issue, or public repository.

## 4. Start Relay

Open a terminal in the downloaded Relay folder and run:

```sh
npm run socket
```

No package installation is needed. Wait for **Relay connected to Slack**. Leave this process running; if the computer sleeps or the process stops, Relay cannot answer commands until you start it again.

## 5. Try it in Slack

In your private test channel:

1. Open **Relay → Home → ＋ New task**. Enter a title, select yourself, and click **Create task**.
2. Click the task’s **To do** status directly in its Home table row. It changes to **Done** in place.
3. Open the task’s card in the test channel and check its thread for the completion mention.
4. Type `/tasks all` to see the saved task.

Then repeat with a teammate: assign them a task, have them mark it done, and check the completion mention you receive. Your team can use the [everyday instructions](../README.md#your-first-task) from here.

Open **Relay → Home** to see both **Assigned to you** and **Assigned by you** tables immediately. Each shows five recent tasks, with **Show more** for longer lists. The tables are private to the person opening them.

## If something isn't working

- **Commands aren't listed:** check that the app is installed and the manifest includes `/task` and `/tasks`.
- **Commands time out:** make sure Relay is still running and connected. Check the workspace and channel IDs in `.env`.
- **No task card appears:** add Relay to the private channel using **Channel details → Agents & apps**.
- **Relay says testing is restricted:** use the channel configured in `SLACK_ALLOWED_CHANNEL_ID`.
- **A button is unavailable:** only the assignee can mark an unfinished task done.

For a persistent server setup and technical details, see the [developer guide](DEVELOPMENT.md).

### Task images

Both app manifests include the `files:read` bot scope required by Slack’s native image uploader. After installing or reinstalling with that permission, set `SLACK_IMAGE_UPLOADS=true` and restart Relay. Until then, text details remain available and the image picker stays hidden. Images stay hosted in Slack; Relay stores their file IDs rather than copying image bytes or creating public links.
