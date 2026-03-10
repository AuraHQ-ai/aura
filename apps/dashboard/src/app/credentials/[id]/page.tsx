import { getCredential } from "../actions";
import { notFound } from "next/navigation";
import { CredentialDetail } from "./credential-detail";

export const dynamic = "force-dynamic";

export default async function CredentialDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const data = await getCredential(id);
  if (!data) return notFound();

  return (
    <div className="space-y-4">
      <CredentialDetail data={data} />
    </div>
  );
}
