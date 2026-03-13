import { getSession } from "@/lib/auth";

const API_URL = process.env.AURA_API_URL || "http://localhost:3001";
const API_SECRET = process.env.DASHBOARD_API_SECRET;

export async function POST(request: Request) {
  const session = await getSession();
  if (!session) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  if (!API_SECRET) {
    return new Response(
      JSON.stringify({ error: "DASHBOARD_API_SECRET not configured" }),
      { status: 503, headers: { "Content-Type": "application/json" } },
    );
  }

  const body = await request.text();

  const response = await fetch(`${API_URL}/api/dashboard/chat`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${API_SECRET}`,
    },
    body,
  });

  if (!response.ok) {
    const text = await response.text();
    return new Response(text, {
      status: response.status,
      headers: { "Content-Type": response.headers.get("Content-Type") || "application/json" },
    });
  }

  return new Response(response.body, {
    status: response.status,
    headers: {
      "Content-Type": response.headers.get("Content-Type") || "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
