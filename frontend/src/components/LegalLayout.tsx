import { Link } from 'react-router-dom';
import { APP_VERSION, LAST_UPDATED, PUBLISHED_AT, SERVICE_NAME } from '../lib/legal';

export default function LegalLayout({
  title,
  children,
  // LAST_UPDATED is when the *legal text* changed, which is meaningful on the
  // Terms and Privacy pages and actively misleading anywhere else -- the
  // changelog is not "last updated" whenever the policies were revised. Pages
  // that aren't legal documents pass false and supply their own framing.
  showLastUpdated = true,
}: {
  title: string;
  children: React.ReactNode;
  showLastUpdated?: boolean;
}) {
  return (
    <div className="min-h-screen">
      <header className="border-b border-edge bg-surface">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-4 py-3">
          <Link to="/" className="text-lg font-semibold">
            {SERVICE_NAME}
          </Link>
          <nav className="flex gap-3 text-sm text-muted">
            <Link to="/terms" className="hover:text-ink-soft">
              Terms
            </Link>
            <Link to="/privacy" className="hover:text-ink-soft">
              Privacy
            </Link>
            <Link to="/changelog" className="hover:text-ink-soft">
              Changelog
            </Link>
          </nav>
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-4 py-8">
        <h1 className="text-3xl font-bold">{title}</h1>
        {showLastUpdated && (
          <p className="mt-1 text-sm text-faint">Last updated {LAST_UPDATED}</p>
        )}
        <div className="legal mt-6 space-y-5 text-ink-dim">{children}</div>

        {/* Which build of the app these terms describe -- distinct from
            LAST_UPDATED above, which is when the legal text itself last
            changed. The two move independently: a release can ship without
            touching the policies, and the policies can be revised without a
            release. */}
        <footer className="mt-10 border-t border-edge pt-4 text-xs text-faint">
          {SERVICE_NAME} v{APP_VERSION} — published {PUBLISHED_AT}
        </footer>
      </main>
    </div>
  );
}

export function Section({ heading, children }: { heading: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <h2 className="text-xl font-semibold text-ink">{heading}</h2>
      {children}
    </section>
  );
}

export function Bullets({ items }: { items: React.ReactNode[] }) {
  return (
    <ul className="list-disc space-y-1 pl-5">
      {items.map((item, i) => (
        <li key={i}>{item}</li>
      ))}
    </ul>
  );
}
