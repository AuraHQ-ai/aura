import { defineTool } from "../lib/tool.js";
import { z } from "zod";
import { eq, and, gt, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { voiceCalls } from "../db/schema.js";
import type { ScheduleContext } from "../db/schema.js";
import { isAdmin } from "../lib/permissions.js";
import { logger } from "../lib/logger.js";

// ── Language Config ──────────────────────────────────────────────────────────

interface LanguageConfig {
  languageCode: string;
}

const LANGUAGE_CONFIGS: Record<string, LanguageConfig> = {
  es: { languageCode: "es" },
  fr: { languageCode: "fr" },
  it: { languageCode: "it" },
  en: { languageCode: "en" },
  de: { languageCode: "de" },
};

const DEFAULT_LANGUAGE = "en";

function getLanguageConfig(lang: string): LanguageConfig {
  const key = lang.toLowerCase().slice(0, 2);
  return LANGUAGE_CONFIGS[key] ?? LANGUAGE_CONFIGS[DEFAULT_LANGUAGE];
}

function detectLanguageFromPhone(phone: string): string {
  if (phone.startsWith("+34")) return "es";
  if (phone.startsWith("+33")) return "fr";
  if (phone.startsWith("+39")) return "it";
  if (phone.startsWith("+41")) return "de";
  if (phone.startsWith("+44") || phone.startsWith("+1")) return "en";
  return DEFAULT_LANGUAGE;
}

const ELEVENLABS_API_BASE = "https://api.elevenlabs.io/v1";

// ── ElevenLabs Discovery Cache ──────────────────────────────────────────────

interface ElevenLabsAgent {
  name: string;
  agent_id: string;
}

interface ElevenLabsPhone {
  phone_number: string;
  label: string;
  phone_number_id: string;
  agent_id: string | null;
}

interface ElevenLabsVoice {
  name: string;
  voice_id: string;
  category: string;
}

interface ElevenLabsCacheData {
  agents: ElevenLabsAgent[];
  phones: ElevenLabsPhone[];
  voices: ElevenLabsVoice[];
  ts: number;
}

let elevenLabsCache: ElevenLabsCacheData | null = null;

const CACHE_TTL_MS = 10 * 60 * 1000;
const FETCH_TIMEOUT_MS = 5_000;

async function getElevenLabsData(): Promise<ElevenLabsCacheData> {
  // Return fresh cache if available
  if (elevenLabsCache && Date.now() - elevenLabsCache.ts < CACHE_TTL_MS) {
    return elevenLabsCache;
  }

  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) throw new Error("ELEVENLABS_API_KEY not set");

  const headers = { "xi-api-key": apiKey };

  // Use a helper that never throws -- returns null on timeout/error
  async function safeFetch(url: string): Promise<Response | null> {
    try {
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      return res.ok ? res : null;
    } catch {
      return null;
    }
  }

  // Run all 3 in parallel; a single slow/down endpoint won't block the others
  const [agentsRes, phonesRes, voicesRes] = await Promise.all([
    safeFetch(`${ELEVENLABS_API_BASE}/convai/agents`),
    safeFetch(`${ELEVENLABS_API_BASE}/convai/phone-numbers`),
    safeFetch(`${ELEVENLABS_API_BASE}/voices`),
  ]);

  // If ALL endpoints failed and we have stale cache, return it rather than throwing
  if (!agentsRes && !phonesRes && !voicesRes && elevenLabsCache) {
    return elevenLabsCache;
  }

  // Agents is the only mandatory endpoint
  if (!agentsRes) {
    throw new Error("ElevenLabs ConversationalAI API is unreachable (agents endpoint timed out)");
  }

  const agentsData = (await agentsRes.json()) as { agents?: Array<{ name: string; agent_id: string }> };
  const phonesData = phonesRes
    ? ((await phonesRes.json()) as Array<{
        phone_number: string;
        label?: string;
        phone_number_id: string;
        assigned_agent?: { agent_id: string } | null;
      }>)
    : [];
  const voicesData = voicesRes
    ? ((await voicesRes.json()) as { voices?: Array<{ name: string; voice_id: string; category?: string }> })
    : { voices: [] };

  const agents: ElevenLabsAgent[] = (agentsData.agents ?? [])
    .filter((a): a is NonNullable<typeof a> => a != null)
    .map((a) => ({ name: a.name, agent_id: a.agent_id }));

  const phones: ElevenLabsPhone[] = (Array.isArray(phonesData) ? phonesData : [])
    .filter((p): p is NonNullable<typeof p> => p != null)
    .map((p) => ({
      phone_number: p.phone_number,
      label: p.label ?? "",
      phone_number_id: p.phone_number_id,
      agent_id: p.assigned_agent?.agent_id ?? null,
    }));

  const voices: ElevenLabsVoice[] = (voicesData.voices ?? [])
    .filter((v): v is NonNullable<typeof v> => v != null)
    .map((v) => ({
      name: v.name,
      voice_id: v.voice_id,
      category: v.category ?? "unknown",
    }));

  elevenLabsCache = { agents, phones, voices, ts: Date.now() };
  return elevenLabsCache;
}

