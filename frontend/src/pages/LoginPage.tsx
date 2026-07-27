import { Navigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { API_BASE_URL } from '../api/client';

export default function LoginPage() {
  const { isAuthenticated, loading } = useAuth();

  if (loading) return null;
  if (isAuthenticated) return <Navigate to="/" replace />;

  return (
    <div className="flex h-screen flex-col items-center justify-center gap-6">
      <h1 className="text-3xl font-bold">Uncle Owen</h1>
      <p className="max-w-md text-center text-slate-400">
        Log in with Discord to see the schedule for your servers and coordinate
        sessions with your friends.
      </p>
      <a
        href={`${API_BASE_URL}/auth/login`}
        className="rounded-md bg-indigo-600 px-5 py-3 font-semibold text-white hover:bg-indigo-500"
      >
        Log in with Discord
      </a>
    </div>
  );
}
