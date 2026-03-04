import type { WebClient } from "@slack/web-api";
import { getAllSettings } from "../lib/settings.js";
import { isAdmin } from "../lib/permissions.js";
import { logger } from "../lib/logger.js";
import { getCredential, maskCredential } from "../lib/credentials.js";
import {
  listApiCredentials,
  maskApiCredential,
  storeApiCredential,
  deleteApiCredential,
  grantApiCredentialAccess,
  getApiCredential,
} from "../lib/api-credentials.js";
import { db } from "../db/client.js";
import { credentials, credentialGrants } from "../db/schema.js";
import { eq, and, isNull } from "drizzle-orm";

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
  { value: "cohere/embed-v4.0", label: "Cohere Embed v4.0 (1024d)" },
];

// ── System Credentials (admin-only) ─────────────────────────────────────────

const CREDENTIALS = [
  { key: "github_token", label: "GitHub Token", envFallback: "GH_TOKEN" },
];

/** Map of credential action_ids to credential keys (system credentials) */
export const CREDENTIAL_ACTIONS: Record<string, string> = {
  edit_credential_github_token: "github_token",
};

function buildDropdown(
  actionId: string,
  label: string,
  options: ModelOption[],
  currentValue: string,
): any {
  return {
    type: "actions",
    elements: [
      {
        type: "static_select",
        action_id: actionId,
        placeholder: { type: "plain_text", text: `Select ${label}` },
        options: options.map((o) => ({
          text: { type: "plain_text", text: o.label },
          value: o.value,
        })),
        ...(options.some((o) => o.value === currentValue)
          ? {
              initial_option: {
                text: {
                  type: "plain_text",
                  text: options.find((o) => o.value === currentValue)!.label,
                },
                value: currentValue,
              },
            }
          : {}),
      },
    ],
  };
}

// ── System Credential Blocks (admin-only) ───────────────────────────────────

async function buildCredentialBlocks(): Promise<any[]> {
  const blocks: any[] = [
    { type: "divider" },
    {
      type: "header",
      text: { type: "plain_text", text: "🔑 System Credentials" },
    },
  ];

  for (const cred of CREDENTIALS) {
    const value = await getCredential(cred.key);
    const masked = value ? maskCredential(value) : "(not set)";
    const envNote = !value && cred.envFallback ? ` — using $${cred.envFallback}` : "";

    blocks.push(
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*${cred.label}*\n\`${masked}\`${envNote}`,
        },
        accessory: {
          type: "button",
          text: { type: "plain_text", text: "Edit" },
          action_id: `edit_credential_${cred.key}`,
        },
      },
    );
  }

  return blocks;
}

/** Open a modal to edit a system credential */
export async function openCredentialModal(
  client: WebClient,
  triggerId: string,
  credentialKey: string,
): Promise<void> {
  const label = CREDENTIALS.find((c) => c.key === credentialKey)?.label || credentialKey;

  await client.views.open({
    trigger_id: triggerId,
    view: {
      type: "modal",
      callback_id: "credential_submit",
      private_metadata: credentialKey,
      title: { type: "plain_text", text: `Edit ${label}` },
      submit: { type: "plain_text", text: "Save" },
      close: { type: "plain_text", text: "Cancel" },
      blocks: [
        {
          type: "input",
          block_id: "credential_input_block",
          label: { type: "plain_text", text: `New value for ${label}` },
          element: {
            type: "plain_text_input",
            action_id: "credential_value",
            placeholder: { type: "plain_text", text: "Paste new token value" },
          },
        },
      ],
    },
  });
}

// ── Per-User Credential Blocks ──────────────────────────────────────────────

/**
 * Build blocks showing a user's own credentials + credentials shared with them.
 */
export async function buildUserCredentialBlocks(userId: string): Promise<any[]> {
  const blocks: any[] = [
    { type: "divider" },
    {
      type: "header",
      text: { type: "plain_text", text: "🔐 Your API Credentials" },
    },
  ];

  // 1) User's own credentials
  const ownCreds = await listApiCredentials(userId);

  // 2) Credentials shared with this user
  const grants = await db
    .select({
      credentialId: credentialGrants.credentialId,
      permission: credentialGrants.permission,
      grantedBy: credentialGrants.grantedBy,
      credName: credentials.name,
      credOwnerId: credentials.ownerId,
      credExpiresAt: credentials.expiresAt,
      credValue: credentials.value,
    })
    .from(credentialGrants)
    .innerJoin(credentials, eq(credentialGrants.credentialId, credentials.id))
    .where(
      and(
        eq(credentialGrants.granteeId, userId),
        isNull(credentialGrants.revokedAt),
      ),
    );

  if (ownCreds.length === 0 && grants.length === 0) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: "_No credentials stored yet. Add one to get started._",
      },
    });
  }

  // Own credentials
  for (const cred of ownCreds) {
    const expiryText = cred.expiresAt
      ? `\n_Expires: ${cred.expiresAt.toISOString().split("T")[0]}_`
      : "";

    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*${cred.name}* (yours)${expiryText}\nKey v${cred.keyVersion} · Updated ${cred.updatedAt.toISOString().split("T")[0]}`,
      },
      accessory: {
        type: "overflow",
        action_id: `api_credential_overflow_${cred.id}`,
        options: [
          {
            text: { type: "plain_text", text: "✏️ Update" },
            value: `update_${cred.id}_${cred.name}`,
          },
          {
            text: { type: "plain_text", text: "🔗 Share" },
            value: `share_${cred.id}`,
          },
          {
            text: { type: "plain_text", text: "🗑️ Delete" },
            value: `delete_${cred.id}_${cred.name}`,
          },
        ],
      },
    });
  }

  // Shared credentials
  for (const grant of grants) {
    const expiryText = grant.credExpiresAt
      ? `\n_Expires: ${grant.credExpiresAt.toISOString().split("T")[0]}_`
      : "";

    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*${grant.credName}* (shared by <@${grant.grantedBy}>) — ${grant.permission}${expiryText}`,
      },
    });
  }

  // Add credential button
  blocks.push({
    type: "actions",
    elements: [
      {
        type: "button",
        text: { type: "plain_text", text: "➕ Add Credential" },
        action_id: "api_credential_add",
        style: "primary",
      },
    ],
  });

  return blocks;
}

