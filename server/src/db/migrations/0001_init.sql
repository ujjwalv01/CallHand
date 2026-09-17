-- 0001_init.sql
-- The core schema. Read this file first to understand the system: every
-- other module exists to move data into or out of these tables.
--
-- Conventions
--   * uuid primary keys (safe to expose in URLs, no sequential guessing)
--   * timestamptz everywhere; all times stored in UTC, converted to the
--     business's timezone at the edges
--   * snake_case column names; JS layer camelCases at the boundary
--   * ON DELETE CASCADE where a child is meaningless without its parent

CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS citext;     -- case-insensitive text, for emails

-- ---------------------------------------------------------------------------
-- Accounts
-- ---------------------------------------------------------------------------

-- A login. One user can own several businesses (multi-location comes later).
CREATE TABLE users (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  email         citext      NOT NULL UNIQUE,
  password_hash text        NOT NULL,
  full_name     text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- The contractor
-- ---------------------------------------------------------------------------

-- One row per HVAC/plumbing company. Holds everything the voice agent needs
-- to introduce itself and everything the dispatcher needs to route a call.
CREATE TABLE businesses (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id     uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  name              text        NOT NULL,
  trade             text        NOT NULL DEFAULT 'hvac'
                                CHECK (trade IN ('hvac', 'plumbing', 'electrical', 'general')),
  timezone          text        NOT NULL DEFAULT 'America/Chicago',   -- IANA name
  service_area      text,                                             -- "Dallas–Fort Worth, 30 mi of 75201"

  owner_phone       text        NOT NULL,                             -- E.164; emergency transfers + alerts
  owner_email       citext,

  -- Voice agent persona
  agent_name        text        NOT NULL DEFAULT 'Sam',
  greeting          text,                                             -- null = generated from name + agent_name

  -- Telephony. The number the owner forwards their line to.
  phone_number      text        UNIQUE,                               -- E.164
  vapi_assistant_id text,                                             -- per-business override; null = shared assistant

  -- Behaviour
  after_hours_only  boolean     NOT NULL DEFAULT true,                -- answer only outside business_hours

  -- Billing
  plan              text        NOT NULL DEFAULT 'trial'
                                CHECK (plan IN ('trial', 'starter', 'growth', 'pro', 'cancelled')),
  trial_ends_at     timestamptz,

  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX businesses_owner_idx ON businesses (owner_user_id);

-- Weekly opening hours. Seven rows per business, one per weekday.
-- Times are local wall-clock in the business's timezone.
CREATE TABLE business_hours (
  business_id uuid    NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  day         text    NOT NULL CHECK (day IN ('sun','mon','tue','wed','thu','fri','sat')),
  opens_at    time    NOT NULL DEFAULT '08:00',
  closes_at   time    NOT NULL DEFAULT '17:00',
  is_closed   boolean NOT NULL DEFAULT false,
  PRIMARY KEY (business_id, day),
  CHECK (is_closed OR opens_at < closes_at)
);

-- What the agent is allowed to book. estimated_value feeds the
-- "$ captured this month" number on the dashboard, which is the
-- single figure that renews subscriptions.
CREATE TABLE services (
  id               uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id      uuid          NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name             text          NOT NULL,                     -- "AC repair", "Water heater install"
  duration_minutes integer       NOT NULL DEFAULT 120 CHECK (duration_minutes BETWEEN 15 AND 720),
  estimated_value  numeric(10,2) NOT NULL DEFAULT 0 CHECK (estimated_value >= 0),
  price_quote      text,                                       -- spoken only if owner sets it: "$89 diagnostic fee"
  is_emergency     boolean       NOT NULL DEFAULT false,
  is_active        boolean       NOT NULL DEFAULT true,
  sort_order       integer       NOT NULL DEFAULT 0,
  UNIQUE (business_id, name)
);

CREATE INDEX services_business_idx ON services (business_id) WHERE is_active;

-- ---------------------------------------------------------------------------
-- What happens on the phone
-- ---------------------------------------------------------------------------

-- One row per inbound call. Created when the call starts (so the dashboard
-- shows live calls) and completed by the end-of-call webhook.
CREATE TABLE calls (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id      uuid        REFERENCES businesses(id) ON DELETE SET NULL,
  provider_call_id text        UNIQUE,                         -- Vapi's id; the idempotency key for webhooks

  from_number      text,
  to_number        text,
  started_at       timestamptz,
  ended_at         timestamptz,
  duration_seconds integer,
  after_hours      boolean,                                    -- computed at call start from business_hours

  status           text        NOT NULL DEFAULT 'in_progress'
                               CHECK (status IN ('in_progress', 'completed', 'failed', 'transferred')),
  outcome          text        CHECK (outcome IN ('booked', 'emergency', 'message', 'info', 'spam', 'unknown')),

  -- Extracted by the post-call analysis
  caller_name      text,
  caller_address   text,
  issue_summary    text,
  urgency          text        CHECK (urgency IN ('routine', 'soon', 'emergency')),

  transcript       text,
  recording_url    text,
  summary          text,
  raw              jsonb,                                      -- full provider payload, for debugging

  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX calls_business_started_idx ON calls (business_id, started_at DESC);
CREATE INDEX calls_business_outcome_idx ON calls (business_id, outcome);

-- A job the agent put on the calendar.
CREATE TABLE bookings (
  id               uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id      uuid          NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  call_id          uuid          REFERENCES calls(id) ON DELETE SET NULL,
  service_id       uuid          REFERENCES services(id) ON DELETE SET NULL,

  customer_name    text          NOT NULL,
  customer_phone   text          NOT NULL,
  customer_address text,
  issue            text,

  starts_at        timestamptz   NOT NULL,                     -- arrival window start
  ends_at          timestamptz   NOT NULL,
  status           text          NOT NULL DEFAULT 'scheduled'
                                 CHECK (status IN ('scheduled', 'confirmed', 'cancelled', 'completed', 'no_show')),
  estimated_value  numeric(10,2) NOT NULL DEFAULT 0,
  external_ref     text,                                       -- Jobber / Google Calendar id once synced

  created_at       timestamptz   NOT NULL DEFAULT now(),
  updated_at       timestamptz   NOT NULL DEFAULT now(),
  CHECK (starts_at < ends_at)
);

-- The scheduling engine's hot path: "what's booked between X and Y?"
CREATE INDEX bookings_business_window_idx ON bookings (business_id, starts_at, ends_at)
  WHERE status <> 'cancelled';

-- Every text we send or receive, for audit and for the call detail view.
CREATE TABLE sms_messages (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id  uuid        REFERENCES businesses(id) ON DELETE CASCADE,
  call_id      uuid        REFERENCES calls(id) ON DELETE SET NULL,
  direction    text        NOT NULL CHECK (direction IN ('outbound', 'inbound')),
  to_number    text        NOT NULL,
  from_number  text        NOT NULL,
  body         text        NOT NULL,
  purpose      text        CHECK (purpose IN ('caller_confirmation', 'owner_booking', 'owner_emergency',
                                              'owner_message', 'daily_summary', 'missed_call_textback')),
  provider_sid text,                                           -- Twilio message sid
  status       text,                                           -- queued | sent | delivered | failed | skipped
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX sms_business_created_idx ON sms_messages (business_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- Third-party connections
-- ---------------------------------------------------------------------------

-- OAuth tokens for Jobber / Housecall Pro / Google Calendar.
-- TODO before production: encrypt access_token/refresh_token at rest.
CREATE TABLE integrations (
  business_id   uuid        NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  provider      text        NOT NULL CHECK (provider IN ('jobber', 'housecall_pro', 'google_calendar')),
  access_token  text,
  refresh_token text,
  expires_at    timestamptz,
  metadata      jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, provider)
);

-- ---------------------------------------------------------------------------
-- updated_at maintenance
-- ---------------------------------------------------------------------------

-- Postgres has no "on update" column default, so a trigger keeps updated_at
-- honest without every UPDATE statement having to remember it.
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER users_updated_at        BEFORE UPDATE ON users        FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER businesses_updated_at   BEFORE UPDATE ON businesses   FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER bookings_updated_at     BEFORE UPDATE ON bookings     FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER integrations_updated_at BEFORE UPDATE ON integrations FOR EACH ROW EXECUTE FUNCTION set_updated_at();
