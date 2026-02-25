import { tool } from "ai";
import { z } from "zod";
import { eq, and, gt, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { userProfiles, people, addresses, voiceCalls } from "../db/schema.js";
import type { ScheduleContext } from "../db/schema.js";
import { isAdmin } from "../lib/permissions.js";
import { logger } from "../lib/logger.js";

// ── Language Config ──────────────────────────────────────────────────────────

const COMPANY_NAME = process.env.COMPANY_NAME ?? "RealAdvisor";

interface LanguageConfig {
  languageCode: string;
  firstMessage: string;
  defaultOpener: string;
}

const LANGUAGE_CONFIGS: Record<string, LanguageConfig> = {
  es: {
    languageCode: "es",
    firstMessage: `Hola {{person_name}}, soy Aura de ${COMPANY_NAME}. {{call_opener}}`,
    defaultOpener: "Quería ponerme en contacto contigo.",
  },
  fr: {
    languageCode: "fr",
    firstMessage: `Bonjour {{person_name}}, c'est Aura de ${COMPANY_NAME}. {{call_opener}}`,
    defaultOpener: "Je voulais prendre de vos nouvelles.",
  },
  it: {
    languageCode: "it",
    firstMessage: `Ciao {{person_name}}, sono Aura di ${COMPANY_NAME}. {{call_opener}}`,
    defaultOpener: "Volevo mettermi in contatto con te.",
  },
  en: {
    languageCode: "en",
    firstMessage: `Hi {{person_name}}, this is Aura from ${COMPANY_NAME}. {{call_opener}}`,
    defaultOpener: "I wanted to check in with you.",
  },
  de: {
    languageCode: "de",
    firstMessage: `Hallo {{person_name}}, hier ist Aura von ${COMPANY_NAME}. {{call_opener}}`,
    defaultOpener: "Ich wollte mich bei Ihnen melden.",
  },
};

const VOICE_MAP: Record<string, string> = {
  es: "SaqYcK3ZpDKBAImA8AdW", // Jane Doe
  fr: "SaqYcK3ZpDKBAImA8AdW", // Jane Doe
  it: "SaqYcK3ZpDKBAImA8AdW", // Jane Doe
  en: "SaqYcK3ZpDKBAImA8AdW", // Jane Doe
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

// ── Person Phone Resolution ──────────────────────────────────────────────────

async function resolvePhoneByName(
  personName: string,
): Promise<{ phone: string; displayName: string } | null> {
  const nameLower = personName.toLowerCase();

  const profiles = await db
    .select({
      displayName: userProfiles.displayName,
      personId: userProfiles.personId,
    })
    .from(userProfiles)
    .where(sql`lower(${userProfiles.displayName}) LIKE ${"%" + nameLower + "%"}`)
    .limit(5);

  for (const profile of profiles) {
    if (profile.personId) {
      const phoneAddresses = await db
        .select({ value: addresses.value })
        .from(addresses)
        .where(
          and(
            eq(addresses.personId, profile.personId),
            eq(addresses.channel, "phone"),
          ),
        )
        .limit(1);

      if (phoneAddresses.length > 0) {
        return {
          phone: phoneAddresses[0].value,
          displayName: profile.displayName,
        };
      }
    }
  }

  const peopleRows = await db
    .select({ id: people.id, displayName: people.displayName })
    .from(people)
    .where(sql`lower(${people.displayName}) LIKE ${"%" + nameLower + "%"}`)
    .limit(5);

  for (const person of peopleRows) {
    const phoneAddresses = await db
      .select({ value: addresses.value })
      .from(addresses)
      .where(
        and(
          eq(addresses.personId, person.id),
          eq(addresses.channel, "phone"),
        ),
      )
      .limit(1);

    if (phoneAddresses.length > 0) {
      return {
        phone: phoneAddresses[0].value,
        displayName: person.displayName || personName,
      };
    }
  }

  return null;
}

// ── ElevenLabs Agent Config ──────────────────────────────────────────────────

const ELEVENLABS_API_BASE = "https://api.elevenlabs.io/v1";

interface AgentDynamicVarPlaceholders {
  [key: string]: string | number | boolean;
}

interface ElevenLabsAgentConfigResponse {
  agent_id: string;
  conversation_config?: {
    agent?: {
      dynamic_variables?: {
        dynamic_variable_placeholders?: AgentDynamicVarPlaceholders;
      };
    };
  };
  phone_numbers?: Array<{
    provider: string;
    phone_number_id: string;
    phone_number: string;
  }>;
}

async function fetchAgentConfig(
  apiKey: string,
  agentId: string,
): Promise<ElevenLabsAgentConfigResponse> {
  const response = await fetch(
    `${ELEVENLABS_API_BASE}/convai/agents/${agentId}`,
    { headers: { "xi-api-key": apiKey } },
  );
  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `Failed to fetch agent config (${response.status}): ${text.substring(0, 200)}`,
    );
  }
  return response.json() as Promise<ElevenLabsAgentConfigResponse>;
}

