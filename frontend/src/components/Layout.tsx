import { useState } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { APP_VERSION, PUBLISHED_AT } from '../lib/legal';
import { buttonClass } from './ui';

const navLinkClass = ({ isActive }: { isActive: boolean }) =>
  `rounded-md px-3 py-2 font-display text-sm uppercase tracking-wide ${
    isActive ? 'bg-accent text-on-accent' : 'text-ink-dim hover:bg-raised hover:text-ink'
  }`;

type LogoutBanner = 'none' | 'queued' | 'unresolved';

export default function Layout() {
  const { user, logout } = useAuth();
  const [logoutBanner, setLogoutBanner] = useState<LogoutBanner>('none');

  // Saying "logged out" when the server-side session is still alive would be
  // a lie the user can't act on. Distinguishes two cases: queued (it'll be
  // retried automatically) from unresolved (storage itself failed, so there
  // is no record of this anywhere and the user needs to know that plainly).
  const handleLogout = async () => {
    const { confirmed, queued } = await logout();
    setLogoutBanner(confirmed ? 'none' : queued ? 'queued' : 'unresolved');
  };

  return (
    <div className="min-h-screen">
      {logoutBanner === 'queued' && (
        <div className="bg-amber-900/60 px-4 py-2 text-center text-sm text-amber-100">
          You're signed out on this device, but we couldn't reach the server to end the session. It'll
          be ended automatically next time you're online.
        </div>
      )}
      {logoutBanner === 'unresolved' && (
        <div className="bg-red-900/60 px-4 py-2 text-center text-sm text-red-100">
          You're signed out on this device, but we couldn't confirm the server-side session ended, and
          couldn't even record it for automatic retry. If this device is shared or was compromised,
          contact support.
        </div>
      )}
      <header className="border-b border-edge bg-surface">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-4 py-3">
          <div className="flex items-center gap-4">
            <span className="flex items-center gap-2">
              {/* The twin-sun mark. Two circles, one larger and warmer than
                  the other -- the whole identity in 20 pixels. */}
              <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true" className="shrink-0">
                <circle cx="8" cy="10" r="6" fill="#E8913A" />
                <circle cx="14.5" cy="13" r="3.2" fill="#F2C879" />
              </svg>
              <span className="font-display text-xl font-bold uppercase tracking-widest">
                Uncle Owen
              </span>
            </span>
            <nav className="flex gap-1">
              <NavLink to="/" end className={navLinkClass}>
                Dashboard
              </NavLink>
              <NavLink to="/calendar" className={navLinkClass}>
                Calendar
              </NavLink>
              <NavLink to="/groups" className={navLinkClass}>
                Groups
              </NavLink>
              <NavLink to="/settings" className={navLinkClass}>
                Settings
              </NavLink>
            </nav>
          </div>
          <div className="flex items-center gap-3">
            {user && (
              <div className="flex items-center gap-2 text-sm text-ink-dim">
                <span>{user.globalName ?? user.username}</span>
                <button
                  onClick={() => void handleLogout()}
                  className={buttonClass('secondary', 'sm')}
                >
                  Log out
                </button>
              </div>
            )}
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-4 py-6">
        <Outlet />
      </main>

      {/* Vaporators on the horizon, with condensate. Homestead only -- the
          Settings toggle hides the whole strip. The drops carry their own
          colour, so opacity is per-group rather than on the svg. */}
      <div className="horizon-foot mx-auto max-w-5xl px-4 pt-10" aria-hidden="true">
        <svg viewBox="0 0 900 40" preserveAspectRatio="none" className="block h-9 w-full">
          <g fill="currentColor" opacity="0.13">
            <rect x="118" y="10" width="2.5" height="30" />
            <ellipse cx="119" cy="9" rx="5.5" ry="6.5" />
            <rect x="150" y="17" width="2" height="23" />
            <ellipse cx="151" cy="16" rx="4" ry="5" />
            <rect x="742" y="13" width="2.2" height="27" />
            <ellipse cx="743" cy="12" rx="4.5" ry="5.5" />
            <path d="M0 40 C 140 31, 300 37, 470 33 C 640 29, 780 38, 900 34 L900 40 Z" />
          </g>
          <circle className="uo-drop-a" cx="119" cy="16" r="2.4" fill="#6FA8A8" opacity="0" />
          <circle className="uo-drop-b" cx="743" cy="19" r="2.1" fill="#6FA8A8" opacity="0" />
        </svg>
      </div>

      <footer className="mx-auto max-w-5xl px-4 pb-8 pt-2 text-xs text-fainter">
        <NavLink to="/terms" className="hover:text-muted">
          Terms
        </NavLink>
        <span className="px-2">·</span>
        <NavLink to="/privacy" className="hover:text-muted">
          Privacy
        </NavLink>
        <span className="px-2">·</span>
        <NavLink to="/changelog" className="hover:text-muted">
          Changelog
        </NavLink>
        <span className="px-2">·</span>
        <span>
          v{APP_VERSION} — published {PUBLISHED_AT}
        </span>
      </footer>
    </div>
  );
}
