import { useState } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { APP_VERSION, PUBLISHED_AT } from '../lib/legal';

const navLinkClass = ({ isActive }: { isActive: boolean }) =>
  `rounded-md px-3 py-2 text-sm font-medium ${
    isActive ? 'bg-indigo-600 text-white' : 'text-slate-300 hover:bg-slate-800 hover:text-white'
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
      <header className="border-b border-slate-800 bg-slate-900">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-4 py-3">
          <div className="flex items-center gap-4">
            <span className="text-lg font-semibold">Uncle Owen</span>
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
              <div className="flex items-center gap-2 text-sm text-slate-300">
                <span>{user.globalName ?? user.username}</span>
                <button
                  onClick={() => void handleLogout()}
                  className="rounded-md border border-slate-700 px-2 py-1 text-xs hover:bg-slate-800"
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

      <footer className="mx-auto max-w-5xl px-4 pb-8 pt-4 text-xs text-slate-600">
        <NavLink to="/terms" className="hover:text-slate-400">
          Terms
        </NavLink>
        <span className="px-2">·</span>
        <NavLink to="/privacy" className="hover:text-slate-400">
          Privacy
        </NavLink>
        <span className="px-2">·</span>
        <NavLink to="/changelog" className="hover:text-slate-400">
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