function resolvePhoneNumberId(
  agentConfig: ElevenLabsAgentConfigResponse,
): string | undefined {
  const envId = process.env.ELEVENLABS_PHONE_NUMBER_ID;
  if (envId) return envId;

  const twilioPhone = agentConfig.phone_numbers?.find(
    (p) => p.provider === "twilio",
  );
  return twilioPhone?.phone_number_id;
}

// ── Tool Definitions ─────────────────────────────────────────────────────────

export function createVoiceTools(context?: ScheduleContext): Record<string, any> {
  const tools: Record<string, any> = {};

  if (process.env.ELEVENLABS_API_KEY) {
    tools.make_call = tool({
      description:
        "Initiate an outbound phone call via ElevenLabs + Twilio. Aura's voice agent handles the conversation with the person's context injected. Use when a phone call would be more effective than a DM. Admin-only. Supports specifying a custom agent_id or voice_id for different voice agents.",
      inputSchema: z
        .object({
          phone_number: z
            .string()
            .optional()
            .describe(
              "Phone number to call in E.164 format (e.g. +41791234567). Alias for to_number — use either one.",
            ),
          to_number: z
            .string()
            .optional()
            .describe(
              "Phone number to call in E.164 format. If omitted, resolves from person_name via database lookup.",
            ),
          person_name: z
            .string()
            .optional()
            .describe(
              "Name of the person to call. Will resolve their phone number from the database. Required if no phone number is provided.",
            ),
          context: z
            .string()
            .describe(
              "Why we are calling — injected into the voice agent as context.",
            ),
          opener: z
            .string()
            .optional()
            .describe(
              'Custom greeting for the call. Defaults to a language-appropriate greeting.',
            ),
          language: z
            .string()
            .optional()
            .describe(
              "Language code (es/fr/it/en/de). Auto-detected from phone number country code if omitted. Used to select voice from VOICE_MAP when no explicit voice_id is given.",
            ),
          voice_id: z
            .string()
            .optional()
            .describe(
              "ElevenLabs voice ID to override the agent's default voice. If omitted, selects from VOICE_MAP by language.",
            ),
          agent_id: z
            .string()
            .optional()
            .describe(
              "ElevenLabs agent ID to call with. Defaults to the ELEVENLABS_AGENT_ID env var.",
            ),
        })
        .refine(
          (data) => data.phone_number || data.to_number || data.person_name,
          {
            message:
              "At least one of phone_number, to_number, or person_name must be provided",
          },
        ),
      execute: async ({
        phone_number,
        to_number,
        person_name,
        context: callContext,
        opener,
        language,
        voice_id: voiceId,
        agent_id: agentIdParam,
      }) => {
        if (!isAdmin(context?.userId)) {
          return {
            ok: false,
            error: "Only admins can initiate phone calls.",
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
        const resolvedAgentId =
          agentIdParam || process.env.ELEVENLABS_AGENT_ID;

        if (!resolvedAgentId) {
          return {
            ok: false,
            error:
              "No agent ID available. Provide agent_id or set ELEVENLABS_AGENT_ID env var.",
          };
        }

        // Fetch agent config to discover required dynamic variables and phone number
        let agentConfig: ElevenLabsAgentConfigResponse;
        try {
          agentConfig = await fetchAgentConfig(apiKey, resolvedAgentId);
        } catch (err: any) {
          logger.error("make_call failed to fetch agent config", {
            agentId: resolvedAgentId,
            error: err.message,
          });
          return {
            ok: false,
            error: `Failed to fetch agent config: ${err.message}`,
          };
        }

        const phoneNumberId = resolvePhoneNumberId(agentConfig);
        if (!phoneNumberId) {
          return {
            ok: false,
            error:
              "No phone number ID available. Set ELEVENLABS_PHONE_NUMBER_ID env var or assign a Twilio number to the agent.",
          };
        }

        // Resolve the target phone number
        let resolvedPhone = to_number || phone_number;
        let resolvedName = person_name || "Unknown";

        if (!resolvedPhone && person_name) {
          const resolved = await resolvePhoneByName(person_name);
          if (!resolved) {
            return {
              ok: false,
              error: `Could not find a phone number for "${person_name}" in the database. Please provide to_number directly.`,
            };
          }
          resolvedPhone = resolved.phone;
          resolvedName = resolved.displayName;
        }

        if (!resolvedPhone) {
          return {
            ok: false,
            error:
              "No phone number available. Provide to_number, phone_number, or a person_name that has a phone in the database.",
          };
        }

        const langKey = language || detectLanguageFromPhone(resolvedPhone);
        const langConfig = getLanguageConfig(langKey);

        const resolvedVoiceId =
          voiceId ?? VOICE_MAP[langConfig.languageCode];
        const resolvedOpener = opener || langConfig.defaultOpener;
        const resolvedFirstMessage = langConfig.firstMessage
          .replace("{{person_name}}", resolvedName)
          .replace("{{call_opener}}", resolvedOpener);

        // Build dynamic variables from tool params
        const dynamicVars: Record<string, string | number | boolean> = {
          person_name: resolvedName,
          call_context: callContext,
          call_opener: resolvedOpener,
          person_language: langConfig.languageCode,
          direction: "outbound",
        };

        // Validate against agent's required dynamic variables
        const placeholders =
          agentConfig.conversation_config?.agent?.dynamic_variables
            ?.dynamic_variable_placeholders ?? {};

        const missingVars: string[] = [];
        for (const key of Object.keys(placeholders)) {
          if (dynamicVars[key] === undefined) {
            const defaultVal = placeholders[key];
            if (
              defaultVal !== undefined &&
              defaultVal !== null &&
              defaultVal !== ""
            ) {
              dynamicVars[key] = defaultVal;
            } else {
              missingVars.push(key);
            }
          }
        }

        if (missingVars.length > 0) {
          return {
            ok: false,
            error: `Agent requires dynamic variables that are missing and have no defaults: ${missingVars.join(", ")}. Provide them via context or update the agent config.`,
          };
        }

        // Build outbound call request with correct API format
        const outboundBody: Record<string, unknown> = {
          agent_id: resolvedAgentId,
          agent_phone_number_id: phoneNumberId,
          to_number: resolvedPhone,
          conversation_initiation_client_data: {
            conversation_config_override: {
              agent: {
                dynamic_variables: dynamicVars,
                first_message: resolvedFirstMessage,
                language: langConfig.languageCode,
              },
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

          const data = (await callResponse.json()) as {
            conversation_id?: string;
          };
          const conversationId =
            data.conversation_id ?? `unknown-${crypto.randomUUID()}`;

          try {
            await db
              .insert(voiceCalls)
              .values({
                conversationId,
                agentId: resolvedAgentId,
                direction: "outbound",
                phoneNumber: resolvedPhone,
                personName: resolvedName || null,
                slackUserId: context?.userId ?? null,
                status: "in_progress",
                callContext: callContext || null,
                dynamicVariables: dynamicVars,
              })
              .onConflictDoNothing();
          } catch (dbError: any) {
            logger.error("make_call DB insert failed (call was placed)", {
              error: dbError.message,
              conversationId,
            });
          }

          logger.info("make_call tool called", {
            to: resolvedPhone,
            person: resolvedName,
            agentId: resolvedAgentId,
            conversationId,
          });

          return {
            ok: true,
            message: `Call initiated to ${resolvedName} (${resolvedPhone})`,
            conversation_id: conversationId,
          };
        } catch (error: any) {
          logger.error("make_call tool failed", { error: error.message });
          return {
            ok: false,
            error: `Failed to initiate call: ${error.message}`,
          };
        }
      },
    });
  }

  tools.send_sms = tool({
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
            .onConflictDoNothing();
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
  });

  return tools;
}
