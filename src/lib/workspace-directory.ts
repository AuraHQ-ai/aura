import { logger } from "./logger.js";
import { getRefreshToken } from "./gmail.js";

// ── Types ───────────────────────────────────────────────────────────────────

export interface DirectoryUser {
  email: string;
  name: string;
  title?: string;
  department?: string;
  phone?: string;
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

// ── People API ──────────────────────────────────────────────────────────────

interface PeopleConnection {
  names?: Array<{ displayName?: string }>;
  emailAddresses?: Array<{ value?: string }>;
  organizations?: Array<{ title?: string; department?: string }>;
  phoneNumbers?: Array<{ value?: string }>;
}

function parsePerson(person: PeopleConnection): DirectoryUser | null {
  const email = person.emailAddresses?.[0]?.value;
  const name = person.names?.[0]?.displayName;
  if (!email || !name) return null;

  return {
    email,
    name,
    title: person.organizations?.[0]?.title,
    department: person.organizations?.[0]?.department,
    phone: person.phoneNumbers?.[0]?.value,
  };
}

/**
 * Search the workspace directory by name or email.
 */
export async function searchDirectoryUser(
  query: string
): Promise<DirectoryUser[] | null> {
  const token = await getAccessToken();
  if (!token) return null;

  // People API directory search
  const params = new URLSearchParams({
    query,
    readMask: "names,emailAddresses,organizations,phoneNumbers",
    sources: "DIRECTORY_SOURCE_TYPE_DOMAIN_PROFILE",
    pageSize: "10",
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

  const data = (await resp.json()) as { people?: PeopleConnection[] };
  return (data.people || []).map(parsePerson).filter(Boolean) as DirectoryUser[];
}

/**
 * List workspace directory users.
 */
export async function listDirectoryUsers(
  maxResults = 100
): Promise<DirectoryUser[] | null> {
  const token = await getAccessToken();
  if (!token) return null;

  const params = new URLSearchParams({
    readMask: "names,emailAddresses,organizations,phoneNumbers",
    sources: "DIRECTORY_SOURCE_TYPE_DOMAIN_PROFILE",
    pageSize: String(Math.min(maxResults, 200)),
  });

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
    return null;
  }

  const data = (await resp.json()) as { people?: PeopleConnection[] };
  return (data.people || []).map(parsePerson).filter(Boolean) as DirectoryUser[];
}

/**
 * Get a specific user by email.
 */
export async function getDirectoryUser(
  email: string
): Promise<DirectoryUser | null> {
  // Search by email and find exact match
  const results = await searchDirectoryUser(email);
  if (!results) return null;
  return (
    results.find(
      (u) => u.email.toLowerCase() === email.toLowerCase()
    ) || results[0] || null
  );
}
