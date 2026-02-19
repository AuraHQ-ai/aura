import { logger } from "./logger.js";
import { getRefreshToken } from "./gmail.js";

// ── Types ───────────────────────────────────────────────────────────────────

export interface DirectoryUser {
  email: string;
  name: string;
  title?: string;
  department?: string;
  phone?: string;
  photoUrl?: string;
}

// ── Auth ────────────────────────────────────────────────────────────────────

async function getCredentials() {
  const clientId = process.env.GOOGLE_EMAIL_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_EMAIL_CLIENT_SECRET;
  const refreshToken = await getRefreshToken();

  if (!clientId || !clientSecret || !refreshToken) {
    return null;
  }
  return { clientId, clientSecret, refreshToken };
}

let cachedAccessToken: { token: string; expiresAt: number } | null = null;

async function getAccessToken(): Promise<string | null> {
  if (cachedAccessToken && Date.now() < cachedAccessToken.expiresAt - 60_000) {
    return cachedAccessToken.token;
  }

  const creds = await getCredentials();
  if (!creds) return null;

  const resp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
      refresh_token: creds.refreshToken,
      grant_type: "refresh_token",
    }),
  });

  if (!resp.ok) {
    logger.error("Failed to refresh access token for directory", {
      status: resp.status,
      body: await resp.text(),
    });
    return null;
  }

  const data = (await resp.json()) as {
    access_token: string;
    expires_in: number;
  };
  cachedAccessToken = {
    token: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  };
  return data.access_token;
}

// ── People API (Directory) ─────────────────────────────────────────────────

interface PeopleApiPerson {
  resourceName?: string;
  names?: Array<{ displayName?: string; givenName?: string; familyName?: string }>;
  emailAddresses?: Array<{ value?: string; type?: string }>;
  organizations?: Array<{ title?: string; department?: string; name?: string }>;
  phoneNumbers?: Array<{ value?: string; type?: string }>;
  photos?: Array<{ url?: string }>;
}

function parsePerson(person: PeopleApiPerson): DirectoryUser | null {
  const email = person.emailAddresses?.[0]?.value;
  const name = person.names?.[0]?.displayName;
  if (!email && !name) return null;

  const org = person.organizations?.[0];
  return {
    email: email || "unknown",
    name: name || email || "unknown",
    title: org?.title || undefined,
    department: org?.department || undefined,
    phone: person.phoneNumbers?.[0]?.value || undefined,
    photoUrl: person.photos?.[0]?.url || undefined,
  };
}

/**
 * Search for users in the Google Workspace directory using the People API.
 * Uses the `directory.readonly` scope — no admin privileges needed.
 */
export async function searchDirectoryUser(
  query: string
): Promise<DirectoryUser[] | null> {
  const token = await getAccessToken();
  if (!token) return null;

  // People API directory search
  const params = new URLSearchParams({
    query,
    readMask: "names,emailAddresses,organizations,phoneNumbers,photos",
    sources: "DIRECTORY_SOURCE_TYPE_DOMAIN_PROFILE",
    pageSize: "20",
  });

  const resp = await fetch(
    `https://people.googleapis.com/v1/people:searchDirectoryPeople?${params}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );

  if (!resp.ok) {
    const body = await resp.text();
    logger.error("People API directory search failed", {
      status: resp.status,
      body,
      query,
    });
    return null;
  }

  const data = (await resp.json()) as {
    people?: PeopleApiPerson[];
    totalSize?: number;
  };

  return (data.people || []).map(parsePerson).filter((u): u is DirectoryUser => u !== null);
}

/**
 * List all users in the Google Workspace directory.
 * Paginates through the full directory.
 */
export async function listDirectoryUsers(opts?: {
  maxResults?: number;
}): Promise<DirectoryUser[] | null> {
  const token = await getAccessToken();
  if (!token) return null;

  const max = opts?.maxResults || 100;
  const allUsers: DirectoryUser[] = [];
  let pageToken: string | undefined;

  while (allUsers.length < max) {
    const params = new URLSearchParams({
      readMask: "names,emailAddresses,organizations,phoneNumbers,photos",
      sources: "DIRECTORY_SOURCE_TYPE_DOMAIN_PROFILE",
      pageSize: String(Math.min(max - allUsers.length, 100)),
    });
    if (pageToken) params.set("pageToken", pageToken);

    const resp = await fetch(
      `https://people.googleapis.com/v1/people:listDirectoryPeople?${params}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );

    if (!resp.ok) {
      const body = await resp.text();
      logger.error("People API directory list failed", {
        status: resp.status,
        body,
      });
      // Return what we have so far, or null if nothing
      return allUsers.length > 0 ? allUsers : null;
    }

    const data = (await resp.json()) as {
      people?: PeopleApiPerson[];
      nextPageToken?: string;
    };

    const parsed = (data.people || [])
      .map(parsePerson)
      .filter((u): u is DirectoryUser => u !== null);
    allUsers.push(...parsed);

    if (!data.nextPageToken || parsed.length === 0) break;
    pageToken = data.nextPageToken;
  }

  logger.info("Listed directory users", { count: allUsers.length });
  return allUsers;
}
