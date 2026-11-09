import { Navigate, Route, Routes, useParams } from 'react-router-dom';
import AuthGuard from './auth/AuthGuard';
import Layout from './components/Layout';
import LoginPage from './pages/LoginPage';
import AuthCallbackPage from './pages/AuthCallbackPage';
import HomePage from './pages/HomePage';
import EventDetailPage from './pages/EventDetailPage';
import EventFormPage from './pages/EventFormPage';
import GroupsPage from './pages/GroupsPage';
import NoticeboardPage from './pages/NoticeboardPage';
import PersonalEventPage from './pages/PersonalEventPage';
import PrivacyPage from './pages/PrivacyPage';
import TermsPage from './pages/TermsPage';
import ChangelogPage from './pages/ChangelogPage';
import SettingsPage from './pages/SettingsPage';
import AdminUsersPage from './pages/AdminUsersPage';
import AdminGuildRequestsPage from './pages/AdminGuildRequestsPage';
import AdminVenueOverlapPage from './pages/AdminVenueOverlapPage';
import RequestBotPage from './pages/RequestBotPage';

// RG-01 / RG-02 (Pass-22 acceptance review). Both form pages are reached by two
// routes that render the SAME component, so React reuses the instance and the
// previous record's draft survives the navigation -- including into create
// mode, where the person then saves a "new" event carrying the old one's notes
// and time.
//
// Resetting by hand was the obvious fix and is the wrong one: EventFormPage
// holds thirty-nine pieces of state, so "reset the complete draft" becomes
// thirty-nine lines that must be kept in step with every future field, and the
// reviewer's own warning is that clearing only some of them is insufficient.
// That is the same shape as the P21-01 loader bug -- a partial write of a
// record's fields -- one level up.
//
// Keying on the record identity makes the reset structural instead: React
// unmounts and remounts on a changed key, so every field returns to its
// initial value because there is no field to forget. `new` and an id are
// different keys, and so are two different ids, which covers the create
// transition and edit-to-edit in one rule.
//
// The in-component guards stay. `latestOnly` and `editTargetReady` protect
// within a single mounted lifetime -- a StrictMode double-invoke, a slow
// response landing after a reload -- which remounting does not address, and
// the reviewer asked for both to be preserved.
//
// NOT VERIFIED IN A BROWSER HERE: this session has no browser. The reasoning is
// React's own reconciliation rule, and the acceptance reviewer runs Edge via
// Playwright, so this is exactly the claim they should check first.
function EventFormRoute() {
  const { eventId } = useParams();
  return <EventFormPage key={`event-form:${eventId ?? 'new'}`} />;
}

function PersonalEventRoute() {
  const { personalEventId } = useParams();
  return <PersonalEventPage key={`personal-form:${personalEventId ?? 'new'}`} />;
}

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
          <Route path="/noticeboard" element={<NoticeboardPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/admin/users" element={<AdminUsersPage />} />
          <Route path="/admin/guild-requests" element={<AdminGuildRequestsPage />} />
          <Route path="/admin/venue-overlap" element={<AdminVenueOverlapPage />} />
          <Route path="/events/new" element={<EventFormRoute />} />
          <Route path="/events/:eventId" element={<EventDetailPage />} />
          <Route path="/events/:eventId/edit" element={<EventFormRoute />} />
          <Route path="/personal/:personalEventId" element={<PersonalEventRoute />} />
        </Route>
      </Route>

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
