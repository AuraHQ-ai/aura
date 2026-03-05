import type { WebClient } from "@slack/web-api";
import { getAllSettings } from "../lib/settings.js";
import { isAdmin } from "../lib/permissions.js";
import { logger } from "../lib/logger.js";
import { getCredential, maskCredential } from "../lib/credentials.js";
import {
  listApiCredentials,
  listGrantsForCredentials,
  getCredentialById,
} from "../lib/api-credentials.js";

// ── Model Catalog ────────────────────────────────────────────────────────────

interface ModelOption {
  value: string;
  label: string;
}

const MAIN_MODELS: ModelOption[] = [
  { value: "anthropic/claude-opus-4-6", label: "Claude Opus 4.6" },
  { value: "anthropic/claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
  { value: "anthropic/claude-sonnet-4-5", label: "Claude Sonnet 4.5" },
  { value: "anthropic/claude-sonnet-4-20250514", label: "Claude Sonnet 4" },
  { value: "openai/gpt-5.3-codex", label: "GPT-5.3 Codex" },
  { value: "openai/gpt-5.2", label: "GPT-5.2" },
  { value: "openai/gpt-5.1-thinking", label: "GPT-5.1 Thinking" },
  { value: "openai/gpt-4o", label: "GPT-4o" },
  { value: "google/gemini-3-pro-preview", label: "Gemini 3 Pro" },
  { value: "google/gemini-2.5-pro", label: "Gemini 2.5 Pro" },
  { value: "xai/grok-4.1-fast-reasoning", label: "Grok 4.1 Fast" },
  { value: "deepseek/deepseek-v3.2-thinking", label: "DeepSeek V3.2 Thinking" },
];

const FAST_MODELS: ModelOption[] = [
  { value: "anthropic/claude-haiku-4-5", label: "Claude Haiku 4.5" },
  { value: "openai/gpt-5.1-instant", label: "GPT-5.1 Instant" },
  { value: "openai/gpt-5-mini", label: "GPT-5 Mini" },
  { value: "openai/gpt-4o-mini", label: "GPT-4o Mini" },
  { value: "google/gemini-3-flash", label: "Gemini 3 Flash" },
  { value: "google/gemini-2.5-flash", label: "Gemini 2.5 Flash" },
  { value: "xai/grok-4.1-fast-non-reasoning", label: "Grok 4.1 Fast NR" },
  { value: "xai/grok-code-fast-1", label: "Grok Code Fast 1" },
  { value: "deepseek/deepseek-v3.2", label: "DeepSeek V3.2" },
];

const EMBEDDING_MODELS: ModelOption[] = [
  { value: "openai/text-embedding-3-small", label: "OpenAI Embedding 3 Small (1536d)" },
  { value: "openai/text-embedding-3-large", label: "OpenAI Embedding 3 Large (3072d)" },
  { value: "google/text-embedding-005", label: "Google Embedding 005" },
];

// ── Defaults ─────────────────────────────────────────────────────────────────

const DEFAULTS: Record<string, string> = {
  model_main: process.env.MODEL_MAIN || "anthropic/claude-sonnet-4-20250514",
  model_fast: process.env.MODEL_FAST || "anthropic/claude-haiku-4-5",
  model_embedding: process.env.MODEL_EMBEDDING || "openai/text-embedding-3-small",
};

// ── Credential Definitions ───────────────────────────────────────────────────

interface CredentialDef {
  key: string;
  label: string;
  description: string;
}

const CREDENTIALS: CredentialDef[] = [
  {
    key: "github_token",
    label: "GitHub Token",
    description: "For issues, PRs, and code access",
  },
];

/** Map credential button action IDs to credential keys */
export const CREDENTIAL_ACTIONS: Record<string, string> = {
  credential_edit_github_token: "github_token",
};

// ── Block Kit Helpers ────────────────────────────────────────────────────────

function buildDropdown(
  actionId: string,
  label: string,
  options: ModelOption[],
  currentValue: string,
) {
  const slackOptions = options.map((opt) => ({
    text: { type: "plain_text" as const, text: opt.label },
    value: opt.value,
  }));

  // Find the initial option (current selection)
  const initialOption = slackOptions.find((o) => o.value === currentValue) || slackOptions[0];

  return {
    type: "section" as const,
    text: {
      type: "mrkdwn" as const,
      text: `*${label}*`,
    },
    accessory: {
      type: "static_select" as const,
      action_id: actionId,
      placeholder: {
        type: "plain_text" as const,
        text: "Select a model",
      },
      options: slackOptions,
      initial_option: initialOption,
    },
  };
}

async function buildCredentialBlocks(): Promise<any[]> {
  const blocks: any[] = [
    { type: "divider" },
    {
      type: "header",
      text: { type: "plain_text", text: "Credentials" },
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: "Encrypted and stored in the database. Values are never logged or displayed in full.",
        },
      ],
    },
  ];

  for (const cred of CREDENTIALS) {
    const value = await getCredential(cred.key);
    const status = value ? `\`${maskCredential(value)}\`` : "_not set_";

    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*${cred.label}*  —  ${cred.description}\nCurrent: ${status}`,
      },
      accessory: {
        type: "button",
        text: { type: "plain_text", text: value ? "Update" : "Set" },
        action_id: `credential_edit_${cred.key}`,
      },
    });
  }

  return blocks;
}

// ── User API Credential Blocks ──────────────────────────────────────────────

async function buildUserCredentialBlocks(userId: string): Promise<any[]> {
  const creds = await listApiCredentials(userId);

  const blocks: any[] = [
    { type: "divider" },
    {
      type: "header",
      text: { type: "plain_text", text: "Your API Credentials" },
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: "Manage your personal API tokens. Encrypted with AES-256-GCM. Share with teammates as needed.",
        },
      ],
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "+ Add Credential", emoji: true },
          action_id: "api_credential_add",
          style: "primary",
        },
      ],
    },
  ];

  if (creds.length === 0) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: "_No credentials stored yet. Add one to get started._",
      },
    });
    return blocks;
  }

  const ownedCredIds = creds
    .filter((c) => c.owner_id === userId)
    .map((c) => c.id);
  const allGrants = await listGrantsForCredentials(ownedCredIds);
  const grantsByCredId = new Map<
    string,
    Array<{ granteeId: string; permission: string; displayName: string | null }>
  >();
  for (const g of allGrants) {
    const list = grantsByCredId.get(g.credentialId) ?? [];
    list.push(g);
    grantsByCredId.set(g.credentialId, list);
  }

  for (const cred of creds) {
    const isOwner = cred.owner_id === userId;
    const source = isOwner ? "yours" : `shared by <@${cred.owner_id}>`;
    const permLabel = isOwner ? "owner" : cred.permission;

    let expiryText = "";
    if (cred.expires_at) {
      const expiresAt = new Date(cred.expires_at);
      const isExpired = expiresAt < new Date();
      expiryText = isExpired
        ? "  ·  :warning: *expired*"
        : `  ·  expires ${expiresAt.toISOString().slice(0, 10)}`;
    }

    const overflowOptions: any[] = [
      {
        text: { type: "plain_text", text: "Update" },
        value: `api_credential_update_${cred.id}`,
      },
    ];
    if (isOwner) {
      overflowOptions.push(
        {
          text: { type: "plain_text", text: "Share" },
          value: `api_credential_share_${cred.id}`,
        },
        {
          text: { type: "plain_text", text: "Delete" },
          value: `api_credential_delete_${cred.id}`,
        },
      );
    }

    const grants = grantsByCredId.get(cred.id) ?? [];
    if (grants.length > 0) {
      overflowOptions.push({
        text: { type: "plain_text", text: "View users" },
        value: `api_credential_access_${cred.id}`,
      });
    }

    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*${cred.name}*  ·  _${source}_ (${permLabel})${expiryText}`,
      },
      accessory: {
        type: "overflow",
        action_id: `api_credential_overflow_${cred.id}`,
        options: overflowOptions,
      },
    });
  }

  return blocks;
}

