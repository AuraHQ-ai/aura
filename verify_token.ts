import { getOAuth2Client } from "./src/lib/gmail.js";

async function main() {
  const client = await getOAuth2Client();
  if (!client) { console.log("ERROR: no client"); return; }
  
  const { gmail } = await import("@googleapis/gmail");
  const g = gmail({ version: "v1", auth: client });
  const profile = await g.users.getProfile({ userId: "me" });
  console.log("Email:", profile.data.emailAddress);
  console.log("Messages total:", profile.data.messagesTotal);
}
main().catch(e => console.error("FAILED:", e.message));
