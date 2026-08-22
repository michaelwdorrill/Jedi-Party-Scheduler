import { Link, Navigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { API_BASE_URL } from '../api/client';
import { buttonClass } from '../components/ui';

export default function LoginPage() {
  const { isAuthenticated, loading } = useAuth();

  if (loading) return null;
  if (isAuthenticated) return <Navigate to="/" replace />;

  return (
    <div className="flex h-screen flex-col items-center justify-center gap-6">
      <h1 className="text-3xl font-bold">Uncle Owen</h1>
      <p className="max-w-md text-center text-muted">
        Log in with Discord to see the schedule for your servers and coordinate
        sessions with your friends.
      </p>
      <a
        href={`${API_BASE_URL}/auth/login`}
        className={buttonClass('primary', 'hero')}
      >
        Log in with Discord
      </a>
      <p className="text-xs text-fainter">
        By logging in you agree to the{' '}
        <Link to="/terms" className="underline hover:text-muted">
          Terms
        </Link>{' '}
        and{' '}
        <Link to="/privacy" className="underline hover:text-muted">
          Privacy Policy
        </Link>
        .
      </p>
    </div>
  );
}