async function resolvePhoneNumberIdFromCache(
  fromNumber: string | undefined,
): Promise<string | null> {
  if (!fromNumber) return null;

  // First try: use cached phones list (populated from /convai/phone-numbers, may be [])
  try {
    const data = await getElevenLabsData();
    const match = data.phones.find((p) => p.phone_number === fromNumber);
    if (match?.phone_number_id) return match.phone_number_id;
  } catch {
    // fall through
  }

  // Second try: search phone numbers embedded in each agent config via /convai/agents
  // This endpoint is more reliable than /convai/phone-numbers
  try {
    const apiKey = process.env.ELEVENLABS_API_KEY;
    if (!apiKey) return null;
    const res = await fetch(
      `${ELEVENLABS_API_BASE}/convai/agents?page_size=50`,
      { headers: { "xi-api-key": apiKey }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) },
    );
    if (res.ok) {
      const json = (await res.json()) as { agents?: Array<{ phone_numbers?: Array<{ phone_number: string; phone_number_id: string }> }> };
      const agents = json.agents ?? [];
      for (const agent of agents) {
        const match = (agent.phone_numbers ?? []).find(
          (p) => p.phone_number === fromNumber,
        );
        if (match?.phone_number_id) return match.phone_number_id;
      }
    }
  } catch {
    // no match found
  }

  return null;
}

// ── Tool Definitions ─────────────────────────────────────────────────────────

