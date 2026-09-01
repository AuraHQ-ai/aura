import { describe, expect, it } from "vitest";
import {
  getSameDestinationPostText,
  isSubstantialDuplicate,
  normalizeForDuplicateComparison,
} from "./duplicate-reply.js";

const CHANNEL = "C088REN54FM";
const THREAD = "1785914837.997989";

describe("getSameDestinationPostText (issue #1343)", () => {
  it("matches send_thread_reply into the invoking thread by channel id", () => {
    expect(
      getSameDestinationPostText(
        "send_thread_reply",
        { channel: CHANNEL, thread_ts: THREAD, message: "the answer" },
        CHANNEL,
        THREAD,
      ),
    ).toBe("the answer");
  });

  it("matches send_thread_reply by thread_ts when the channel is an unresolvable name", () => {
    expect(
      getSameDestinationPostText(
        "send_thread_reply",
        { channel: "bugs", thread_ts: THREAD, message: "the answer" },
        CHANNEL,
        THREAD,
      ),
    ).toBe("the answer");
  });

  it("rejects send_thread_reply into a different thread or explicit different channel", () => {
    expect(
      getSameDestinationPostText(
        "send_thread_reply",
        { channel: CHANNEL, thread_ts: "1700000000.000001", message: "x" },
        CHANNEL,
        THREAD,
      ),
    ).toBeNull();
    expect(
      getSameDestinationPostText(
        "send_thread_reply",
        { channel: "C0OTHER123", thread_ts: THREAD, message: "x" },
        CHANNEL,
        THREAD,
      ),
    ).toBeNull();
  });

  it("matches send_channel_message only on the invoking channel id", () => {
    expect(
      getSameDestinationPostText(
        "send_channel_message",
        { channel: CHANNEL, message: "hello" },
        CHANNEL,
        THREAD,
      ),
    ).toBe("hello");
    expect(
      getSameDestinationPostText(
        "send_channel_message",
        { channel: "C0OTHER123", message: "hello" },
        CHANNEL,
        THREAD,
      ),
    ).toBeNull();
  });

  it("ignores other tools and malformed inputs", () => {
    expect(getSameDestinationPostText("send_dm", { message: "x" }, CHANNEL, THREAD)).toBeNull();
    expect(getSameDestinationPostText("send_thread_reply", null, CHANNEL, THREAD)).toBeNull();
    expect(
      getSameDestinationPostText("send_thread_reply", { thread_ts: THREAD }, CHANNEL, THREAD),
    ).toBeNull();
  });
});

describe("isSubstantialDuplicate (issue #1343)", () => {
  const posted =
    "Numbers are internally consistent: 26 agencies with ranking data, 14 with a paid " +
    "subscription, and the ranking rule only counts agencies with 3+ listings. " +
    "Thanks <@U07GUILLAUME> for flagging it.";

  it("detects an exact repost (modulo formatting)", () => {
    expect(
      isSubstantialDuplicate(
        "*Numbers are internally consistent:* 26 agencies with ranking data, 14 with a paid " +
          "subscription, and the ranking rule only counts agencies with 3+ listings. " +
          "Thanks <@U07GUILLAUME> for flagging it.",
        [posted],
      ),
    ).toBe(true);
  });

  it("detects the 'Posted in-thread.' restatement pattern from the issue", () => {
    expect(
      isSubstantialDuplicate(
        "*Posted in-thread.* Numbers are internally consistent — 26 agencies with ranking data, " +
          "14 with a paid subscription; the ranking rule only counts agencies with 3+ listings.",
        [posted],
      ),
    ).toBe(true);
  });

  it("detects a final text fully contained in the posted message", () => {
    expect(
      isSubstantialDuplicate(
        "the ranking rule only counts agencies with 3+ listings",
        [posted],
      ),
    ).toBe(true);
  });

  it("does not flag genuinely different final text", () => {
    expect(
      isSubstantialDuplicate(
        "I also opened issue #1344 to track the subscription mismatch and pinged the data " +
          "team about backfilling the missing rows tomorrow morning.",
        [posted],
      ),
    ).toBe(false);
  });

  it("does not flag a short status note that shares few words with the post", () => {
    expect(
      isSubstantialDuplicate("Done — let me know if anything looks off.", [posted]),
    ).toBe(false);
  });

  it("handles empty inputs safely", () => {
    expect(isSubstantialDuplicate("", [posted])).toBe(false);
    expect(isSubstantialDuplicate("anything", [])).toBe(false);
    expect(isSubstantialDuplicate("anything", [""])).toBe(false);
  });

  it("normalizes Slack entities and mrkdwn before comparing", () => {
    expect(normalizeForDuplicateComparison("*Hello* <@U123> — check <https://x.dev|the docs>!"))
      .toBe("hello check the docs");
  });
});
