-- Migration: 018_ideas_project_link
-- Auto-promote: every idea is treated as a project. For ideas that don't yet
-- have an `objectives` row (`converted_to_id IS NULL`), create one and link.
-- Also bulk-insert structured.tasks as items under the new objective when
-- structured is present.
--
-- This makes `materialize` implicit going forward; the API endpoint stays for
-- backward compatibility but becomes a no-op when the link already exists.

DO $$
DECLARE
  rec        record;
  new_obj_id uuid;
  task       jsonb;
  prio       text;
BEGIN
  FOR rec IN
    SELECT id, user_id, role_id, title, description, structured, validation_status
    FROM public.ideas
    WHERE deleted_at IS NULL
      AND converted_to_id IS NULL
  LOOP
    INSERT INTO public.objectives (
      user_id, role_id, kind, title, description, status, priority
    ) VALUES (
      rec.user_id,
      rec.role_id,
      'project'::objective_kind,
      rec.title,
      COALESCE(rec.description, ''),
      CASE WHEN rec.validation_status = 'dropped' THEN 'cancelled'::item_status
           WHEN rec.validation_status = 'validated' THEN 'in_progress'::item_status
           ELSE 'todo'::item_status END,
      'medium'::priority_level
    )
    RETURNING id INTO new_obj_id;

    UPDATE public.ideas
       SET converted_to_id = new_obj_id,
           updated_at = now()
     WHERE id = rec.id;

    -- Bulk-insert structured tasks as items, if any.
    IF rec.structured IS NOT NULL
       AND jsonb_typeof(rec.structured -> 'tasks') = 'array' THEN
      FOR task IN SELECT * FROM jsonb_array_elements(rec.structured -> 'tasks') LOOP
        prio := COALESCE(task ->> 'priority', 'medium');
        IF prio NOT IN ('low', 'medium', 'high', 'urgent') THEN
          prio := 'medium';
        END IF;

        INSERT INTO public.items (
          user_id, role_id, objective_id, kind, title,
          status, priority, estimated_min
        ) VALUES (
          rec.user_id,
          rec.role_id,
          new_obj_id,
          'task'::item_kind,
          COALESCE(NULLIF(trim(task ->> 'title'), ''), 'Untitled task'),
          CASE WHEN COALESCE((task ->> 'done')::boolean, false)
               THEN 'done'::item_status
               ELSE 'todo'::item_status END,
          prio::priority_level,
          NULLIF((task ->> 'effort_min')::int, 0)
        );
      END LOOP;
    END IF;
  END LOOP;
END $$;