export function createVoiceTools(context?: ScheduleContext): Record<string, any> {
  const tools: Record<string, any> = {};

  if (process.env.ELEVENLABS_API_KEY) {
    // ── list_voice_agents ───────────────────────────────────────────
    tools.list_voice_agents = defineTool({
      description:
        "List available ElevenLabs voice agents, phone numbers, and voices. " +
        "Call this BEFORE make_call when the user asks to call with a specific agent, " +
        "voice, or phone number so you can resolve names to IDs. " +
        "Results are cached for 10 minutes. Admin-only.",
      inputSchema: z.object({}),
      execute: async () => {
        if (!isAdmin(context?.userId)) {
          return { ok: false, error: "Only admins can list voice agents." };
        }

        try {
          const data = await getElevenLabsData();

          const agentsSummary = data.agents.map((a) => `• ${a.name} → ${a.agent_id}`).join("\n");
          const phonesSummary = data.phones
            .map((p) => {
              const label = p.label ? ` (${p.label})` : "";
              const assigned = p.agent_id ? ` [assigned to ${p.agent_id}]` : "";
              return `• ${p.phone_number}${label} → ${p.phone_number_id}${assigned}`;
            })
            .join("\n");
          const voicesSummary = data.voices
            .map((v) => `• ${v.name} (${v.category}) → ${v.voice_id}`)
            .join("\n");

          return {
            ok: true,
            agents: data.agents,
            phones: data.phones,
            voices: data.voices,
            summary: [
              `**Agents (${data.agents.length}):**`,
              agentsSummary || "(none)",
              "",
              `**Phone Numbers (${data.phones.length}):**`,
              phonesSummary || "(none)",
              "",
              `**Voices (${data.voices.length}):**`,
              voicesSummary || "(none)",
            ].join("\n"),
          };
        } catch (error: any) {
          logger.error("list_voice_agents failed", { error: error.message });
          return { ok: false, error: `Failed to list voice agents: ${error.message}` };
        }
      },
      slack: { status: "Listing voice agents..." },
    });

    // ── make_call ───────────────────────────────────────────────────
    const DEFAULT_AGENT_ID = process.env.ELEVENLABS_AGENT_ID ?? "agent_9301kj9tjcqaermrz71vvr0fpv4v";
    const DEFAULT_FROM_NUMBER = process.env.ELEVENLABS_FROM_NUMBER ?? "+14158860211";
    const DEFAULT_VOICE_ID = process.env.ELEVENLABS_VOICE_ID ?? "upcns7xCtWHwsgL2HKV5";

    tools.make_call = defineTool({
      description:
        "Initiate an outbound phone call via ElevenLabs + Twilio. " +
        "Use list_voice_agents first to discover available agents/phones/voices, " +
        "then pass IDs here. When providing a prompt, bake the person's name directly " +
        "into the text (don't use {{person_name}} placeholders — ElevenLabs only resolves " +
        "dynamic variables in first_message, not in the prompt body). Admin-only.",
      inputSchema: z.object({
        agent_id: z
          .string()
          .optional()
          .describe(
            "Agent ID from list_voice_agents. Default: Sales Booking agent",
          ),
        from_number: z
          .string()
          .optional()
          .describe(
            "Caller phone number from list_voice_agents. Default: +14158860211. " +
            "Used to resolve the agent_phone_number_id via cache lookup.",
          ),
        agent_phone_number_id: z
          .string()
          .optional()
          .describe(
            "ElevenLabs phone_number_id directly. If provided, skips from_number resolution. " +
            "Get this from list_voice_agents.",
          ),
        to_number: z
          .string()
          .describe(
            "Recipient phone in E.164 format, e.g. +34612345678",
          ),
        voice_id: z
          .string()
          .optional()
          .describe(
            "Voice ID from list_voice_agents. Default: Penelope",
          ),
        person_name: z
          .string()
          .optional()
          .describe(
            "Name of the person being called — injected as a dynamic variable.",
          ),
        prompt: z
          .string()
          .optional()
          .describe(
            "Full agent prompt with the person's name already baked in (no {{}} placeholders). " +
            "Sent as conversation_config_override to replace the agent's default prompt for this call.",
          ),
        context: z
          .string()
          .optional()
          .describe(
            "Why we are calling — logged for tracking purposes.",
          ),
        language: z
          .string()
          .optional()
          .describe(
            "Language code (es/fr/it/en/de). Auto-detected from phone number if omitted.",
          ),
      }),
      execute: async ({
        agent_id: agentIdParam,
        from_number: fromNumber,
        agent_phone_number_id: phoneNumberIdParam,
        to_number: toNumber,
        voice_id: voiceId,
        person_name,
        prompt,
        context: callContext,
        language,
      }) => {
        if (!isAdmin(context?.userId)) {
          return {
            ok: false,
            error: "Only admins can initiate phone calls.",
          };
        }

        const e164Regex = /^\+[1-9]\d{6,14}$/;
        if (!e164Regex.test(toNumber)) {
          return {
            ok: false,
            error: `Invalid phone number "${toNumber}". Must be E.164 format (e.g. +34612345678).`,
          };
        }

        const recentCalls = await db
          .select({ count: sql`count(*)` })
          .from(voiceCalls)
          .where(
            and(
              gt(voiceCalls.createdAt, sql`now() - interval '1 hour'`),
              eq(voiceCalls.direction, "outbound"),
            ),
          );
        if (Number(recentCalls[0]?.count || 0) >= 10) {
          return {
            ok: false,
            error: "Rate limit: too many outbound calls in the last hour.",
          };
        }

        const apiKey = process.env.ELEVENLABS_API_KEY!;
        const resolvedAgentId = agentIdParam || DEFAULT_AGENT_ID;

        // Resolve phone_number_id: prefer direct param, then env var, then cache lookup
        let phoneNumberId = phoneNumberIdParam || process.env.ELEVENLABS_PHONE_NUMBER_ID || null;

        if (!phoneNumberId) {
          const resolvedFromNumber = fromNumber || DEFAULT_FROM_NUMBER;
          phoneNumberId = await resolvePhoneNumberIdFromCache(resolvedFromNumber);
        }

        if (!phoneNumberId) {
          return {
            ok: false,
            error:
              "Could not resolve phone_number_id. Pass agent_phone_number_id directly, " +
              "or use list_voice_agents to find valid phone numbers.",
          };
        }

        const resolvedName = person_name || "Unknown";
        const langKey = language || detectLanguageFromPhone(toNumber);
        const langConfig = getLanguageConfig(langKey);
        const resolvedVoiceId = voiceId ?? DEFAULT_VOICE_ID;

        const dynamicVars: Record<string, string | number | boolean> = {
          person_name: resolvedName,
          person_language: langConfig.languageCode,
          direction: "outbound",
        };

        const agentOverride: Record<string, unknown> = {
          first_message: "",
          language: langConfig.languageCode,
        };

        if (prompt) {
          agentOverride.prompt = { prompt };
        }

        const outboundBody: Record<string, unknown> = {
          agent_id: resolvedAgentId,
          agent_phone_number_id: phoneNumberId,
          to_number: toNumber,
          conversation_initiation_client_data: {
            dynamic_variables: dynamicVars,
            conversation_config_override: {
              agent: agentOverride,
              ...(resolvedVoiceId
                ? { tts: { voice_id: resolvedVoiceId } }
                : {}),
            },
          },
        };

        try {
          const callResponse = await fetch(
            `${ELEVENLABS_API_BASE}/convai/twilio/outbound-call`,
            {
              method: "POST",
              headers: {
                "xi-api-key": apiKey,
                "Content-Type": "application/json",
              },
              body: JSON.stringify(outboundBody),
              signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
            },
          );

          if (!callResponse.ok) {
            const errorText = await callResponse.text();
            logger.error("make_call ElevenLabs API error", {
              statusCode: callResponse.status,
              body: errorText.substring(0, 500),
            });
            return {
              ok: false,
              error: `ElevenLabs API error (${callResponse.status}): ${errorText.substring(0, 200)}`,
            };
          }

          let data: { conversation_id?: string };
          try {
            data = (await callResponse.json()) as {
              conversation_id?: string;
            };
          } catch (parseError: any) {
            try { await callResponse.body?.cancel(); } catch {}
            logger.error("make_call response JSON parse failed (call may have been placed)", {
              error: parseError.message,
              to: toNumber,
            });
            return {
              ok: true,
              message: `Call likely placed to ${resolvedName} (${toNumber}), but the response could not be parsed. Do not retry — the call may already be in progress.`,
              conversation_id: null,
            };
          }

          const conversationId = data.conversation_id;
          const trackingWarning = conversationId
            ? undefined
            : "ElevenLabs did not return a conversation_id; call tracking and webhooks may not work for this call.";

          if (conversationId) {
            try {
              await db
                .insert(voiceCalls)
                .values({
                  conversationId,
                  agentId: resolvedAgentId,
                  direction: "outbound",
                  phoneNumber: toNumber,
                  personName: resolvedName || null,
                  slackUserId: context?.userId ?? null,
                  status: "in_progress",
                  callContext: callContext || null,
                  dynamicVariables: dynamicVars,
                })
                .onConflictDoNothing({ target: voiceCalls.conversationId });
            } catch (dbError: any) {
              logger.error("make_call DB insert failed (call was placed)", {
                error: dbError.message,
                conversationId,
              });
            }
          } else {
            logger.warn("make_call: no conversation_id returned, skipping DB insert", {
              to: toNumber,
            });
          }

          logger.info("make_call tool called", {
            to: toNumber,
            person: resolvedName,
            agentId: resolvedAgentId,
            conversationId: conversationId ?? null,
          });

          return {
            ok: true,
            message: `Call initiated to ${resolvedName} (${toNumber})`,
            conversation_id: conversationId ?? null,
            ...(trackingWarning ? { warning: trackingWarning } : {}),
          };
        } catch (error: any) {
          logger.error("make_call tool failed", { error: error.message });
          return {
            ok: false,
            error: `Failed to initiate call: ${error.message}`,
          };
        }
      },
      slack: { status: "Placing call...", detail: (i) => i.to_number },
    });
  }

  tools.send_sms = defineTool({
    description:
      "Send an SMS text message via Twilio. Use for quick notifications or when someone isn't responding to Slack. Admin-only.",
    inputSchema: z.object({
      phone_number: z
        .string()
        .describe(
          "Recipient phone number in E.164 format (e.g. +41791234567).",
        ),
      message: z
        .string()
        .describe("The SMS message body to send."),
    }),
    execute: async ({ phone_number, message }) => {
      if (!isAdmin(context?.userId)) {
        return {
          ok: false,
          error: "Only admins can send SMS messages.",
        };
      }

      const recentSms = await db
        .select({ count: sql`count(*)` })
        .from(voiceCalls)
        .where(
          and(
            gt(voiceCalls.createdAt, sql`now() - interval '1 hour'`),
            eq(voiceCalls.direction, "sms_outbound"),
          ),
        );
      if (Number(recentSms[0]?.count || 0) >= 10) {
        return {
          ok: false,
          error: "Rate limit: too many outbound SMS messages in the last hour.",
        };
      }

      const accountSid = process.env.TWILIO_ACCOUNT_SID;
      const authToken = process.env.TWILIO_AUTH_TOKEN;
      const fromNumber = process.env.TWILIO_PHONE_NUMBER;

      if (!fromNumber) {
        return {
          ok: false,
          error:
            "TWILIO_PHONE_NUMBER env var not set. Cannot send SMS without a configured phone number.",
        };
      }

      if (!accountSid || !authToken) {
        return {
          ok: false,
          error:
            "Twilio config is incomplete. Required env vars: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN.",
        };
      }

      try {
        const url = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`;
        const credentials = Buffer.from(
          `${accountSid}:${authToken}`,
        ).toString("base64");

        const body = new URLSearchParams({
          To: phone_number,
          From: fromNumber,
          Body: message,
        });

        const response = await fetch(url, {
          method: "POST",
          headers: {
            Authorization: `Basic ${credentials}`,
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: body.toString(),
        });

        if (!response.ok) {
          const errorBody = await response.text();
          logger.error("send_sms Twilio API error", {
            status: response.status,
            body: errorBody.substring(0, 500),
          });
          return {
            ok: false,
            error: `Twilio API returned ${response.status}: ${errorBody.substring(0, 200)}`,
          };
        }

        const data = (await response.json()) as Record<string, unknown>;

        try {
          await db
            .insert(voiceCalls)
            .values({
              conversationId: data.sid as string,
              direction: "sms_outbound",
              phoneNumber: phone_number,
              slackUserId: context?.userId ?? null,
              status: "completed",
              callContext: message,
            })
            .onConflictDoNothing({ target: voiceCalls.conversationId });
        } catch (dbError: any) {
          logger.error("send_sms DB insert failed (SMS was sent)", {
            error: dbError.message,
            messageSid: data.sid,
          });
        }

        logger.info("send_sms tool called", {
          to: phone_number,
          messageSid: data.sid,
          status: data.status,
        });

        return {
          ok: true,
          message: `SMS sent to ${phone_number}`,
          message_sid: data.sid as string,
          status: data.status as string,
        };
      } catch (error: any) {
        logger.error("send_sms tool failed", { error: error.message });
        return {
          ok: false,
          error: `Failed to send SMS: ${error.message}`,
        };
      }
    },
    slack: { status: "Sending SMS...", detail: (i) => i.phone_number },
  });

  return tools;
}
