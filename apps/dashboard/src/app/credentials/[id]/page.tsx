import { getCredential } from "../actions";
import { getUsers } from "../../users/actions";
import { notFound } from "next/navigation";
import { CredentialDetail } from "./credential-detail";

export const dynamic = "force-dynamic";

export default async function CredentialDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [data, usersResult] = await Promise.all([
    getCredential(id),
    getUsers(undefined, 1, 100),
  ]);
  if (!data) return notFound();

  const users = usersResult.items.map((u: { slackUserId: string; displayName: string | null }) => ({
    slackUserId: u.slackUserId,
    displayName: u.displayName,
  }));

  return (
    <div className="space-y-4">
      <CredentialDetail data={data} users={users} />
    </div>
  );
}
