-- Migration: 014_entity_links
-- Adds the universal relationship layer: entity_links + link_suggestions tables.
-- Existing link tables (item_links, resource_links, item_dependencies) are kept intact.

-- ── Allowed relation types ────────────────────────────────────────────────────
-- depends_on     : source cannot proceed until target is done
-- blocks         : source prevents target from proceeding
-- contributes_to : source helps achieve target (e.g. task → objective)
-- uses           : source consumes / references target (e.g. meal_plan → recipe)
-- related_to     : generic symmetric relevance
-- references     : source cites / links to target (e.g. note → idea)
-- mentions_person: source involves a person (connection/user)
-- custom         : user-defined, requires non-null `label`

CREATE TABLE IF NOT EXISTS public.entity_links (
  id          uuid        NOT NULL DEFAULT uuid_generate_v4(),
  user_id     uuid        NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,

  source_type text        NOT NULL,
  source_id   uuid        NOT NULL,
  target_type text        NOT NULL,
  target_id   uuid        NOT NULL,

  -- relation type; 'custom' requires a non-null label
  relation    text        NOT NULL DEFAULT 'related_to',
  label       text,

  -- optional weight for AI ranking (1 = default, higher = stronger signal)
  weight      smallint    NOT NULL DEFAULT 1,

  -- arbitrary extra data (e.g. AI confidence, context snippet)
  metadata    jsonb       NOT NULL DEFAULT '{}',

  -- who created this link
  created_by  text        NOT NULL DEFAULT 'user'
                          CHECK (created_by IN ('user', 'ai', 'system')),

  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT entity_links_pkey PRIMARY KEY (id),

  -- no self-links
  CONSTRAINT entity_links_no_self CHECK (
    (source_type, source_id) <> (target_type, target_id)
  ),

  -- custom relation must have a label
  CONSTRAINT entity_links_custom_label CHECK (
    relation <> 'custom' OR (label IS NOT NULL AND label <> '')
  ),

  -- relation must be one of the known types
  CONSTRAINT entity_links_relation_check CHECK (
    relation IN ('depends_on','blocks','contributes_to','uses','related_to','references','mentions_person','custom')
  )
);

-- Prevent duplicate edges for the same (user, source, target, relation)
CREATE UNIQUE INDEX IF NOT EXISTS entity_links_no_dup
  ON public.entity_links (user_id, source_type, source_id, target_type, target_id, relation);

-- Query indexes
CREATE INDEX IF NOT EXISTS entity_links_source_idx
  ON public.entity_links (user_id, source_type, source_id);

CREATE INDEX IF NOT EXISTS entity_links_target_idx
  ON public.entity_links (user_id, target_type, target_id);

CREATE INDEX IF NOT EXISTS entity_links_relation_idx
  ON public.entity_links (user_id, relation);

-- Partial index for AI-created links (used for suggestions dashboard)
CREATE INDEX IF NOT EXISTS entity_links_ai_idx
  ON public.entity_links (user_id, created_at DESC)
  WHERE created_by = 'ai';

-- Auto-update updated_at
CREATE OR REPLACE FUNCTION public.set_entity_links_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS entity_links_updated_at ON public.entity_links;
CREATE TRIGGER entity_links_updated_at
  BEFORE UPDATE ON public.entity_links
  FOR EACH ROW EXECUTE FUNCTION public.set_entity_links_updated_at();
