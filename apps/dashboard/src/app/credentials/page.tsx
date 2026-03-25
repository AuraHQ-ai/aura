import { getCredentials } from "./actions";
import { getUsers } from "../users/actions";
import { getSession } from "@/lib/auth";
import { CredentialsTable } from "./credentials-table";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 100;

export default async function CredentialsPage({
  searchParams,
}: {
  searchParams: Promise<{ search?: string; page?: string }>;
}) {
  const params = await searchParams;
  const page = Math.max(1, parseInt(params.page || "1", 10) || 1);
  const [{ items, total }, usersResult, session] = await Promise.all([
    getCredentials(params.search, page, PAGE_SIZE),
    getUsers(undefined, 1, 500),
    getSession(),
  ]);

  const users = usersResult.items.map((u: { slackUserId: string; displayName: string | null }) => ({
    slackUserId: u.slackUserId,
    displayName: u.displayName,
  }));

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold tracking-tight">Credentials</h1>
      <CredentialsTable
        credentials={items}
        total={total}
        page={page}
        pageSize={PAGE_SIZE}
        users={users}
        currentUserId={session?.slackUserId ?? ""}
      />
    </div>
  );
}
