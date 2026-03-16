import { getSession } from "@/lib/auth";

const API_URL = process.env.AURA_API_URL || "http://localhost:3001";
const API_SECRET = process.env.DASHBOARD_API_SECRET;

export async function GET() {
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

  const response = await fetch(`${API_URL}/api/dashboard/chat/threads`, {
    headers: { Authorization: `Bearer ${API_SECRET}` },
  });

  const text = await response.text();
  return new Response(text, {
    status: response.status,
    headers: {
      "Content-Type": response.headers.get("Content-Type") || "application/json",
    },
  });
}
