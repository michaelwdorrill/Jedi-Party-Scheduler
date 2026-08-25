import { Navigate, Outlet } from 'react-router-dom';
import { useAuth } from './AuthContext';
import { ErrorState, Loading } from '../components/ui';

export default function AuthGuard() {
  const { isAuthenticated, loading, error, refreshUser } = useAuth();

  if (loading) {
    return <Loading className="h-screen" />;
  }

  // Checked before the redirect, never instead of it.
  //
  // `/me` failing used to mean `user = null`, which meant this guard sent you
  // to the login page -- so an unreachable Worker or a 5xx was reported as
  // "you are not logged in", a statement about the person rather than about
  // the request. It also made idea 24's whole point unreachable: any way of
  // breaking the API bounced you out before a page could show its error
  // state, which is how the sandbox review found this.
  //
  // The token is left alone here (only a real 401 clears it, in the API
  // client), so retrying, or reloading once the server is back, logs straight
  // back in without another OAuth round trip.
  if (error) {
    return (
      <div className="flex h-screen items-center justify-center px-4">
        <ErrorState
          title="Couldn't reach Uncle Owen"
          message={error}
          onRetry={() => void refreshUser()}
        />
      </div>
    );
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" replace />;
  }

  return <Outlet />;
}
