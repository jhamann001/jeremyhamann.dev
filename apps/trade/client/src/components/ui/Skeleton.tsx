export function Skeleton({ className = '' }: { className?: string }) {
  return <div className={`animate-pulse bg-[var(--bg-surface)] rounded-lg ${className}`} aria-hidden="true" />;
}

export function QueueSkeleton() {
  return (
    <div className="space-y-4" role="status" aria-busy="true" aria-label="Loading trade requests">
      <div className="flex justify-between items-center">
        <Skeleton className="h-7 w-48" />
        <Skeleton className="h-9 w-36 rounded-lg" />
      </div>
      <div className="bg-[var(--bg-card)] rounded-[14px] border border-[var(--border)] overflow-hidden">
        <div className="p-4 space-y-3">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="flex items-center gap-4 p-3">
              <Skeleton className="h-4 w-20" />
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-6 w-20 rounded-full" />
              <div className="flex-1" />
              <Skeleton className="h-4 w-16" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export function HomeSkeleton() {
  return (
    <div className="max-w-4xl mx-auto" role="status" aria-busy="true" aria-label="Loading dashboard">
      <Skeleton className="h-8 w-64 mb-2" />
      <Skeleton className="h-5 w-80 mb-8" />
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="bg-[var(--bg-card)] rounded-[14px] border border-[var(--border)] p-5">
            <Skeleton className="h-4 w-24 mb-3" />
            <Skeleton className="h-8 w-12" />
          </div>
        ))}
      </div>
    </div>
  );
}

export function FormSkeleton() {
  return (
    <div className="max-w-4xl mx-auto" role="status" aria-busy="true" aria-label="Loading form">
      <div className="bg-[var(--bg-card)] rounded-[14px] border border-[var(--border)] p-7 space-y-6">
        <Skeleton className="h-7 w-48" />
        <div className="grid grid-cols-3 gap-6">
          <Skeleton className="h-10 rounded-lg" />
          <Skeleton className="h-10 rounded-lg" />
          <Skeleton className="h-10 rounded-lg" />
        </div>
        <Skeleton className="h-40 rounded-lg" />
        <Skeleton className="h-10 w-48 ml-auto rounded-lg" />
      </div>
    </div>
  );
}
