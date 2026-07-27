-- Server-side revocable sessions (security review F-02). The JWT's own
-- signature/expiry can never be revoked once issued; this table is the real
-- authority check on every request (see lib/authMiddleware.ts) so logout,
-- account deletion, and a leaked-token response take effect immediately
-- instead of waiting out the token's lifetime.
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE INDEX idx_sessions_user ON sessions(user_id);
