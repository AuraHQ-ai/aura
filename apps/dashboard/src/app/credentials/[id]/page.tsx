import { getCredential } from "../actions";
import { getUsers } from "../../users/actions";
import { notFound } from "next/navigation";
import { CredentialDetail } from "./credential-detail";

export const dynamic = "force-dynamic";

async function getAllUsers() {
  const PAGE_SIZE = 100;
  const first = await getUsers(undefined, 1, PAGE_SIZE);
  const all = [...first.items];
  const totalPages = Math.ceil(first.total / PAGE_SIZE);
  for (let page = 2; page <= totalPages; page++) {
    const next = await getUsers(undefined, page, PAGE_SIZE);
    all.push(...next.items);
  }
  return all;
}

export default async function CredentialDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [data, allUsers] = await Promise.all([
    getCredential(id),
    getAllUsers(),
  ]);
  if (!data) return notFound();

  const users = allUsers.map((u: { slackUserId: string; displayName: string | null }) => ({
    slackUserId: u.slackUserId,
    displayName: u.displayName,
  }));

  return (
    <div className="space-y-4">
      <CredentialDetail data={data} users={users} />
    </div>
  );
}
