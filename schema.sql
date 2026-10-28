-- Cricket Auction — Live Polling · PostgreSQL schema
-- Applied automatically on first request (idempotent).

CREATE TABLE IF NOT EXISTS admins (
  id            SERIAL PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  display_name  TEXT,
  created_at    BIGINT NOT NULL,
  last_login_at BIGINT
);

CREATE TABLE IF NOT EXISTS admin_sessions (
  token      TEXT PRIMARY KEY,
  admin_id   INTEGER NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
  created_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS participants (
  id           SERIAL PRIMARY KEY,
  name         TEXT NOT NULL,
  employee_id  TEXT NOT NULL,
  team         TEXT,
  blocked      INTEGER NOT NULL DEFAULT 0,
  created_at   BIGINT NOT NULL,
  last_seen_at BIGINT NOT NULL
);
-- case-insensitive uniqueness for employee IDs
CREATE UNIQUE INDEX IF NOT EXISTS participants_employee_id_key ON participants (LOWER(employee_id));

CREATE TABLE IF NOT EXISTS participant_sessions (
  token          TEXT PRIMARY KEY,
  participant_id INTEGER NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  created_at     BIGINT NOT NULL,
  last_seen_at   BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS polls (
  id            SERIAL PRIMARY KEY,
  question      TEXT NOT NULL,
  description   TEXT,
  category      TEXT,
  status        TEXT NOT NULL DEFAULT 'draft',      -- draft | active | paused | closed
  show_results  TEXT NOT NULL DEFAULT 'after',      -- never | during | after
  anonymous     INTEGER NOT NULL DEFAULT 0,
  timer_seconds INTEGER NOT NULL DEFAULT 30,
  remaining_ms  BIGINT NOT NULL DEFAULT 0,
  started_at    BIGINT,
  ends_at       BIGINT,
  closed_at     BIGINT,
  revision      INTEGER NOT NULL DEFAULT 0,
  created_at    BIGINT NOT NULL,
  updated_at    BIGINT NOT NULL,
  created_by    TEXT
);

CREATE TABLE IF NOT EXISTS options (
  id       SERIAL PRIMARY KEY,
  poll_id  INTEGER NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
  label    TEXT NOT NULL,
  emoji    TEXT,
  position INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS votes (
  id             SERIAL PRIMARY KEY,
  poll_id        INTEGER NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
  option_id      INTEGER NOT NULL REFERENCES options(id) ON DELETE CASCADE,
  participant_id INTEGER NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  created_at     BIGINT NOT NULL,
  CONSTRAINT votes_one_per_participant UNIQUE (poll_id, participant_id)
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS activity_log (
  id         SERIAL PRIMARY KEY,
  actor      TEXT,
  action     TEXT NOT NULL,
  detail     TEXT,
  created_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_votes_poll ON votes(poll_id);
CREATE INDEX IF NOT EXISTS idx_options_poll ON options(poll_id, position);
CREATE INDEX IF NOT EXISTS idx_polls_status ON polls(status);
CREATE INDEX IF NOT EXISTS idx_participants_seen ON participants(last_seen_at);
CREATE INDEX IF NOT EXISTS idx_psessions_token ON participant_sessions(token);
