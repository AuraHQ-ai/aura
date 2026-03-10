import { getJob } from "../actions";
import { notFound } from "next/navigation";
import { JobDetail } from "./job-detail";

export const dynamic = "force-dynamic";

export default async function JobDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const data = await getJob(id);
  if (!data) return notFound();

  return (
    <div className="space-y-4">
      <JobDetail data={data} />
    </div>
  );
}
