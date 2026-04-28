-- Migration: 016_link_suggestions
-- Stores AI-generated link proposals that the user can accept or dismiss.
-- Accepted suggestions are promoted to entity_links with created_by = 'ai'.

CREATE TABLE IF NOT EXISTS public.link_suggestions (
  id          uuid        NOT NULL DEFAULT uuid_generate_v4(),
  user_id     uuid        NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,

  source_type text        NOT NULL,
  source_id   uuid        NOT NULL,
  target_type text        NOT NULL,
  target_id   uuid        NOT NULL,

  relation    text        NOT NULL,
  confidence  real        NOT NULL DEFAULT 0.5 CHECK (confidence >= 0 AND confidence <= 1),
  reason      text,

  -- pending | accepted | dismissed
  status      text        NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending', 'accepted', 'dismissed')),

  -- if accepted, the resulting entity_links row
  entity_link_id uuid     REFERENCES public.entity_links(id) ON DELETE SET NULL,

  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT link_suggestions_pkey PRIMARY KEY (id)
);

CREATE INDEX IF NOT EXISTS link_suggestions_user_pending_idx
  ON public.link_suggestions (user_id, created_at DESC)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS link_suggestions_source_idx
  ON public.link_suggestions (user_id, source_type, source_id)
  WHERE status = 'pending';

-- Auto-update updated_at
CREATE OR REPLACE FUNCTION public.set_link_suggestions_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS link_suggestions_updated_at ON public.link_suggestions;
CREATE TRIGGER link_suggestions_updated_at
  BEFORE UPDATE ON public.link_suggestions
  FOR EACH ROW EXECUTE FUNCTION public.set_link_suggestions_updated_at();
