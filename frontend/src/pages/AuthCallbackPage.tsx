import { useEffect, useRef, useState } from 'react';
import { Navigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { LoginNotStartedError, redeemLoginCode } from '../auth/loginTransaction';

export default function AuthCallbackPage() {
  const { login } = useAuth();
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const ran = useRef(false);

  useEffect(() => {
    if (ran.current) return;
    ran.current = true;

    const params = new URLSearchParams(window.location.hash.split('?')[1] ?? '');
    const code = params.get('code');
    if (!code) {
      setError('No login code was returned by Discord. Please try logging in again.');
      return;
    }
    // The code is not a session -- it has to be redeemed with the verifier
    // this browser parked before it started the login (R02 in the Pass-11
    // review). A callback URL that arrives any other way has no verifier to
    // redeem it with, which is what stops someone being logged into an
    // account they did not ask for.
    redeemLoginCode(code)
      .then((token) => login(token))
      .then(() => setDone(true))
      .catch((e: unknown) => {
        setError(
          e instanceof LoginNotStartedError
            ? 'This browser did not start a login. Open the app and log in from there.'
            : 'Login failed. Please try again.',
        );
      });
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
