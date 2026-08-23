import { Navigate, Outlet } from 'react-router-dom';
import { useAuth } from './AuthContext';
import { Loading } from '../components/ui';

export default function AuthGuard() {
  const { isAuthenticated, loading } = useAuth();

  if (loading) {
    return <Loading className="h-screen" />;
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" replace />;
  }

  return <Outlet />;
}