// ── User Credential Modals ──────────────────────────────────────────────────

export function buildAddCredentialBlocks(credType: "token" | "oauth_client" = "token"): any[] {
  const typeBlock = {
    type: "input",
    block_id: "cred_type_block",
    dispatch_action: true,
    label: { type: "plain_text", text: "Type" },
    element: {
      type: "static_select",
      action_id: "cred_type",
      options: [
        { text: { type: "plain_text", text: "Token" }, value: "token" },
        { text: { type: "plain_text", text: "OAuth Client" }, value: "oauth_client" },
      ],
      initial_option: credType === "oauth_client"
        ? { text: { type: "plain_text", text: "OAuth Client" }, value: "oauth_client" }
        : { text: { type: "plain_text", text: "Token" }, value: "token" },
    },
  };

  const valueBlocks = credType === "oauth_client"
    ? [
        {
          type: "input",
          block_id: "cred_client_id_block",
          label: { type: "plain_text", text: "Client ID" },
          element: {
            type: "plain_text_input",
            action_id: "cred_client_id",
            placeholder: { type: "plain_text", text: "Paste client ID" },
          },
        },
        {
          type: "input",
          block_id: "cred_client_secret_block",
          label: { type: "plain_text", text: "Client Secret" },
          element: {
            type: "plain_text_input",
            action_id: "cred_client_secret",
            placeholder: { type: "plain_text", text: "Paste client secret" },
          },
        },
        {
          type: "input",
          block_id: "cred_token_url_block",
          optional: true,
          label: { type: "plain_text", text: "Token URL (optional)" },
          element: {
            type: "plain_text_input",
            action_id: "cred_token_url",
            placeholder: { type: "plain_text", text: "https://cloud.airbyte.com/api/v1/applications/token" },
          },
        },
        {
          type: "context",
          elements: [
            {
              type: "mrkdwn",
              text: "If provided, credentials will be automatically exchanged for an access token when retrieved.",
            },
          ],
        },
      ]
    : [
        {
          type: "input",
          block_id: "cred_value_block",
          label: { type: "plain_text", text: "Value" },
          element: {
            type: "plain_text_input",
            action_id: "cred_value",
            placeholder: { type: "plain_text", text: "Paste your API token or key" },
          },
        },
      ];

  return [
    {
      type: "input",
      block_id: "cred_name_block",
      label: { type: "plain_text", text: "Name" },
      element: {
        type: "plain_text_input",
        action_id: "cred_name",
        placeholder: { type: "plain_text", text: "e.g. airbyte_api_token" },
      },
      hint: {
        type: "plain_text",
        text: "Lowercase, a-z, 0-9, underscores. e.g. airbyte_api_token",
      },
    },
    typeBlock,
    ...valueBlocks,
    {
      type: "input",
      block_id: "cred_expiry_block",
      label: { type: "plain_text", text: "Expiry Date (optional)" },
      optional: true,
      element: {
        type: "datepicker",
        action_id: "cred_expiry",
        placeholder: { type: "plain_text", text: "Select a date" },
      },
    },
  ];
}

