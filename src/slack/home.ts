import type { WebClient } from "@slack/web-api";
import { getAllSettings } from "../lib/settings.js";
import { isAdmin } from "../lib/permissions.js";
import { logger } from "../lib/logger.js";
import { getCredential, maskCredential } from "../lib/credentials.js";

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