// ── User Credential Modals ──────────────────────────────────────────────────

/** Open modal to add a new credential */
export async function openAddCredentialModal(
  client: WebClient,
  triggerId: string,
): Promise<void> {
  await client.views.open({
    trigger_id: triggerId,
    view: {
      type: "modal",
      callback_id: "api_credential_add_submit",
      title: { type: "plain_text", text: "Add Credential" },
      submit: { type: "plain_text", text: "Save" },
      close: { type: "plain_text", text: "Cancel" },
      blocks: [
        {
          type: "input",
          block_id: "cred_name_block",
          label: { type: "plain_text", text: "Credential Name" },
          element: {
            type: "plain_text_input",
            action_id: "cred_name",
            placeholder: {
              type: "plain_text",
              text: "e.g. openai_key (lowercase, underscores)",
            },
          },
          hint: {
            type: "plain_text",
            text: "Must start with a letter, lowercase + underscores only, max 63 chars",
          },
        },
        {
          type: "input",
          block_id: "cred_value_block",
          label: { type: "plain_text", text: "Value" },
          element: {
            type: "plain_text_input",
            action_id: "cred_value",
            placeholder: { type: "plain_text", text: "Paste your API key or secret" },
          },
        },
        {
          type: "input",
          block_id: "cred_expiry_block",
          optional: true,
          label: { type: "plain_text", text: "Expiration Date (optional)" },
          element: {
            type: "datepicker",
            action_id: "cred_expiry",
            placeholder: { type: "plain_text", text: "Select a date" },
          },
        },
      ],
    },
  });
}

/** Open modal to update an existing credential's value */
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
          label: { type: "plain_text", text: `New value for ${credentialName}` },
          element: {
            type: "plain_text_input",
            action_id: "cred_value",
            placeholder: { type: "plain_text", text: "Paste new API key or secret" },
          },
        },
      ],
    },
  });
}

/** Open modal to share a credential with another user */
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
          block_id: "share_user_block",
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
          label: { type: "plain_text", text: "Permission level" },
          element: {
            type: "radio_buttons",
            action_id: "share_permission",
            options: [
              {
                text: { type: "plain_text", text: "Read — can use the credential" },
                value: "read",
              },
              {
                text: { type: "plain_text", text: "Write — can use and update" },
                value: "write",
              },
              {
                text: { type: "plain_text", text: "Admin — full access including sharing" },
                value: "admin",
              },
            ],
            initial_option: {
              text: { type: "plain_text", text: "Read — can use the credential" },
              value: "read",
            },
          },
        },
      ],
    },
  });
}

// ── Publish App Home Tab ────────────────────────────────────────────────────

export async function publishHomeTab(
  client: WebClient,
  userId: string,
): Promise<void> {
  try {
    const admin = isAdmin(userId);
    const settings = await getAllSettings();

    const mainValue = settings.model_main || MAIN_MODELS[0].value;
    const fastValue = settings.model_fast || FAST_MODELS[0].value;
    const embeddingValue = settings.model_embedding || EMBEDDING_MODELS[0].value;

    const blocks: any[] = [
      {
        type: "header",
        text: { type: "plain_text", text: "⚙️ Aura Settings" },
      },
    ];

    if (admin) {
      // Editable dropdowns for admins
      blocks.push(
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: "*:brain: Main Model*\nUsed for complex reasoning, tool calls, and long conversations.",
          },
        },
        buildDropdown("select_model_main", "Main Model", MAIN_MODELS, mainValue),
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: "*:zap: Fast Model*\nUsed for triage, summaries, and quick tasks.",
          },
        },
        buildDropdown("select_model_fast", "Fast Model", FAST_MODELS, fastValue),
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

    // Per-user credentials — available to ALL users (not admin-gated)
    const userCredBlocks = await buildUserCredentialBlocks(userId);
    blocks.push(...userCredBlocks);

    // Admin-only system credentials
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
