import { cn } from './styles';

// The twin suns, orbiting while you wait.
//
// This is the one piece of motion in the app that costs nothing in patience: a
// loading state has to signal waiting regardless of what it looks like, so the
// alternative was a spinner or the word "Loading". It also folds seven ad-hoc
// `Loading…` strings -- AuthGuard, CalendarPage, GroupsPage, EventDetailPage,
// PersonalEventPage, AdminUsersPage and DashboardPage -- into one component.
//
// Under reduced motion the suns simply sit still. The caption carries the
// meaning either way, which is why it is text and not just a shape.

export default function Loading({
  label = 'Checking the horizon',
  className,
}: {
  label?: string;
  className?: string;
}) {
  return (
    <div
      className={cn('flex flex-col items-center justify-center gap-4 py-10', className)}
      role="status"
      aria-live="polite"
    >
      <span className="relative block h-16 w-16" aria-hidden="true">
        <span className="absolute left-1/2 top-1/2 z-[2] -ml-[13px] -mt-[13px] block h-[26px] w-[26px] rounded-full bg-accent" />
        <span className="uo-orbiter absolute left-1/2 top-1/2 z-[1] -ml-[6px] -mt-[6px] block h-3 w-3 translate-x-[22px] rounded-full bg-accent-2" />
      </span>
      <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-faint">{label}</span>
    </div>
  );
}
