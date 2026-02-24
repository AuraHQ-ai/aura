import { tool } from "ai";
import { z } from "zod";
import { eq, and, gt, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { userProfiles, people, addresses, voiceCalls } from "../db/schema.js";
import type { ScheduleContext } from "../db/schema.js";
import { isAdmin } from "../lib/permissions.js";
import { logger } from "../lib/logger.js";

// ── Language Detection ──────────────────────────────────────────────────────

function detectLanguageFromPhone(phone: string): string {
  if (phone.startsWith("+34")) return "Spanish";
  if (phone.startsWith("+33")) return "French";
  if (phone.startsWith("+39")) return "Italian";
  if (phone.startsWith("+41")) return "English";
  return "English";
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

// ── Tool Definitions ─────────────────────────────────────────────────────────

export function createVoiceTools(context?: ScheduleContext): Record<string, any> {
  const tools: Record<string, any> = {};

  if (process.env.ELEVENLABS_API_KEY) {
    tools.make_call = tool({
      description:
        "Initiate an outbound phone call via ElevenLabs + Twilio. Aura's voice agent handles the conversation with the person's context injected. Use when a phone call would be more effective than a DM. Admin-only.",
      inputSchema: z
        .object({
          phone_number: z
            .string()
            .optional()
            .describe(
              "Phone number to call in E.164 format (e.g. +41791234567). Required if person_name is not provided.",
            ),
          person_name: z
            .string()
            .optional()
            .describe(
              "Name of the person to call. Will resolve their phone number from the database. Required if phone_number is not provided.",
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
              'Custom greeting for the call. Defaults to "I wanted to check in with you."',
            ),
          language: z
            .string()
            .optional()
            .describe(
              "Language for the call (e.g. 'Spanish', 'French'). Auto-detected from phone number country code if omitted.",
            ),
        })
        .refine((data) => data.phone_number || data.person_name, {
          message: "At least one of phone_number or person_name must be provided",
        }),
      execute: async ({
        phone_number,
        person_name,
        context: callContext,
        opener,
        language,
      }) => {
        if (!isAdmin(context?.userId)) {
          return {
            ok: false,
            error: "Only admins can initiate phone calls.",
          };
        }

        // DB-based rate limiting
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

        const apiKey = process.env.ELEVENLABS_API_KEY;
        const agentId = process.env.ELEVENLABS_AGENT_ID;
        const phoneNumberId = process.env.ELEVENLABS_PHONE_NUMBER_ID;

        if (!apiKey || !agentId || !phoneNumberId) {
          return {
            ok: false,
            error:
              "ElevenLabs voice config is incomplete. Required env vars: ELEVENLABS_API_KEY, ELEVENLABS_AGENT_ID, ELEVENLABS_PHONE_NUMBER_ID.",
          };
        }

        let resolvedPhone = phone_number;
        let resolvedName = person_name || "Unknown";

        if (!resolvedPhone && person_name) {
          const resolved = await resolvePhoneByName(person_name);
          if (!resolved) {
            return {
              ok: false,
              error: `Could not find a phone number for "${person_name}" in the database. Please provide the phone_number directly.`,
            };
          }
          resolvedPhone = resolved.phone;
          resolvedName = resolved.displayName;
        }

        if (!resolvedPhone) {
          return {
            ok: false,
            error:
              "No phone number available. Provide phone_number or a person_name that has a phone in the database.",
          };
        }

        const personLanguage =
          language || detectLanguageFromPhone(resolvedPhone);

        const dynamicVars = {
          person_name: resolvedName,
          call_context: callContext,
          call_opener: opener || "I wanted to check in with you.",
          person_language: personLanguage,
          direction: "outbound",
        };

        try {
          const response = await fetch(
            "https://api.elevenlabs.io/v1/convai/twilio/outbound-call",
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "xi-api-key": apiKey,
              },
              body: JSON.stringify({
                agent_id: agentId,
                agent_phone_number_id: phoneNumberId,
                to_number: resolvedPhone,
                conversation_initiation_client_data: {
                  dynamic_variables: dynamicVars,
                },
              }),
            },
          );

          if (!response.ok) {
            const errorBody = await response.text();
            logger.error("make_call ElevenLabs API error", {
              status: response.status,
              body: errorBody.substring(0, 500),
            });
            return {
              ok: false,
              error: `ElevenLabs API returned ${response.status}: ${errorBody.substring(0, 200)}`,
            };
          }

          const data = (await response.json()) as Record<string, unknown>;

          try {
            await db
              .insert(voiceCalls)
              .values({
                conversationId: data.conversation_id as string,
                agentId: process.env.ELEVENLABS_AGENT_ID,
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
              conversationId: data.conversation_id,
            });
          }

          logger.info("make_call tool called", {
            to: resolvedPhone,
            person: resolvedName,
            conversationId: data.conversation_id,
          });

          return {
            ok: true,
            message: `Call initiated to ${resolvedName} (${resolvedPhone})`,
            conversation_id: data.conversation_id as string,
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
