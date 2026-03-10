import { getJobs } from "./actions";
import { JobsTable } from "./jobs-table";

export const dynamic = "force-dynamic";

export default async function JobsPage() {
  const jobsList = await getJobs();

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold tracking-tight">Jobs</h1>
      <JobsTable jobs={jobsList} />
    </div>
  );
}
