import { Navigate, Outlet } from 'react-router-dom';
import { useAuth } from './AuthContext';

export default function AuthGuard() {
  const { isAuthenticated, loading } = useAuth();

  if (loading) {
    return <div className="flex h-screen items-center justify-center text-muted">Loading…</div>;
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" replace />;
  }

  return <Outlet />;
}
