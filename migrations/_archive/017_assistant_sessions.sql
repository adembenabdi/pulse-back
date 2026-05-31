-- Migration: 017_assistant_sessions
-- Per-chat multi-turn state for the conversational assistant.
-- A session is opened when a user sends a message that produces a preview batch,
-- and is closed once the user confirms (`ok`), cancels, or it expires.
--
-- pending JSON shape:
-- {
--   "proposals": [
--     {
--       "kind": "task" | "note" | "idea" | "event" | "meeting" | "reminder" | "resource" | "habit_log",
--       "title": "...",
--       "...kind-specific fields...",
--       "confidence": 0.0..1.0,
--       "project_link": {
--         "mode": "existing" | "new" | "standalone" | "unknown",
--         "objective_id": "uuid?",
--         "candidates": [{ "id": "uuid", "title": "...", "score": 0.0..1.0 }]
--       },
--       "structured": { ... }   -- present when mode='new' and idea-organize ran
--     }
--   ],
--   "last_update_id": 12345     -- telegram update_id for idempotency (telegram surface only)
-- }

CREATE TABLE IF NOT EXISTS public.assistant_sessions (
  id          uuid        NOT NULL DEFAULT uuid_generate_v4(),
  user_id     uuid        NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  surface     text        NOT NULL CHECK (surface IN ('telegram', 'web')),
  chat_id     text,
  awaiting    text        NOT NULL DEFAULT 'confirm_batch',
  pending     jsonb       NOT NULL DEFAULT '{}'::jsonb,
  expires_at  timestamptz NOT NULL DEFAULT (now() + interval '15 minutes'),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT assistant_sessions_pkey PRIMARY KEY (id)
);

-- One open session per (user, surface, chat). chat_id NULL for web means
-- "default web chat for that user".
CREATE UNIQUE INDEX IF NOT EXISTS assistant_sessions_one_per_chat
  ON public.assistant_sessions (user_id, surface, COALESCE(chat_id, ''));

CREATE INDEX IF NOT EXISTS assistant_sessions_expires_idx
  ON public.assistant_sessions (expires_at);

CREATE OR REPLACE FUNCTION public.set_assistant_sessions_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS assistant_sessions_updated_at ON public.assistant_sessions;
CREATE TRIGGER assistant_sessions_updated_at
  BEFORE UPDATE ON public.assistant_sessions
  FOR EACH ROW EXECUTE FUNCTION public.set_assistant_sessions_updated_at();
