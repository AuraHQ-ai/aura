import { logger } from "./logger.js";

// ── Types ───────────────────────────────────────────────────────────────────

export interface CalendarEvent {
  id: string;
  summary: string;
  description?: string;
  start: string; // ISO datetime
  end: string;
  location?: string;
  attendees?: { email: string; responseStatus?: string }[];
  htmlLink?: string;
  status?: string;
  organizer?: { email: string; displayName?: string };
}

export interface FreeBusySlot {
  start: string;
  end: string;
}

export interface AvailableSlot {
  start: string;
  end: string;
}

// ── Calendar Client ─────────────────────────────────────────────────────────

async function getCalendarClient() {
  const { getOAuth2Client } = await import("./gmail.js");
  const auth = await getOAuth2Client();
  if (!auth) return null;

  const { calendar_v3 } = await import("@googleapis/calendar");
  return new calendar_v3.Calendar({ auth });
}

// ── List Events ─────────────────────────────────────────────────────────────

export async function listEvents(opts: {
  calendarId?: string;
  timeMin?: string;
  timeMax?: string;
  maxResults?: number;
  query?: string;
}): Promise<CalendarEvent[] | null> {
  const client = await getCalendarClient();
  if (!client) return null;

  const calendarId = opts.calendarId || "primary";
  const now = new Date().toISOString();

  const res = await client.events.list({
    calendarId,
    timeMin: opts.timeMin || now,
    timeMax: opts.timeMax,
    maxResults: opts.maxResults || 20,
    singleEvents: true,
    orderBy: "startTime",
    q: opts.query,
  });

  return (res.data.items || []).map((e) => ({
    id: e.id || "",
    summary: e.summary || "(no title)",
    description: e.description || undefined,
    start: e.start?.dateTime || e.start?.date || "",
    end: e.end?.dateTime || e.end?.date || "",
    location: e.location || undefined,
    attendees: e.attendees?.map((a) => ({
      email: a.email || "",
      responseStatus: a.responseStatus || undefined,
    })),
    htmlLink: e.htmlLink || undefined,
    status: e.status || undefined,
    organizer: e.organizer
      ? {
          email: e.organizer.email || "",
          displayName: e.organizer.displayName || undefined,
        }
      : undefined,
  }));
}

// ── Create Event ────────────────────────────────────────────────────────────

export async function createEvent(opts: {
  summary: string;
  description?: string;
  start: string; // ISO datetime
  end: string;
  attendees?: string[]; // email addresses
  location?: string;
  calendarId?: string;
}): Promise<CalendarEvent | null> {
  const client = await getCalendarClient();
  if (!client) return null;

  const calendarId = opts.calendarId || "primary";

  const res = await client.events.insert({
    calendarId,
    sendUpdates: "all",
    requestBody: {
      summary: opts.summary,
      description: opts.description,
      location: opts.location,
      start: { dateTime: opts.start },
      end: { dateTime: opts.end },
      attendees: opts.attendees?.map((email) => ({ email })),
    },
  });

  const e = res.data;
  logger.info("Calendar event created", {
    id: e.id,
    summary: e.summary,
  });

  return {
    id: e.id || "",
    summary: e.summary || "",
    description: e.description || undefined,
    start: e.start?.dateTime || e.start?.date || "",
    end: e.end?.dateTime || e.end?.date || "",
    location: e.location || undefined,
    attendees: e.attendees?.map((a) => ({
      email: a.email || "",
      responseStatus: a.responseStatus || undefined,
    })),
    htmlLink: e.htmlLink || undefined,
    status: e.status || undefined,
  };
}

// ── Delete Event ─────────────────────────────────────────────────────────────

export async function deleteEvent(eventId: string): Promise<boolean> {
  const client = await getCalendarClient();
  if (!client) return false;

  await client.events.delete({ calendarId: "primary", eventId, sendUpdates: "all" });

  logger.info("Calendar event deleted", { eventId });
  return true;
}

// ── Update Event ─────────────────────────────────────────────────────────────

