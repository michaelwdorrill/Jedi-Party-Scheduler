import { useState } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import GuildSwitcher from './GuildSwitcher';

const navLinkClass = ({ isActive }: { isActive: boolean }) =>
  `rounded-md px-3 py-2 text-sm font-medium ${
    isActive ? 'bg-indigo-600 text-white' : 'text-slate-300 hover:bg-slate-800 hover:text-white'
  }`;

export default function Layout() {
  const { user, logout } = useAuth();
  const [revokeFailed, setRevokeFailed] = useState(false);

  // Saying "logged out" when the server-side session is still alive would be
  // a lie the user can't act on. It's queued for retry either way, but they
  // deserve to know it hasn't happened yet.
  const handleLogout = async () => {
    const revoked = await logout();
    setRevokeFailed(!revoked);
  };

  return (
    <div className="min-h-screen">
      {revokeFailed && (
        <div className="bg-amber-900/60 px-4 py-2 text-center text-sm text-amber-100">
          You're signed out on this device, but we couldn't reach the server to end the session. It'll
          be ended automatically next time you're online.
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
            <GuildSwitcher />
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
      </footer>
    </div>
  );
}
