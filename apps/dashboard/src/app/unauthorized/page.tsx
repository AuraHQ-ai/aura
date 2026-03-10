import Link from "next/link";

export default function UnauthorizedPage() {
  return (
    <div className="flex min-h-screen items-center justify-center">
      <div className="text-center space-y-4">
        <h1 className="text-lg font-semibold">Access Denied</h1>
        <p className="text-muted-foreground">
          You are not authorized to access this dashboard. Only Aura admins have access.
        </p>
        <Link
          href="/api/auth/login"
          className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
        >
          Try again
        </Link>
      </div>
    </div>
  );
}
