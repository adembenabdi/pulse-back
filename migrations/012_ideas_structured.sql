-- Adds a JSONB column to hold the AI-organized version of an idea:
-- { summary, target_audience, tasks: [{title, effort_min, priority, done}],
--   materials: [{name, category, note}], extra_features: [{title, description}],
--   risks: [string], next_step: string, generated_at: ISO }
ALTER TABLE public.ideas
  ADD COLUMN IF NOT EXISTS structured jsonb,
  ADD COLUMN IF NOT EXISTS raw_description text;

CREATE INDEX IF NOT EXISTS idx_ideas_structured_present
  ON public.ideas ((structured IS NOT NULL))
  WHERE deleted_at IS NULL;