export async function openAddCredentialModal(
  client: WebClient,
  triggerId: string,
): Promise<void> {
  await client.views.open({
    trigger_id: triggerId,
    view: {
      type: "modal",
      callback_id: "api_credential_add_submit",
      title: { type: "plain_text", text: "Add API Credential" },
      submit: { type: "plain_text", text: "Save" },
      close: { type: "plain_text", text: "Cancel" },
      blocks: buildAddCredentialBlocks("token"),
    },
  });
}

export async function openUpdateCredentialModal(
  client: WebClient,
  triggerId: string,
  credentialId: string,
  credentialName: string,
): Promise<void> {
  await client.views.open({
    trigger_id: triggerId,
    view: {
      type: "modal",
      callback_id: "api_credential_update_submit",
      private_metadata: credentialId,
      title: { type: "plain_text", text: `Update ${credentialName}` },
      submit: { type: "plain_text", text: "Save" },
      close: { type: "plain_text", text: "Cancel" },
      blocks: [
        {
          type: "input",
          block_id: "cred_value_block",
          label: { type: "plain_text", text: "New Value" },
          element: {
            type: "plain_text_input",
            action_id: "cred_value",
            placeholder: {
              type: "plain_text",
              text: "Paste the new token value",
            },
          },
        },
        {
          type: "context",
          elements: [
            {
              type: "mrkdwn",
              text: `This will replace the current value of *${credentialName}*. Encrypted at rest with AES-256-GCM.`,
            },
          ],
        },
      ],
    },
  });
}

