import { NextRequest, NextResponse } from "next/server";
import { verifyTransferToken } from "@/lib/auth";

export async function POST(request: NextRequest) {
  try {
    const { token } = await request.json();
    if (!token) {
      return NextResponse.json({ error: "Missing token" }, { status: 400 });
    }

    const session = await verifyTransferToken(token);
    return NextResponse.json(session);
  } catch {
    return NextResponse.json({ error: "Invalid token" }, { status: 401 });
  }
}
