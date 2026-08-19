/**
 * Register server tools on the ElevenLabs voice agent.
 *
 * Creates workspace-level tools (if they don't exist) and attaches them to
 * the agent via tool_ids. Idempotent: re-running updates existing tools
 * and ensures the agent references them all.
 *
 * Usage:
 *   ELEVENLABS_API_KEY=... \
 *   ELEVENLABS_AGENT_ID=... \
 *   ELEVENLABS_WEBHOOK_BASE_URL=https://your-app.vercel.app/api/webhook/elevenlabs \
 *   ELEVENLABS_WEBHOOK_SECRET_ID=<workspace-secret-id> \
 *   npx tsx scripts/register-elevenlabs-tools.ts
 */

const API_KEY = process.env.ELEVENLABS_API_KEY;
const AGENT_ID = process.env.ELEVENLABS_AGENT_ID;
const BASE_URL = process.env.ELEVENLABS_WEBHOOK_BASE_URL;
const WEBHOOK_SECRET_ID = process.env.ELEVENLABS_WEBHOOK_SECRET_ID;

if (!API_KEY || !AGENT_ID || !BASE_URL || !WEBHOOK_SECRET_ID) {
  console.error(
    "Required env vars: ELEVENLABS_API_KEY, ELEVENLABS_AGENT_ID, ELEVENLABS_WEBHOOK_BASE_URL, ELEVENLABS_WEBHOOK_SECRET_ID",
  );
  process.exit(1);
}

const headers = {
  "xi-api-key": API_KEY,
  "Content-Type": "application/json",
};

// ── Tool Definitions ──────────────────────────────────────────────────────

interface ToolProperty {
  type: string;
  description: string;
}

interface ToolDef {
  name: string;
  description: string;
  path: string; // appended to BASE_URL, e.g. "/tool/lookup_context"
  properties: Record<string, ToolProperty>;
  required?: string[];
}

const TOOLS: ToolDef[] = [
  {
    name: "lookup_context",
    description:
      "Look up context about a topic or person. Use 'query' for general " +
      "knowledge searches, or 'person_name' to look up a specific team member in Slack.",
    path: "/tool/lookup_context",
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
  {
    name: "send_dm",
    description:
      "Send a direct message to a team member on Slack. " +
      "Provide the person's name and the message content.",
    path: "/tool/send_dm",
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
];

// ── Helpers ───────────────────────────────────────────────────────────────

function buildRequestBodySchema(def: ToolDef) {
  const properties: Record<string, any> = {};
  for (const [key, prop] of Object.entries(def.properties)) {
    properties[key] = {
      type: prop.type,
      description: prop.description,
      enum: null,
      is_system_provided: false,
      dynamic_variable: "",
      constant_value: "",
    };
  }
  return {
    type: "object",
    description: "",
    required: def.required ?? [],
    properties,
  };
}

function buildToolConfig(def: ToolDef) {
  return {
    type: "webhook" as const,
    name: def.name,
    description: def.description,
    api_schema: {
      url: `${BASE_URL}${def.path}`,
      method: "POST",
      content_type: "application/json",
      request_headers: {
        "x-webhook-secret": { secret_id: WEBHOOK_SECRET_ID },
      },
      request_body_schema: buildRequestBodySchema(def),
    },
  };
}

async function apiCall(method: string, path: string, body?: any) {
  const res = await fetch(`https://api.elevenlabs.io/v1${path}`, {
    method,
    headers,
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${method} ${path} failed (${res.status}): ${text}`);
  }
  return res.json();
}

// ── Main ──────────────────────────────────────────────────────────────────

async function main() {
  // 1. List existing workspace tools
  const { tools: existingTools } = await apiCall("GET", "/convai/tools");
  const toolsByName = new Map<string, any>();
  for (const t of existingTools) {
    toolsByName.set(t.tool_config?.name, t);
  }

  const toolIds: string[] = [];

  for (const def of TOOLS) {
    const config = buildToolConfig(def);
    const existing = toolsByName.get(def.name);

    if (existing) {
      // Update existing workspace tool
      await apiCall("PATCH", `/convai/tools/${existing.id}`, config);
      toolIds.push(existing.id);
      console.log(`Updated workspace tool: ${def.name} (${existing.id})`);
    } else {
      // Create new workspace tool
      const created = await apiCall("POST", "/convai/tools", config);
      toolIds.push(created.id ?? created.tool_id);
      console.log(`Created workspace tool: ${def.name} (${created.id ?? created.tool_id})`);
    }
  }

  // 2. Fetch current agent config
  const agent = await apiCall("GET", `/convai/agents/${AGENT_ID}`);
  const currentToolIds: string[] =
    agent.conversation_config?.agent?.prompt?.tool_ids ?? [];

  // Merge tool_ids (deduplicated)
  const mergedIds = [...new Set([...currentToolIds, ...toolIds])];

  // 3. Patch agent: set tool_ids, clear inline tools to avoid duplicates
  await apiCall("PATCH", `/convai/agents/${AGENT_ID}`, {
    conversation_config: {
      agent: {
        prompt: {
          tool_ids: mergedIds,
          tools: [],
        },
      },
    },
  });

  console.log(`\nAgent ${AGENT_ID} now references ${mergedIds.length} tool(s): ${mergedIds.join(", ")}`);
  console.log("Done.");
}

main().catch((err) => {
  console.error("Registration failed:", err);
  process.exit(1);
});
