#!/usr/bin/env node

import { WebClient } from "@slack/web-api";

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function getThreadTs({ client, channelId }) {
  const providedThreadTs = process.env.SLACK_TEST_THREAD_TS;
  if (providedThreadTs) {
    return Promise.resolve(providedThreadTs);
  }

  return client.chat
    .postMessage({
      channel: channelId,
      text: "stream probe seed message",
    })
    .then((res) => {
      if (!res.ok || !res.ts) {
        throw new Error(`Unable to create seed thread: ${res.error ?? "unknown_error"}`);
      }
      return res.ts;
    });
}

async function main() {
  const token = requiredEnv("SLACK_BOT_TOKEN");
  const channelId = requiredEnv("SLACK_TEST_CHANNEL_ID");
  const client = new WebClient(token);

  const threadTs = await getThreadTs({ client, channelId });
  const recipientTeamId = process.env.SLACK_TEST_RECIPIENT_TEAM_ID;
  const recipientUserId = process.env.SLACK_TEST_RECIPIENT_USER_ID;

  const startArgs = {
    channel: channelId,
    thread_ts: threadTs,
    ...(recipientTeamId ? { recipient_team_id: recipientTeamId } : {}),
    ...(recipientUserId ? { recipient_user_id: recipientUserId } : {}),
  };

  console.log("Starting stream probe...");
  console.log(
    JSON.stringify(
      {
        channelId,
        threadTs,
        hasRecipientTeamId: Boolean(recipientTeamId),
        hasRecipientUserId: Boolean(recipientUserId),
      },
      null,
      2,
    ),
  );

  const started = await client.chat.startStream(startArgs);
  if (!started.ok || !started.ts) {
    throw new Error(`chat.startStream failed: ${started.error ?? "unknown_error"}`);
  }

  const streamTs = started.ts;
  console.log(`Stream started at ts=${streamTs}`);

  await client.chat.appendStream({
    channel: channelId,
    ts: streamTs,
    chunks: [{ type: "markdown_text", text: "hello from chunks mode " }],
  });
  console.log("Appended markdown_text chunk");

  await client.chat.appendStream({
    channel: channelId,
    ts: streamTs,
    chunks: [
      {
        type: "task_update",
        id: `probe-${Date.now()}`,
        title: "Live appendStream validation",
        status: "complete",
        output: "task_update chunk accepted",
      },
    ],
  });
  console.log("Appended task_update chunk");

  await client.chat.stopStream({
    channel: channelId,
    ts: streamTs,
  });
  console.log("Stopped stream successfully");
}

main().catch((error) => {
  console.error("Stream probe failed:");
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