export async function openShareCredentialModal(
  client: WebClient,
  triggerId: string,
  credentialId: string,
): Promise<void> {
  await client.views.open({
    trigger_id: triggerId,
    view: {
      type: "modal",
      callback_id: "api_credential_share_submit",
      private_metadata: credentialId,
      title: { type: "plain_text", text: "Share Credential" },
      submit: { type: "plain_text", text: "Share" },
      close: { type: "plain_text", text: "Cancel" },
      blocks: [
        {
          type: "input",
          block_id: "share_users_block",
          label: { type: "plain_text", text: "Share with" },
          element: {
            type: "users_select",
            action_id: "share_user",
            placeholder: { type: "plain_text", text: "Select a user" },
          },
        },
        {
          type: "input",
          block_id: "share_permission_block",
          label: { type: "plain_text", text: "Permission" },
          element: {
            type: "radio_buttons",
            action_id: "share_permission",
            options: [
              {
                text: { type: "plain_text", text: "Read" },
                value: "read",
                description: {
                  type: "plain_text",
                  text: "Can use the credential value",
                },
              },
              {
                text: { type: "plain_text", text: "Write" },
                value: "write",
                description: {
                  type: "plain_text",
                  text: "Can use for write operations",
                },
              },
              {
                text: { type: "plain_text", text: "Admin" },
                value: "admin",
                description: {
                  type: "plain_text",
                  text: "Can re-share with others",
                },
              },
            ],
            initial_option: {
              text: { type: "plain_text", text: "Read" },
              value: "read",
              description: {
                type: "plain_text",
                text: "Can use the credential value",
              },
            },
          },
        },
      ],
    },
  });
}

