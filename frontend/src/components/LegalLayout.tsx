import { Link } from 'react-router-dom';
import { APP_VERSION, LAST_UPDATED, PUBLISHED_AT, SERVICE_NAME } from '../lib/legal';

export default function LegalLayout({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen">
      <header className="border-b border-slate-800 bg-slate-900">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-4 py-3">
          <Link to="/" className="text-lg font-semibold">
            {SERVICE_NAME}
          </Link>
          <nav className="flex gap-3 text-sm text-slate-400">
            <Link to="/terms" className="hover:text-slate-200">
              Terms
            </Link>
            <Link to="/privacy" className="hover:text-slate-200">
              Privacy
            </Link>
          </nav>
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-4 py-8">
        <h1 className="text-3xl font-bold">{title}</h1>
        <p className="mt-1 text-sm text-slate-500">Last updated {LAST_UPDATED}</p>
        <div className="legal mt-6 space-y-5 text-slate-300">{children}</div>

        {/* Which build of the app these terms describe -- distinct from
            LAST_UPDATED above, which is when the legal text itself last
            changed. The two move independently: a release can ship without
            touching the policies, and the policies can be revised without a
            release. */}
        <footer className="mt-10 border-t border-slate-800 pt-4 text-xs text-slate-500">
          {SERVICE_NAME} v{APP_VERSION} — published {PUBLISHED_AT}
        </footer>
      </main>
    </div>
  );
}

export function Section({ heading, children }: { heading: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <h2 className="text-xl font-semibold text-slate-100">{heading}</h2>
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
