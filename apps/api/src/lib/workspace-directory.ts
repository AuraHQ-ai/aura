import { logger } from "./logger.js";

// ── Types ───────────────────────────────────────────────────────────────────

export interface DirectoryUser {
  email: string;
  name: string;
  title?: string;
  department?: string;
  phone?: string;
}

// ── Auth ────────────────────────────────────────────────────────────────────

let cachedAccessToken: { token: string; expiresAt: number } | null = null;

async function getAccessToken(): Promise<string | null> {
  if (cachedAccessToken && Date.now() < cachedAccessToken.expiresAt - 60_000) {
    return cachedAccessToken.token;
  }

  const { getOAuth2Client } = await import("./gmail.js");
  const client = await getOAuth2Client();
  if (!client) return null;

  const tokenResponse = await client.getAccessToken();
  const token = tokenResponse.token;
  if (!token) return null;

  cachedAccessToken = {
    token,
    expiresAt: Date.now() + 3500 * 1000,
  };
  return token;
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
