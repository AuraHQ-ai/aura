import { defineTool } from "../lib/tool.js";
import { z } from "zod";
import { logger } from "../lib/logger.js";

/**
 * Sentinel key used by the pipeline to detect card blocks in tool results.
 * When draw_cards is called, the execute function returns the built Slack
 * card blocks (one per section) under this key so respond.ts can attach
 * them to the current Slack stream (same capture mechanism as
 * TABLE_BLOCK_KEY/CHART_BLOCK_KEY). The value is an ARRAY of card blocks.
 */
export const CARD_BLOCK_KEY = "__card_blocks";

/** Slack's character limits for card block fields. */
const CARD_TITLE_MAX = 150;
const CARD_BODY_MAX = 200;
const MAX_SECTIONS = 10;

export interface CardSection {
  title: string;
  text: string;
}

export function buildCardBlock(sections: CardSection[]) {
  return sections.map((section) => ({
    type: "card" as const,
    title: { type: "mrkdwn" as const, text: section.title },
    body: { type: "mrkdwn" as const, text: section.text },
  }));
}

export function validateCardSections(sections: CardSection[]): string | null {
  if (sections.length < 1) {
    return "Need at least one section.";
  }
  if (sections.length > MAX_SECTIONS) {
    return `Max ${MAX_SECTIONS} sections allowed.`;
  }
  for (const [index, section] of sections.entries()) {
    if (!section.title.trim()) {
      return `Section ${index} title is required.`;
    }
    if (section.title.length > CARD_TITLE_MAX) {
      return `Section ${index} title is ${section.title.length} characters; max is ${CARD_TITLE_MAX}.`;
    }
    if (!section.text.trim()) {
      return `Section ${index} text is required.`;
    }
    if (section.text.length > CARD_BODY_MAX) {
      return `Section ${index} text is ${section.text.length} characters; max is ${CARD_BODY_MAX}. Keep card bodies concise and put longer content in the regular message text.`;
    }
  }
  return null;
}

export function createCardTools() {
  return {
    draw_cards: defineTool({
      description:
        "Render digest sections as native Slack card blocks at the bottom of your current reply — " +
        "each section becomes a titled card instead of a markdown wall. " +
        "Use this for recurring digest output (EOD reflections, weekly reports, gap/issue syncs) where " +
        "the message has distinct sections like WINS / NOTED / FOLLOW-UPS. " +
        "Do NOT use it for urgent escalations or tabular data (use draw_table).\n\n" +
        "Inputs:\n" +
        "- `sections`: 1-10 items, each with a `title` (max 150 characters) and `text` " +
        "(mrkdwn body, max 200 characters). Keep each card to a scannable summary; anything longer " +
        "belongs in the regular message text.\n\n" +
        "The cards attach inline to the current reply. Limited to one native block set " +
        "(alert/table/chart/cards) per reply.",
      inputSchema: z.object({
        sections: z
          .array(
            z.object({
              title: z
                .string()
                .min(1, "Section title is required")
                .max(CARD_TITLE_MAX, `Titles must be ${CARD_TITLE_MAX} characters or fewer`)
                .describe("Card title, e.g. 'WINS' or 'FOLLOW-UPS'. Maximum 150 characters."),
              text: z
                .string()
                .min(1, "Section text is required")
                .max(CARD_BODY_MAX, `Section text must be ${CARD_BODY_MAX} characters or fewer`)
                .describe(
                  "Card body in mrkdwn (bold, inline code, links supported). Maximum 200 characters.",
                ),
            }),
          )
          .min(1, "Need at least one section")
          .max(MAX_SECTIONS, `Max ${MAX_SECTIONS} sections`)
          .describe("Digest sections, one card per section, in display order."),
      }),
      execute: async ({ sections }) => {
        const error = validateCardSections(sections);
        if (error) return { ok: false, error };

        const cardBlocks = buildCardBlock(sections);
        logger.info("draw_cards tool called (inline)", {
          sectionCount: sections.length,
        });
        return { ok: true, [CARD_BLOCK_KEY]: cardBlocks };
      },
      slack: {
        status: "Drawing cards...",
        output: (r) => (r.ok !== false ? "Cards rendered" : r.error),
      },
    }),
  };
}
