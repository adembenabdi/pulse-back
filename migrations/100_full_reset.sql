-- ============================================================================
-- 100_full_reset.sql
-- ONE self-contained reset for the focused 5-module app:
--   Tasks · Projects · Calendar · Ideas · Prayer  (+ AI assistant)
--
-- This migration:
--   1. Drops EVERYTHING in the public schema (tables + enums), except the
--      `migrations` tracking table itself.
--   2. Recreates the auth/session tables.
--   3. Recreates the 5-module schema + AI assistant tables.
--   4. Seeds the single owner account.
--
-- The owner password is hashed in-database with pgcrypto's bcrypt
-- (`crypt(... gen_salt('bf', 12))`), which produces a `$2a$` hash that the
-- app's bcryptjs `compare()` verifies natively.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;  -- gen_random_uuid(), crypt(), gen_salt()

-- ── 1. Drop every table except the migration tracker ─────────────────────────
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT tablename
    FROM   pg_tables
    WHERE  schemaname = 'public'
      AND  tablename <> 'migrations'
  LOOP
    EXECUTE format('DROP TABLE IF EXISTS public.%I CASCADE', r.tablename);
  END LOOP;
END $$;

-- ── 2. Drop every custom enum type ───────────────────────────────────────────
DO $$
DECLARE t record;
BEGIN
  FOR t IN
    SELECT ty.typname
    FROM   pg_type ty
    JOIN   pg_namespace n ON n.oid = ty.typnamespace
    WHERE  n.nspname = 'public'
      AND  ty.typtype = 'e'
  LOOP
    EXECUTE format('DROP TYPE IF EXISTS public.%I CASCADE', t.typname);
  END LOOP;
END $$;

-- ── 3. Auth / session tables ─────────────────────────────────────────────────
CREATE TABLE public.users (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email            text NOT NULL UNIQUE,
  name             text NOT NULL,
  password_hash    text NOT NULL,
  avatar_url       text,
  preferences      jsonb NOT NULL DEFAULT '{}'::jsonb,
  telegram_chat_id text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  deleted_at       timestamptz
);

CREATE TABLE public.user_sessions (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  user_agent text,
  ip         text,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_user_sessions_user ON public.user_sessions (user_id);

CREATE TABLE public.password_reset_tokens (
  user_id    uuid PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
  code       text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.telegram_link_tokens (
  token      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid REFERENCES public.users(id) ON DELETE CASCADE,
  chat_id    text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '10 minutes')
);

-- ── 4. Enums ─────────────────────────────────────────────────────────────────
CREATE TYPE task_status   AS ENUM ('todo', 'in_progress', 'done');
CREATE TYPE task_priority AS ENUM ('low', 'medium', 'high', 'urgent');
CREATE TYPE prayer_name   AS ENUM ('fajr', 'dhuhr', 'asr', 'maghrib', 'isha');
CREATE TYPE idea_status   AS ENUM ('raw', 'structured', 'archived');

-- ── 5. Projects ──────────────────────────────────────────────────────────────
CREATE TABLE public.projects (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  name        text NOT NULL,
  description text,
  color       text NOT NULL DEFAULT '#7c5cff',
  status      text NOT NULL DEFAULT 'active',  -- active | archived
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  deleted_at  timestamptz
);
CREATE INDEX idx_projects_user ON public.projects (user_id) WHERE deleted_at IS NULL;

-- ── 6. Tasks (optional project, self-referencing subtasks) ───────────────────
CREATE TABLE public.tasks (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  project_id     uuid REFERENCES public.projects(id) ON DELETE CASCADE,
  parent_task_id uuid REFERENCES public.tasks(id) ON DELETE CASCADE,
  title          text NOT NULL,
  notes          text,
  status         task_status   NOT NULL DEFAULT 'todo',
  priority       task_priority NOT NULL DEFAULT 'medium',
  due_at         timestamptz,
  starts_at      timestamptz,
  sort_order     integer NOT NULL DEFAULT 0,
  completed_at   timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  deleted_at     timestamptz
);
CREATE INDEX idx_tasks_user    ON public.tasks (user_id)        WHERE deleted_at IS NULL;
CREATE INDEX idx_tasks_project ON public.tasks (project_id)     WHERE deleted_at IS NULL;
CREATE INDEX idx_tasks_parent  ON public.tasks (parent_task_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_tasks_due     ON public.tasks (due_at)         WHERE deleted_at IS NULL;

-- ── 7. Calendar events (standalone; may reference a task) ────────────────────
CREATE TABLE public.calendar_events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  task_id     uuid REFERENCES public.tasks(id) ON DELETE CASCADE,
  title       text NOT NULL,
  description text,
  location    text,
  starts_at   timestamptz NOT NULL,
  ends_at     timestamptz,
  all_day     boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  deleted_at  timestamptz
);
CREATE INDEX idx_events_user  ON public.calendar_events (user_id)   WHERE deleted_at IS NULL;
CREATE INDEX idx_events_start ON public.calendar_events (starts_at) WHERE deleted_at IS NULL;

-- ── 8. Prayer logs (one row per user/prayer/day) ─────────────────────────────
CREATE TABLE public.prayer_logs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  prayer      prayer_name NOT NULL,
  prayed_date date NOT NULL,
  completed   boolean NOT NULL DEFAULT true,
  prayed_at   timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, prayer, prayed_date)
);
CREATE INDEX idx_prayer_user_date ON public.prayer_logs (user_id, prayed_date);

-- ── 9. Ideas (raw text + AI-structured plan) ─────────────────────────────────
CREATE TABLE public.ideas (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  title       text NOT NULL,
  raw_text    text,
  -- { overview, steps: [{title, done}], resources: [string], notes: string }
  structured  jsonb,
  status      idea_status NOT NULL DEFAULT 'raw',
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  deleted_at  timestamptz
);
CREATE INDEX idx_ideas_user ON public.ideas (user_id) WHERE deleted_at IS NULL;

-- ── 10. AI assistant conversations + messages (web + telegram) ───────────────
CREATE TABLE public.ai_conversations (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  surface    text NOT NULL DEFAULT 'web',  -- web | telegram
  title      text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_ai_conv_user ON public.ai_conversations (user_id);

CREATE TABLE public.ai_messages (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES public.ai_conversations(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  role            text NOT NULL,  -- user | assistant | system
  content         text NOT NULL,
  actions         jsonb,          -- list of actions the assistant performed
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_ai_msg_conv ON public.ai_messages (conversation_id, created_at);

-- ── 11. Seed the owner account ───────────────────────────────────────────────
--   email:    adem.benabdi.b@gmail.com
--   password: adem2018  (bcrypt $2a$ hash, verifiable by bcryptjs)
INSERT INTO public.users (email, name, password_hash, preferences)
VALUES (
  'adem.benabdi.b@gmail.com',
  'Adem',
  crypt('adem2018', gen_salt('bf', 12)),
  '{"timezone":"Africa/Algiers"}'::jsonb
);
