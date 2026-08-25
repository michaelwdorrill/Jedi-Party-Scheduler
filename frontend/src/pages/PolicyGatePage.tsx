import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, API_BASE_URL } from '../api/client';
import { clearToken, getToken } from '../auth/tokenStorage';
import { useAuth } from '../auth/AuthContext';
import { describeError } from '../lib/async';
import { InlineError, buttonClass, cardClass } from '../components/ui';

// Shown after logging in when the Terms or Privacy Policy have changed since
// this person last agreed (docs/specs/0012-policy-reacceptance.md).
//
// Every other route is refused by the Worker until they accept, so this is
// not a dialog to dismiss -- but it is deliberately not a dead end either.
// `DELETE /me` and `GET /me/export` both live behind requireAuth, so someone
// who will not agree can only leave properly or take their data with them
// *while still logged in*. That is why they are on this screen: "agree or you
// cannot use the app" has to keep the exit door reachable.
//
// The deletion button is here for that reason, and is not the light-touch
// version of itself: deleting an account also deletes every event that person
// organised, so it takes other people's sessions off their calendars too. It
// carries the same two-step confirmation Settings uses, and it does not sit
// next to "I agree" as though the two were comparable choices.
export default function PolicyGatePage() {
  const { user, refreshUser, logout } = useAuth();
  const [accepting, setAccepting] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showLeaving, setShowLeaving] = useState(false);

  const accept = async () => {
    setAccepting(true);
    setError(null);
    try {
      await api.post('/me/accept-policy', {});
      // Re-reads /me, which carries both version numbers -- so the guard
      // stops rendering this screen because the server says so, not because
      // this component decided it was done.
      await refreshUser();
    } catch (e) {
      setError(describeError(e));
    } finally {
      setAccepting(false);
    }
  };

  // Same shape as Settings': fetched with the session token and turned into a
  // local download, so the export never travels through anything but this
  // browser.
  const handleExport = async () => {
    setExporting(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE_URL}/me/export`, {
        headers: { Authorization: `Bearer ${getToken()}` },
      });
      const blob = new Blob([JSON.stringify(await res.json(), null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `uncle-owen-data-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(describeError(e));
    } finally {
      setExporting(false);
    }
  };

  const handleDelete = async () => {
    if (
      !confirm(
        'Permanently delete your account?\n\nThis removes your profile, personal time blocks, RSVPs, votes, group memberships, and every event you organised — including from the calendars of everyone you invited. It cannot be undone.',
      )
    ) {
      return;
    }
    if (prompt('Type DELETE to confirm.') !== 'DELETE') return;

    setDeleting(true);
    try {
      await api.delete('/me');
      clearToken();
      await logout();
      window.location.hash = '#/login';
    } catch (e) {
      setError(describeError(e));
      setDeleting(false);
    }
  };

  return (
    <div className="mx-auto flex min-h-screen max-w-2xl flex-col justify-center px-4 py-10">
      <div className={cardClass()}>
        <h1 className="text-xl font-semibold">The Terms and Privacy Policy have changed</h1>
        <p className="mt-3 text-sm text-muted">
          {user?.globalName ?? user?.username}, we&rsquo;ve updated the documents that describe what
          Uncle Owen does with your data. Please read them and agree before carrying on.
        </p>

        <div className="mt-4 flex gap-4 text-sm">
          {/* Both are public routes, so they open without a session and are
              still readable if someone decides not to agree. */}
          <Link to="/terms" className="underline">
            Terms of Service
          </Link>
          <Link to="/privacy" className="underline">
            Privacy Policy
          </Link>
        </div>

        {error && <InlineError message={error} />}

        <button
          type="button"
          onClick={() => void accept()}
          disabled={accepting}
          className={`${buttonClass('primary')} mt-6 w-full`}
        >
          {accepting ? 'Saving…' : 'I agree — continue'}
        </button>

        <button
          type="button"
          onClick={() => setShowLeaving((v) => !v)}
          className={`${buttonClass('ghost', 'sm')} mt-3 w-full`}
        >
          I don&rsquo;t agree
        </button>

        {showLeaving && (
          <div className="mt-4 border-t border-edge pt-4 text-sm">
            <p className="text-muted">
              That&rsquo;s fine — you can&rsquo;t use Uncle Owen without agreeing, but nothing is
              taken from you. You can log out and come back to this screen at any time, take a copy
              of everything we hold, or close the account for good.
            </p>
            <div className="mt-4 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => void logout()}
                className={buttonClass('secondary', 'sm')}
              >
                Log out
              </button>
              <button
                type="button"
                onClick={() => void handleExport()}
                disabled={exporting}
                className={buttonClass('secondary', 'sm')}
              >
                {exporting ? 'Preparing…' : 'Download my data'}
              </button>
              <button
                type="button"
                onClick={() => void handleDelete()}
                disabled={deleting}
                // Matched to Settings' delete button rather than given a
                // variant of its own -- one destructive style, in two places.
                className="rounded-md border border-danger/70 bg-danger-surface/55 px-3 py-1.5 text-sm text-danger-text hover:bg-danger-surface/80 disabled:opacity-50"
              >
                {deleting ? 'Deleting…' : 'Delete my account'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
