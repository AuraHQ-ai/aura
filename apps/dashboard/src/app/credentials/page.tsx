import { getCredentials } from "./actions";
import { CredentialsTable } from "./credentials-table";

export const dynamic = "force-dynamic";

export default async function CredentialsPage() {
  const creds = await getCredentials();

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold tracking-tight">Credentials</h1>
      <CredentialsTable credentials={creds} />
    </div>
  );
}