export async function openCredentialAccessModal(
  client: WebClient,
  triggerId: string,
  credentialId: string,
): Promise<void> {
  const cred = await getCredentialById(credentialId);
  if (!cred) return;

  const grants = await listGrantsForCredentials([credentialId]);

  const blocks: any[] = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*${cred.name}*`,
      },
    },
    { type: "divider" },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: "👑 <@" + cred.ownerId + "> — *Owner*",
      },
    },
  ];

  if (grants.length > 0) {
    for (const grant of grants) {
      blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: "👤 <@" + grant.granteeId + "> — *" + grant.permission + "*",
        },
      });
    }
  } else {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: "_No one else has access to this credential._",
      },
    });
  }

  await client.views.open({
    trigger_id: triggerId,
    view: {
      type: "modal",
      title: { type: "plain_text", text: "Credential Access" },
      close: { type: "plain_text", text: "Close" },
      blocks,
    },
  });
}

/**
 * Open a modal for editing a credential value.
 */
export async function openCredentialModal(
  client: WebClient,
  triggerId: string,
  credentialKey: string,
): Promise<void> {
  const cred = CREDENTIALS.find((c) => c.key === credentialKey);
  if (!cred) return;

  await client.views.open({
    trigger_id: triggerId,
    view: {
      type: "modal",
      callback_id: "credential_submit",
      private_metadata: credentialKey,
      title: { type: "plain_text", text: `Update ${cred.label}` },
      submit: { type: "plain_text", text: "Save" },
      close: { type: "plain_text", text: "Cancel" },
      blocks: [
        {
          type: "input",
          block_id: "credential_input_block",
          label: { type: "plain_text", text: cred.label },
          element: {
            type: "plain_text_input",
            action_id: "credential_value",
            placeholder: {
              type: "plain_text",
              text: "Paste the new token here",
            },
          },
        },
        {
          type: "context",
          elements: [
            {
              type: "mrkdwn",
              text: `This will replace the current ${cred.label}. The value is encrypted at rest with AES-256-GCM.`,
            },
          ],
        },
      ],
    },
  });
}

// ── Publish Home Tab ─────────────────────────────────────────────────────────

/**
 * Build and publish the App Home tab for a user.
 * Admins see editable dropdowns; everyone else sees a read-only view.
 */
export async function publishHomeTab(
  client: WebClient,
  userId: string,
): Promise<void> {
  try {
    const currentSettings = await getAllSettings();
    const admin = isAdmin(userId);

    const mainValue = currentSettings.model_main || DEFAULTS.model_main;
    const fastValue = currentSettings.model_fast || DEFAULTS.model_fast;
    const embeddingValue = currentSettings.model_embedding || DEFAULTS.model_embedding;

    const blocks: any[] = [
      {
        type: "header",
        text: { type: "plain_text", text: "Aura Settings" },
      },
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: admin
              ? "You're an admin. Changes take effect on the next message."
              : "Settings are managed by workspace admins. You're viewing read-only.",
          },
        ],
      },
      { type: "divider" },
    ];

    if (admin) {
      // Editable dropdowns
      blocks.push(
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: "*:brain: Main Model*\nUsed for conversation responses. Quality matters most here.",
          },
        },
        buildDropdown("select_model_main", "Main Model", MAIN_MODELS, mainValue),
        { type: "divider" },
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: "*:zap: Fast Model*\nUsed for memory extraction and profile updates. Speed and cost matter most.",
          },
        },
        buildDropdown("select_model_fast", "Fast Model", FAST_MODELS, fastValue),
        { type: "divider" },
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: "*:mag: Embedding Model*\nUsed for vectorizing memories and queries.\n:warning: _Changing this may require updating the DB vector dimensions (currently 1536)._",
          },
        },
        buildDropdown("select_model_embedding", "Embedding Model", EMBEDDING_MODELS, embeddingValue),
      );
    } else {
      // Read-only view
      const mainLabel = MAIN_MODELS.find((m) => m.value === mainValue)?.label || mainValue;
      const fastLabel = FAST_MODELS.find((m) => m.value === fastValue)?.label || fastValue;
      const embeddingLabel = EMBEDDING_MODELS.find((m) => m.value === embeddingValue)?.label || embeddingValue;

      blocks.push(
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `*:brain: Main Model:* ${mainLabel}\n*:zap: Fast Model:* ${fastLabel}\n*:mag: Embedding Model:* ${embeddingLabel}`,
          },
        },
      );
    }

    const userCredBlocks = await buildUserCredentialBlocks(userId);
    blocks.push(...userCredBlocks);

    if (admin) {
      const credBlocks = await buildCredentialBlocks();
      blocks.push(...credBlocks);
    }

    blocks.push(
      { type: "divider" },
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: "Models are routed through <https://vercel.com/ai-gateway|Vercel AI Gateway>. No API keys needed.",
          },
        ],
      },
    );

    await client.views.publish({
      user_id: userId,
      view: {
        type: "home",
        blocks,
      },
    });

    logger.info("Published App Home tab", { userId, isAdmin: admin });
  } catch (error) {
    logger.error("Failed to publish App Home tab", { userId, error });
  }
}

// ── Action ID Mapping ────────────────────────────────────────────────────────

/** Map dropdown action IDs to settings keys */
export const ACTION_TO_SETTING: Record<string, string> = {
  select_model_main: "model_main",
  select_model_fast: "model_fast",
  select_model_embedding: "model_embedding",
};

export { isAdmin } from "../lib/permissions.js";
