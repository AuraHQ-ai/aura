import { cn } from "@/lib/utils";

export function PageSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div className="space-y-4 animate-pulse">
      <div className="h-5 w-48 rounded bg-muted" />
      <div className="grid gap-3 grid-cols-2 sm:grid-cols-3 lg:grid-cols-5">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="h-20 rounded-xl border bg-card" />
        ))}
      </div>
      <div className="rounded-xl border bg-card">
        <div className="space-y-3 p-4">
          {Array.from({ length: rows }).map((_, i) => (
            <div key={i} className={cn("h-4 rounded bg-muted", i % 2 === 0 ? "w-full" : "w-3/4")} />
          ))}
        </div>
      </div>
    </div>
  );
}

export function TableSkeleton({ columns = 4, rows = 8 }: { columns?: number; rows?: number }) {
  return (
    <div className="space-y-4 animate-pulse">
      <div className="h-5 w-48 rounded bg-muted" />
      <div className="rounded-xl border bg-card overflow-hidden">
        <div className="grid gap-0" style={{ gridTemplateColumns: `repeat(${columns}, 1fr)` }}>
          {Array.from({ length: columns }).map((_, i) => (
            <div key={`h-${i}`} className="h-8 bg-muted px-3" />
          ))}
          {Array.from({ length: rows * columns }).map((_, i) => (
            <div key={`c-${i}`} className="h-10 border-t px-3 flex items-center">
              <div className="h-3 w-3/4 rounded bg-muted" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export function DetailSkeleton() {
  return (
    <div className="space-y-4 animate-pulse">
      <div className="h-5 w-64 rounded bg-muted" />
      <div className="rounded-xl border bg-card p-6 space-y-4">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="space-y-1">
            <div className="h-3 w-24 rounded bg-muted" />
            <div className="h-4 w-full rounded bg-muted/60" />
          </div>
        ))}
      </div>
    </div>
  );
}
