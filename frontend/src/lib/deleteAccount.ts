// The one confirmation shown before an account is deleted, from Settings and
// from the policy gate alike. Release-bar clause 4: a destructive action's
// confirmation states what it does not undo -- and the consequence that lands
// on OTHER people is the one most easily left out. Pass 24 review (D-09):
// neither dialog said that deleting an account removes every event it
// organised for everyone invited, answers and all, with no message; and the
// policy-gate copy had drifted from Settings' (no Google line), which is why
// there is now one string.
export const DELETE_ACCOUNT_CONFIRMATION =
  "Permanently delete your account?\n\n" +
  "This removes your profile, personal time blocks, RSVPs, votes, group memberships, and every event you organised. It cannot be undone.\n\n" +
  "Every event you organised disappears for everyone invited to it, with their answers, and nobody is told. If any are still to come, let people know first.\n\n" +
  "Sessions already added to your Google calendar stay there — deleting your account revokes this app’s access, so it cannot reach them afterwards. Disconnect Google first if you want them removed.";
