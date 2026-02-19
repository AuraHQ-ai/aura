import { logger } from "./logger.js";

// ── Types ───────────────────────────────────────────────────────────────────

export interface DirectoryUser {
  email: string;
  name: string;
  title?: string;
  department?: string;
  phone?: string;
  orgUnitPath?: string;
  isAdmin: boolean;
  suspended: boolean;
  lastLoginTime?: string;
  thumbnailPhotoUrl?: string;
}

// ── Auth ────────────────────────────────────────────────────────────────────

function getCredentials() {
  const clientId = process.env.GOOGLE_EMAIL_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_EMAIL_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_EMAIL_REFRESH_TOKEN;

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

  const creds = getCredentials();
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

// ── Directory API ───────────────────────────────────────────────────────────

function parseUser(user: Record<string, unknown>): DirectoryUser {
  const primaryEmail = (user.primaryEmail as string) || "";
  const name = user.name as Record<string, string> | undefined;
  const fullName = name?.fullName || `${name?.givenName || ""} ${name?.familyName || ""}`.trim();

  return {
    email: primaryEmail,
    name: fullName,
    title: (user.organizations as Array<Record<string, string>>)?.[0]?.title,
    department: (user.organizations as Array<Record<string, string>>)?.[0]?.department,
    phone: (user.phones as Array<Record<string, string>>)?.[0]?.value,
    orgUnitPath: user.orgUnitPath as string | undefined,
    isAdmin: (user.isAdmin as boolean) || false,
    suspended: (user.suspended as boolean) || false,
    lastLoginTime: user.lastLoginTime as string | undefined,
    thumbnailPhotoUrl: user.thumbnailPhotoUrl as string | undefined,
  };
}

/**
 * List all users in the Google Workspace directory.
 */
export async function listDirectoryUsers(
  options: { maxResults?: number; query?: string; orderBy?: string } = {}
): Promise<DirectoryUser[] | null> {
  const token = await getAccessToken();
  if (!token) return null;

  const params = new URLSearchParams({
    customer: "my_customer",
    maxResults: String(options.maxResults || 100),
    projection: "full",
    orderBy: options.orderBy || "email",
  });

  if (options.query) {
    params.set("query", options.query);
  }

  const allUsers: DirectoryUser[] = [];
  let pageToken: string | undefined;

  do {
    if (pageToken) params.set("pageToken", pageToken);

    const resp = await fetch(
      `https://admin.googleapis.com/admin/directory/v1/users?${params}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );

    if (!resp.ok) {
      const body = await resp.text();
      logger.error("Directory API list users failed", {
        status: resp.status,
        body,
      });
      return null;
    }

    const data = (await resp.json()) as {
      users?: Record<string, unknown>[];
      nextPageToken?: string;
    };

    if (data.users) {
      allUsers.push(...data.users.map(parseUser));
    }
    pageToken = data.nextPageToken;
  } while (pageToken && allUsers.length < (options.maxResults || 100));

  return allUsers;
}

/**
 * Search for a user by name or email in the directory.
 */
export async function searchDirectoryUser(
  query: string
): Promise<DirectoryUser[] | null> {
  const token = await getAccessToken();
  if (!token) return null;

  // Try exact email lookup first
  if (query.includes("@")) {
    const resp = await fetch(
      `https://admin.googleapis.com/admin/directory/v1/users/${encodeURIComponent(query)}?projection=full`,
      { headers: { Authorization: `Bearer ${token}` } }
    );

    if (resp.ok) {
      const user = (await resp.json()) as Record<string, unknown>;
      return [parseUser(user)];
    }
    // Fall through to search if exact lookup fails
  }

  // Search by name or email prefix
  // The Directory API supports queries like: name:'John' email:'john@'
  const params = new URLSearchParams({
    customer: "my_customer",
    maxResults: "10",
    projection: "full",
    query: `name:'${query}' email:'${query}'`,
  });

  const resp = await fetch(
    `https://admin.googleapis.com/admin/directory/v1/users?${params}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );

  if (!resp.ok) {
    // Try with just name query (OR doesn't work, need separate call)
    const nameParams = new URLSearchParams({
      customer: "my_customer",
      maxResults: "10",
      projection: "full",
      query: `name:'${query}'`,
    });

    const nameResp = await fetch(
      `https://admin.googleapis.com/admin/directory/v1/users?${nameParams}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );

    if (!nameResp.ok) {
      const body = await nameResp.text();
      logger.error("Directory API search failed", {
        status: nameResp.status,
        body,
        query,
      });
      return null;
    }

    const nameData = (await nameResp.json()) as {
      users?: Record<string, unknown>[];
    };
    return nameData.users?.map(parseUser) || [];
  }

  const data = (await resp.json()) as {
    users?: Record<string, unknown>[];
  };
  return data.users?.map(parseUser) || [];
}

/**
 * Get a specific user by email.
 */
export async function getDirectoryUser(
  email: string
): Promise<DirectoryUser | null> {
  const token = await getAccessToken();
  if (!token) return null;

  const resp = await fetch(
    `https://admin.googleapis.com/admin/directory/v1/users/${encodeURIComponent(email)}?projection=full`,
    { headers: { Authorization: `Bearer ${token}` } }
  );

  if (!resp.ok) {
    if (resp.status === 404) return null;
    const body = await resp.text();
    logger.error("Directory API get user failed", {
      status: resp.status,
      body,
      email,
    });
    return null;
  }

  const user = (await resp.json()) as Record<string, unknown>;
  return parseUser(user);
}
