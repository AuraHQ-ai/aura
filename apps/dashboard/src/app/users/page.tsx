import { getUsers } from "./actions";
import { UsersTable } from "./users-table";

export const dynamic = "force-dynamic";

export default async function UsersPage({
  searchParams,
}: {
  searchParams: Promise<{ search?: string }>;
}) {
  const params = await searchParams;
  const users = await getUsers(params.search);

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold tracking-tight">Users</h1>
      <UsersTable users={users} />
    </div>
  );
}
