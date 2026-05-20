import pkg from "@slack/web-api";
const { WebClient, LogLevel } = pkg;

const token = process.env.SLACK_BOT_TOKEN;
const client = new WebClient(token, { logLevel: LogLevel.ERROR });
const channel = "D0AFEC7BEMP";
const TEAM_ID = "T066UV1H6";
const JOAN = "U0678NQJ2";

const parent = await client.chat.postMessage({ channel, text: "[AURA TEST 5 - with task_display_mode, ignore]" });
const threadTs = parent.ts;

// TEST: what if task_display_mode="timeline" is causing the issue?
console.log("=== TEST 5: chatStream with task_display_mode=timeline ===");
try {
  const s = client.chatStream({
    channel,
    thread_ts: threadTs,
    recipient_team_id: TEAM_ID,
    recipient_user_id: JOAN,
    task_display_mode: "timeline",
  });

  console.log("appending incremental");
  for (let i = 0; i < 15; i++) {
    const text = `chunk ${i}: Lorem ipsum dolor sit amet consectetur adipiscing. `;
    const r = await s.append({ markdown_text: text });
    if (r) console.log(`  delta ${i}: FLUSH ok=${r.ok}`);
    await new Promise(r => setTimeout(r, 100));
  }
  const stop = await s.stop();
  console.log("stop ok:", stop.ok);
} catch (e) {
  console.log("ERROR:", e.data?.error || e.message);
  console.log(JSON.stringify(e.data?.response_metadata?.messages || []));
}
