import { getUser } from "../actions";
import { notFound } from "next/navigation";
import { UserDetail } from "./user-detail";

export const dynamic = "force-dynamic";

export default async function UserDetailPage({ params }: { params: Promise<{ slackUserId: string }> }) {
  const { slackUserId } = await params;
  const data = await getUser(slackUserId);
  if (!data) return notFound();

  return (
    <div className="space-y-4">
      <UserDetail data={data} />
    </div>
  );
}
