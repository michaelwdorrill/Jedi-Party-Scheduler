import LegalLayout, { Bullets, Section } from '../components/LegalLayout';
import { CHANGELOG, type ChangelogEntry } from '../lib/changelog';
import { APP_VERSION } from '../lib/legal';

// Reuses LegalLayout for the same reason the Terms and Privacy pages do: it's
// the public, no-login chrome, and this page has to be reachable by anyone who
// can see the footer -- including someone not logged in.

function Entry({ entry }: { entry: ChangelogEntry }) {
  const isCurrent = entry.version === APP_VERSION;
  return (
    <Section heading={`v${entry.version} — ${entry.date}`}>
      <p className="text-muted">
        {entry.summary}
        {isCurrent && <span className="ml-2 text-xs text-emerald-400">current</span>}
      </p>
      {entry.added && (
        <>
          <h3 className="mt-3 text-sm font-semibold text-ink-soft">Added</h3>
          <Bullets items={entry.added} />
        </>
      )}
      {entry.changed && (
        <>
          <h3 className="mt-3 text-sm font-semibold text-ink-soft">Changed</h3>
          <Bullets items={entry.changed} />
        </>
      )}
      {entry.fixed && (
        <>
          <h3 className="mt-3 text-sm font-semibold text-ink-soft">Fixed</h3>
          <Bullets items={entry.fixed} />
        </>
      )}
    </Section>
  );
}

export default function ChangelogPage() {
  return (
    <LegalLayout title="Changelog" showLastUpdated={false}>
      <p>
        What's changed in each release, newest first. Uncle Owen is in beta — the version number
        stays below 1.0 until the planned work is done.
      </p>
      {CHANGELOG.map((entry) => (
        <Entry key={entry.version} entry={entry} />
      ))}
    </LegalLayout>
  );
}
