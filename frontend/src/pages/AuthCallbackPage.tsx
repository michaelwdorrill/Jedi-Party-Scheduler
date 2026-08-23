import { useEffect, useRef, useState } from 'react';
import { Navigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';

export default function AuthCallbackPage() {
  const { login } = useAuth();
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const ran = useRef(false);

  useEffect(() => {
    if (ran.current) return;
    ran.current = true;

    const params = new URLSearchParams(window.location.hash.split('?')[1] ?? '');
    const token = params.get('token');
    if (!token) {
      setError('No login token was returned by Discord. Please try logging in again.');
      return;
    }
    login(token)
      .then(() => setDone(true))
      .catch(() => setError('Login failed. Please try again.'));
  }, [login]);

  if (error) {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-4">
        <p className="text-danger-text">{error}</p>
        <a href="#/login" className="text-accent-text underline">
          Back to login
        </a>
      </div>
    );
  }

  if (done) return <Navigate to="/" replace />;

  return <div className="flex h-screen items-center justify-center text-muted">Signing you in…</div>;
}
