/**
 * One-time script to register server tools on the ElevenLabs voice agent.
 *
 * Usage:
 *   ELEVENLABS_API_KEY=... ELEVENLABS_AGENT_ID=... \\
 *   ELEVENLABS_WEBHOOK_BASE_URL=https://aura-alpha-five.vercel.app/api/webhook/elevenlabs \\
 *   ELEVENLABS_WEBHOOK_SECRET_ID=<secret-id> \\
 *   npx tsx scripts/register-elevenlabs-tools.ts
 *
 * This registers the lookup_context and send_dm tools with the ElevenLabs
 * conversational AI agent so it can call them during voice conversations.
 * The tools are authenticated via the x-webhook-secret header using an
 * ElevenLabs Workspace Secret (referenced by secret ID).
 */

const AGENT_ID = process.env.ELEVENLABS_AGENT_ID;
const API_KEY = process.env.ELEVENLABS_API_KEY;
const BASE_URL = process.env.ELEVENLABS_WEBHOOK_BASE_URL;
const WEBHOOK_SECRET_ID = process.env.ELEVENLABS_WEBHOOK_SECRET_ID;

if (!AGENT_ID || !API_KEY || !BASE_URL || !WEBHOOK_SECRET_ID) {
  console.error(
    "Required env vars: ELEVENLABS_AGENT_ID, ELEVENLABS_API_KEY, ELEVENLABS_WEBHOOK_BASE_URL, ELEVENLABS_WEBHOOK_SECRET_ID",
  );
  process.exit(1);
}

const tools = [
  {
    type: "webhook" as const,
    name: "lookup_context",
    description:
      "Look up context about a topic or person. Use 'query' for general knowledge searches, " +
      "or 'person_name' to look up a specific team member in Slack.",
    api_schema: {
      url: `${BASE_URL}/tool/lookup_context`,
      method: "POST",
      request_headers: {
        "x-webhook-secret": { secret_id: WEBHOOK_SECRET_ID },
      },
      request_body: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "A question or topic to search for in the knowledge base.",
          },
          person_name: {
            type: "string",
            description: "Name of the person to look up in Slack.",
          },
        },
      },
    },
  },
  {
    type: "webhook" as const,
    name: "send_dm",
    description:
      "Send a direct message to a team member on Slack. " +
      "Provide the person's name and the message content.",
    api_schema: {
      url: `${BASE_URL}/tool/send_dm`,
      method: "POST",
      request_headers: {
        "x-webhook-secret": { secret_id: WEBHOOK_SECRET_ID },
      },
      request_body: {
        type: "object",
        properties: {
          user_name: {
            type: "string",
            description: "Display name or username of the Slack user to message.",
          },
          message: {
            type: "string",
            description: "The message to send.",
          },
        },
        required: ["user_name", "message"],
      },
    },
  },
];

async function registerTools() {
  // Fetch current agent config
  const getRes = await fetch(
    `https://api.elevenlabs.io/v1/convai/agents/${AGENT_ID}`,
    { headers: { "xi-api-key": API_KEY! } },
  );
  if (!getRes.ok) {
    console.error("Failed to fetch agent:", getRes.status, await getRes.text());
    process.exit(1);
  }
  const agent = await getRes.json();

  const existingTools: any[] = agent.conversation_config?.agent?.tools ?? [];
  const existingNames = new Set(existingTools.map((t: any) => t.name));

  const toAdd = tools.filter((t) => !existingNames.has(t.name));
  if (toAdd.length === 0) {
    console.log("All tools already registered:", [...existingNames].join(", "));
    return;
  }

  const updatedTools = [...existingTools, ...toAdd];

  const patchRes = await fetch(
    `https://api.elevenlabs.io/v1/convai/agents/${AGENT_ID}`,
    {
      method: "PATCH",
      headers: {
        "xi-api-key": API_KEY!,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        conversation_config: {
          agent: {
            tools: updatedTools,
          },
        },
      }),
    },
  );

  if (!patchRes.ok) {
    console.error("Failed to update agent:", patchRes.status, await patchRes.text());
    process.exit(1);
  }

  console.log(`Registered ${toAdd.length} tool(s):`, toAdd.map((t) => t.name).join(", "));
}

registerTools().catch((err) => {
  console.error("Registration failed:", err);
  process.exit(1);
});
