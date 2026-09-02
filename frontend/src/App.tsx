import { Navigate, Route, Routes } from 'react-router-dom';
import AuthGuard from './auth/AuthGuard';
import Layout from './components/Layout';
import LoginPage from './pages/LoginPage';
import AuthCallbackPage from './pages/AuthCallbackPage';
import HomePage from './pages/HomePage';
import EventDetailPage from './pages/EventDetailPage';
import EventFormPage from './pages/EventFormPage';
import GroupsPage from './pages/GroupsPage';
import PersonalEventPage from './pages/PersonalEventPage';
import PrivacyPage from './pages/PrivacyPage';
import TermsPage from './pages/TermsPage';
import ChangelogPage from './pages/ChangelogPage';
import SettingsPage from './pages/SettingsPage';
import AdminUsersPage from './pages/AdminUsersPage';
import AdminGuildRequestsPage from './pages/AdminGuildRequestsPage';
import RequestBotPage from './pages/RequestBotPage';

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/auth/callback" element={<AuthCallbackPage />} />
      {/* Public: Discord's app listing links straight to these, and they must
          be readable without logging in. */}
      <Route path="/privacy" element={<PrivacyPage />} />
      <Route path="/terms" element={<TermsPage />} />
      <Route path="/changelog" element={<ChangelogPage />} />
      {/* Public (specs/0015): its own short-lived Discord OAuth round trip,
          not the site's login session -- see RequestBotPage's own header
          comment for why it can't reuse AuthGuard. */}
      <Route path="/add-bot" element={<RequestBotPage />} />

      <Route element={<AuthGuard />}>
        <Route element={<Layout />}>
          <Route path="/" element={<HomePage />} />
          {/* Kept as a redirect rather than removed: it is bookmarkable, and
              the old Dashboard's empty state linked to it. */}
          <Route path="/calendar" element={<Navigate to="/" replace />} />
          <Route path="/groups" element={<GroupsPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/admin/users" element={<AdminUsersPage />} />
          <Route path="/admin/guild-requests" element={<AdminGuildRequestsPage />} />
          <Route path="/events/new" element={<EventFormPage />} />
          <Route path="/events/:eventId" element={<EventDetailPage />} />
          <Route path="/events/:eventId/edit" element={<EventFormPage />} />
          <Route path="/personal/:personalEventId" element={<PersonalEventPage />} />
        </Route>
      </Route>

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
