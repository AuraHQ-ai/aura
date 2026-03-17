import { getSession } from "@/lib/auth";

const API_URL = process.env.AURA_API_URL || "http://localhost:3001";
const API_SECRET = process.env.DASHBOARD_API_SECRET;

export async function GET() {
  const session = await getSession();
  if (!session) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!API_SECRET) {
    return Response.json({ error: "DASHBOARD_API_SECRET not configured" }, { status: 503 });
  }

  const res = await fetch(`${API_URL}/api/dashboard/models`, {
    headers: { Authorization: `Bearer ${API_SECRET}` },
    next: { revalidate: 3600 },
  });

  if (!res.ok) {
    return Response.json({ error: "Failed to fetch models" }, { status: res.status });
  }

  return Response.json(await res.json());
}
