-- Migration: 015_entity_links_unified_view
-- Creates a read-only view that merges entity_links, item_links, resource_links,
-- and item_dependencies into a single normalized edge list.
-- The graph API and search read from this view so legacy links are always visible.

CREATE OR REPLACE VIEW public.entity_links_unified AS

  -- 1. New universal links (primary source)
  SELECT
    el.user_id,
    el.source_type,
    el.source_id,
    el.target_type,
    el.target_id,
    el.relation,
    el.label,
    el.weight,
    el.metadata,
    el.created_by,
    el.created_at,
    'entity_links'  AS source_table,
    el.id           AS link_id
  FROM public.entity_links el

  UNION ALL

  -- 2. item_links: item → any entity (relation type: 'related_to')
  SELECT
    i.user_id,
    'item'           AS source_type,
    il.item_id       AS source_id,
    il.entity_type   AS target_type,
    il.entity_id     AS target_id,
    'related_to'     AS relation,
    NULL             AS label,
    1                AS weight,
    '{}'::jsonb      AS metadata,
    'system'         AS created_by,
    il.created_at,
    'item_links'     AS source_table,
    il.id            AS link_id
  FROM public.item_links il
  JOIN public.items i ON i.id = il.item_id

  UNION ALL

  -- 3. resource_links: resource → any entity (relation type: 'references')
  SELECT
    r.user_id,
    'resource'       AS source_type,
    rl.resource_id   AS source_id,
    rl.entity_type   AS target_type,
    rl.entity_id     AS target_id,
    'references'     AS relation,
    NULL             AS label,
    1                AS weight,
    '{}'::jsonb      AS metadata,
    'system'         AS created_by,
    r.created_at,
    'resource_links' AS source_table,
    NULL::uuid       AS link_id
  FROM public.resource_links rl
  JOIN public.resources r ON r.id = rl.resource_id

  UNION ALL

  -- 4. item_dependencies: item → item (relation type: 'depends_on')
  SELECT
    i.user_id,
    'item'           AS source_type,
    id_.item_id      AS source_id,
    'item'           AS target_type,
    id_.depends_on_id AS target_id,
    'depends_on'     AS relation,
    NULL             AS label,
    1                AS weight,
    '{}'::jsonb      AS metadata,
    'system'         AS created_by,
    i.created_at,
    'item_dependencies' AS source_table,
    NULL::uuid       AS link_id
  FROM public.item_dependencies id_
  JOIN public.items i ON i.id = id_.item_id;