export async function updateEvent(
  eventId: string,
  updates: {
    summary?: string;
    description?: string;
    start?: string;
    end?: string;
    location?: string;
    attendees?: string[];
  },
): Promise<CalendarEvent | null> {
  const client = await getCalendarClient();
  if (!client) return null;

  const requestBody: Record<string, unknown> = {};
  if (updates.summary !== undefined) requestBody.summary = updates.summary;
  if (updates.description !== undefined)
    requestBody.description = updates.description;
  if (updates.location !== undefined) requestBody.location = updates.location;
  if (updates.start !== undefined)
    requestBody.start = { dateTime: updates.start };
  if (updates.end !== undefined) requestBody.end = { dateTime: updates.end };
  if (updates.attendees !== undefined)
    requestBody.attendees = updates.attendees.map((email) => ({ email }));

  const res = await client.events.patch({
    calendarId: "primary",
    eventId,
    sendUpdates: "all",
    requestBody,
  });

  const e = res.data;
  logger.info("Calendar event updated", { id: e.id, summary: e.summary });

  return {
    id: e.id || "",
    summary: e.summary || "",
    description: e.description || undefined,
    start: e.start?.dateTime || e.start?.date || "",
    end: e.end?.dateTime || e.end?.date || "",
    location: e.location || undefined,
    attendees: e.attendees?.map((a) => ({
      email: a.email || "",
      responseStatus: a.responseStatus || undefined,
    })),
    htmlLink: e.htmlLink || undefined,
    status: e.status || undefined,
  };
}

// ── Free/Busy ───────────────────────────────────────────────────────────────

export async function checkFreeBusy(opts: {
  emails: string[];
  timeMin: string;
  timeMax: string;
}): Promise<Record<string, FreeBusySlot[]> | null> {
  const client = await getCalendarClient();
  if (!client) return null;

  const res = await client.freebusy.query({
    requestBody: {
      timeMin: opts.timeMin,
      timeMax: opts.timeMax,
      items: opts.emails.map((email) => ({ id: email })),
    },
  });

  const result: Record<string, FreeBusySlot[]> = {};
  const calendars = res.data.calendars || {};

  for (const email of opts.emails) {
    const cal = calendars[email];
    result[email] = (cal?.busy || []).map((slot) => ({
      start: slot.start || "",
      end: slot.end || "",
    }));
  }

  return result;
}

// ── Find Available Slots ────────────────────────────────────────────────────

export async function findAvailableSlots(opts: {
  emails: string[];
  timeMin: string;
  timeMax: string;
  durationMinutes: number;
}): Promise<AvailableSlot[] | null> {
  const busyData = await checkFreeBusy({
    emails: opts.emails,
    timeMin: opts.timeMin,
    timeMax: opts.timeMax,
  });
  if (!busyData) return null;

  // Merge all busy slots across all people
  const allBusy: { start: number; end: number }[] = [];
  for (const email of opts.emails) {
    for (const slot of busyData[email] || []) {
      allBusy.push({
        start: new Date(slot.start).getTime(),
        end: new Date(slot.end).getTime(),
      });
    }
  }

  // Sort and merge overlapping busy slots
  allBusy.sort((a, b) => a.start - b.start);
  const merged: { start: number; end: number }[] = [];
  for (const slot of allBusy) {
    if (merged.length > 0 && slot.start <= merged[merged.length - 1].end) {
      merged[merged.length - 1].end = Math.max(
        merged[merged.length - 1].end,
        slot.end
      );
    } else {
      merged.push({ ...slot });
    }
  }

  // Find gaps that fit the requested duration
  const durationMs = opts.durationMinutes * 60 * 1000;
  const rangeStart = new Date(opts.timeMin).getTime();
  const rangeEnd = new Date(opts.timeMax).getTime();
  const slots: AvailableSlot[] = [];

  let cursor = rangeStart;
  for (const busy of merged) {
    if (busy.start - cursor >= durationMs) {
      slots.push({
        start: new Date(cursor).toISOString(),
        end: new Date(busy.start).toISOString(),
      });
    }
    cursor = Math.max(cursor, busy.end);
  }
  if (rangeEnd - cursor >= durationMs) {
    slots.push({
      start: new Date(cursor).toISOString(),
      end: new Date(rangeEnd).toISOString(),
    });
  }

  return slots;
}
