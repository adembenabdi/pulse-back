-- WARNING: This schema is for context only and is not meant to be run.
-- Table order and constraints may not be valid for execution.

CREATE TABLE public.accounts (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  user_id uuid NOT NULL,
  name text NOT NULL,
  kind text NOT NULL DEFAULT 'bank'::text,
  currency character NOT NULL DEFAULT 'DZD'::bpchar,
  balance numeric NOT NULL DEFAULT 0,
  is_default boolean NOT NULL DEFAULT false,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  deleted_at timestamp with time zone,
  CONSTRAINT accounts_pkey PRIMARY KEY (id),
  CONSTRAINT accounts_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id)
);
CREATE TABLE public.ai_actions (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  user_id uuid NOT NULL,
  conversation_id uuid,
  action_type text NOT NULL,
  entity_type text,
  entity_id uuid,
  payload jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT ai_actions_pkey PRIMARY KEY (id),
  CONSTRAINT ai_actions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id),
  CONSTRAINT ai_actions_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES public.ai_conversations(id)
);
CREATE TABLE public.ai_conversations (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  user_id uuid NOT NULL,
  title text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  deleted_at timestamp with time zone,
  CONSTRAINT ai_conversations_pkey PRIMARY KEY (id),
  CONSTRAINT ai_conversations_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id)
);
CREATE TABLE public.ai_messages (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  conversation_id uuid NOT NULL,
  user_id uuid NOT NULL,
  role text NOT NULL,
  content text NOT NULL,
  model text,
  prompt_tokens integer,
  completion_tokens integer,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT ai_messages_pkey PRIMARY KEY (id),
  CONSTRAINT ai_messages_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES public.ai_conversations(id),
  CONSTRAINT ai_messages_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id)
);
CREATE TABLE public.budgets (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  user_id uuid NOT NULL,
  role_id uuid,
  category_id uuid,
  period_type text NOT NULL DEFAULT 'monthly'::text,
  amount_cap numeric NOT NULL,
  currency character NOT NULL DEFAULT 'DZD'::bpchar,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  deleted_at timestamp with time zone,
  CONSTRAINT budgets_pkey PRIMARY KEY (id),
  CONSTRAINT budgets_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id),
  CONSTRAINT budgets_role_id_fkey FOREIGN KEY (role_id) REFERENCES public.roles(id),
  CONSTRAINT budgets_category_id_fkey FOREIGN KEY (category_id) REFERENCES public.categories(id)
);
CREATE TABLE public.calendar_item_participants (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  cal_item_id uuid NOT NULL,
  user_id uuid,
  name text,
  email text,
  status USER-DEFINED NOT NULL DEFAULT 'pending'::invite_status,
  CONSTRAINT calendar_item_participants_pkey PRIMARY KEY (id),
  CONSTRAINT calendar_item_participants_cal_item_id_fkey FOREIGN KEY (cal_item_id) REFERENCES public.calendar_items(id),
  CONSTRAINT calendar_item_participants_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id)
);
CREATE TABLE public.calendar_items (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  user_id uuid NOT NULL,
  role_id uuid,
  item_id uuid,
  kind USER-DEFINED NOT NULL DEFAULT 'event'::cal_kind,
  source USER-DEFINED NOT NULL DEFAULT 'manual'::cal_source,
  title text NOT NULL,
  description text,
  location text,
  starts_at timestamp with time zone NOT NULL,
  ends_at timestamp with time zone NOT NULL,
  actual_start timestamp with time zone,
  actual_end timestamp with time zone,
  status USER-DEFINED NOT NULL DEFAULT 'planned'::cal_status,
  recurrence text,
  recurrence_id uuid,
  meeting_url text,
  external_id text,
  external_cal_id uuid,
  energy_required USER-DEFINED,
  all_day boolean NOT NULL DEFAULT false,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  deleted_at timestamp with time zone,
  CONSTRAINT calendar_items_pkey PRIMARY KEY (id),
  CONSTRAINT calendar_items_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id),
  CONSTRAINT calendar_items_role_id_fkey FOREIGN KEY (role_id) REFERENCES public.roles(id),
  CONSTRAINT calendar_items_item_id_fkey FOREIGN KEY (item_id) REFERENCES public.items(id),
  CONSTRAINT calendar_items_recurrence_id_fkey FOREIGN KEY (recurrence_id) REFERENCES public.calendar_items(id)
);
CREATE TABLE public.categories (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  user_id uuid,
  name text NOT NULL,
  icon text,
  color text,
  kind USER-DEFINED NOT NULL DEFAULT 'expense'::tx_kind,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT categories_pkey PRIMARY KEY (id),
  CONSTRAINT categories_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id)
);
CREATE TABLE public.connection_requests (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  from_user_id uuid NOT NULL,
  to_user_id uuid NOT NULL,
  status USER-DEFINED NOT NULL DEFAULT 'pending'::invite_status,
  message text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT connection_requests_pkey PRIMARY KEY (id),
  CONSTRAINT connection_requests_from_user_id_fkey FOREIGN KEY (from_user_id) REFERENCES public.users(id),
  CONSTRAINT connection_requests_to_user_id_fkey FOREIGN KEY (to_user_id) REFERENCES public.users(id)
);
CREATE TABLE public.connections (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  user_id uuid NOT NULL,
  peer_id uuid NOT NULL,
  is_blocked boolean NOT NULL DEFAULT false,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT connections_pkey PRIMARY KEY (id),
  CONSTRAINT connections_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id),
  CONSTRAINT connections_peer_id_fkey FOREIGN KEY (peer_id) REFERENCES public.users(id)
);
CREATE TABLE public.distractions (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  user_id uuid NOT NULL,
  cal_item_id uuid,
  trigger text,
  source text,
  category text,
  mood integer CHECK (mood >= 1 AND mood <= 5),
  intentional boolean NOT NULL DEFAULT false,
  logged_at timestamp with time zone NOT NULL DEFAULT now(),
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT distractions_pkey PRIMARY KEY (id),
  CONSTRAINT distractions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id),
  CONSTRAINT distractions_cal_item_id_fkey FOREIGN KEY (cal_item_id) REFERENCES public.calendar_items(id)
);
CREATE TABLE public.exercise_library (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  user_id uuid,
  name text NOT NULL,
  muscle_group text,
  category text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT exercise_library_pkey PRIMARY KEY (id),
  CONSTRAINT exercise_library_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id)
);
CREATE TABLE public.expense_split_members (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  split_id uuid NOT NULL,
  user_id uuid,
  name text,
  share_amt numeric NOT NULL,
  paid boolean NOT NULL DEFAULT false,
  forgiven boolean NOT NULL DEFAULT false,
  CONSTRAINT expense_split_members_pkey PRIMARY KEY (id),
  CONSTRAINT expense_split_members_split_id_fkey FOREIGN KEY (split_id) REFERENCES public.expense_splits(id),
  CONSTRAINT expense_split_members_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id)
);
CREATE TABLE public.expense_splits (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  user_id uuid NOT NULL,
  transaction_id uuid,
  title text NOT NULL,
  total_amount numeric NOT NULL,
  currency character NOT NULL DEFAULT 'DZD'::bpchar,
  settled boolean NOT NULL DEFAULT false,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  deleted_at timestamp with time zone,
  CONSTRAINT expense_splits_pkey PRIMARY KEY (id),
  CONSTRAINT expense_splits_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id),
  CONSTRAINT expense_splits_transaction_id_fkey FOREIGN KEY (transaction_id) REFERENCES public.transactions(id)
);
CREATE TABLE public.external_calendars (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  user_id uuid NOT NULL,
  provider text NOT NULL DEFAULT 'google'::text,
  external_cal_id text NOT NULL,
  name text,
  access_token text,
  refresh_token text,
  token_expires timestamp with time zone,
  sync_token text,
  last_synced timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT external_calendars_pkey PRIMARY KEY (id),
  CONSTRAINT external_calendars_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id)
);
CREATE TABLE public.feature_flags (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  name text NOT NULL UNIQUE,
  enabled boolean NOT NULL DEFAULT false,
  config jsonb,
  CONSTRAINT feature_flags_pkey PRIMARY KEY (id)
);
CREATE TABLE public.freelance_clients (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  user_id uuid NOT NULL,
  name text NOT NULL,
  email text,
  company text,
  notes text,
  stripe_customer_id text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  deleted_at timestamp with time zone,
  CONSTRAINT freelance_clients_pkey PRIMARY KEY (id),
  CONSTRAINT freelance_clients_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id)
);
CREATE TABLE public.freelance_gigs (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  user_id uuid NOT NULL,
  client_id uuid NOT NULL,
  objective_id uuid,
  title text NOT NULL,
  rate numeric,
  rate_kind text NOT NULL DEFAULT 'hourly'::text,
  status text NOT NULL DEFAULT 'active'::text,
  started_on date,
  ended_on date,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  deleted_at timestamp with time zone,
  CONSTRAINT freelance_gigs_pkey PRIMARY KEY (id),
  CONSTRAINT freelance_gigs_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id),
  CONSTRAINT freelance_gigs_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.freelance_clients(id),
  CONSTRAINT freelance_gigs_objective_id_fkey FOREIGN KEY (objective_id) REFERENCES public.objectives(id)
);
CREATE TABLE public.freelance_time_entries (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  user_id uuid NOT NULL,
  gig_id uuid NOT NULL,
  description text,
  started_at timestamp with time zone NOT NULL,
  ended_at timestamp with time zone,
  duration_min integer,
  billable boolean NOT NULL DEFAULT true,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT freelance_time_entries_pkey PRIMARY KEY (id),
  CONSTRAINT freelance_time_entries_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id),
  CONSTRAINT freelance_time_entries_gig_id_fkey FOREIGN KEY (gig_id) REFERENCES public.freelance_gigs(id)
);
CREATE TABLE public.gym_exercise_logs (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  session_id uuid NOT NULL,
  exercise_id uuid NOT NULL,
  set_num smallint NOT NULL,
  reps smallint,
  weight_kg numeric,
  duration_sec integer,
  rpe smallint CHECK (rpe >= 1 AND rpe <= 10),
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT gym_exercise_logs_pkey PRIMARY KEY (id),
  CONSTRAINT gym_exercise_logs_session_id_fkey FOREIGN KEY (session_id) REFERENCES public.gym_sessions(id),
  CONSTRAINT gym_exercise_logs_exercise_id_fkey FOREIGN KEY (exercise_id) REFERENCES public.exercise_library(id)
);
CREATE TABLE public.gym_sessions (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  user_id uuid NOT NULL,
  routine_id uuid,
  started_at timestamp with time zone NOT NULL,
  ended_at timestamp with time zone,
  note text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT gym_sessions_pkey PRIMARY KEY (id),
  CONSTRAINT gym_sessions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id),
  CONSTRAINT gym_sessions_routine_id_fkey FOREIGN KEY (routine_id) REFERENCES public.workout_routines(id)
);
CREATE TABLE public.habit_challenge_participants (
  challenge_id uuid NOT NULL,
  user_id uuid NOT NULL,
  score integer NOT NULL DEFAULT 0,
  joined_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT habit_challenge_participants_pkey PRIMARY KEY (challenge_id, user_id),
  CONSTRAINT habit_challenge_participants_challenge_id_fkey FOREIGN KEY (challenge_id) REFERENCES public.habit_challenges(id),
  CONSTRAINT habit_challenge_participants_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id)
);
CREATE TABLE public.habit_challenges (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  creator_id uuid NOT NULL,
  habit_id uuid NOT NULL,
  title text NOT NULL,
  starts_on date NOT NULL,
  ends_on date NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  deleted_at timestamp with time zone,
  CONSTRAINT habit_challenges_pkey PRIMARY KEY (id),
  CONSTRAINT habit_challenges_creator_id_fkey FOREIGN KEY (creator_id) REFERENCES public.users(id),
  CONSTRAINT habit_challenges_habit_id_fkey FOREIGN KEY (habit_id) REFERENCES public.habits(id)
);
CREATE TABLE public.habit_logs (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  habit_id uuid NOT NULL,
  user_id uuid NOT NULL,
  logged_date date NOT NULL,
  count integer NOT NULL DEFAULT 1,
  note text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT habit_logs_pkey PRIMARY KEY (id),
  CONSTRAINT habit_logs_habit_id_fkey FOREIGN KEY (habit_id) REFERENCES public.habits(id),
  CONSTRAINT habit_logs_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id)
);
CREATE TABLE public.habit_steps (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  habit_id uuid NOT NULL,
  user_id uuid NOT NULL,
  title text NOT NULL,
  duration_min integer,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT habit_steps_pkey PRIMARY KEY (id),
  CONSTRAINT habit_steps_habit_id_fkey FOREIGN KEY (habit_id) REFERENCES public.habits(id),
  CONSTRAINT habit_steps_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id)
);
CREATE TABLE public.habits (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  user_id uuid NOT NULL,
  role_id uuid,
  title text NOT NULL,
  description text,
  recurrence text NOT NULL DEFAULT 'FREQ=DAILY'::text,
  target_count integer NOT NULL DEFAULT 1,
  is_routine boolean NOT NULL DEFAULT false,
  color text,
  icon text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  deleted_at timestamp with time zone,
  CONSTRAINT habits_pkey PRIMARY KEY (id),
  CONSTRAINT habits_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id),
  CONSTRAINT habits_role_id_fkey FOREIGN KEY (role_id) REFERENCES public.roles(id)
);
CREATE TABLE public.ideas (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  user_id uuid NOT NULL,
  role_id uuid,
  title text NOT NULL,
  description text,
  validation_status text NOT NULL DEFAULT 'raw'::text,
  swot jsonb,
  competitors jsonb,
  ai_suggestions jsonb,
  converted_to_id uuid,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  deleted_at timestamp with time zone,
  CONSTRAINT ideas_pkey PRIMARY KEY (id),
  CONSTRAINT ideas_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id),
  CONSTRAINT ideas_role_id_fkey FOREIGN KEY (role_id) REFERENCES public.roles(id)
);
CREATE TABLE public.invoice_items (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  invoice_id uuid NOT NULL,
  description text NOT NULL,
  quantity numeric NOT NULL DEFAULT 1,
  unit_price numeric NOT NULL,
  sort_order integer NOT NULL DEFAULT 0,
  CONSTRAINT invoice_items_pkey PRIMARY KEY (id),
  CONSTRAINT invoice_items_invoice_id_fkey FOREIGN KEY (invoice_id) REFERENCES public.invoices(id)
);
CREATE TABLE public.invoice_payments (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  invoice_id uuid NOT NULL,
  amount numeric NOT NULL,
  paid_at timestamp with time zone NOT NULL,
  method text,
  stripe_event_id text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT invoice_payments_pkey PRIMARY KEY (id),
  CONSTRAINT invoice_payments_invoice_id_fkey FOREIGN KEY (invoice_id) REFERENCES public.invoices(id)
);
CREATE TABLE public.invoices (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  user_id uuid NOT NULL,
  client_id uuid NOT NULL,
  gig_id uuid,
  number text NOT NULL,
  status text NOT NULL DEFAULT 'draft'::text,
  issued_date date NOT NULL DEFAULT CURRENT_DATE,
  due_date date,
  currency character NOT NULL DEFAULT 'DZD'::bpchar,
  notes text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  deleted_at timestamp with time zone,
  CONSTRAINT invoices_pkey PRIMARY KEY (id),
  CONSTRAINT invoices_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id),
  CONSTRAINT invoices_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.freelance_clients(id),
  CONSTRAINT invoices_gig_id_fkey FOREIGN KEY (gig_id) REFERENCES public.freelance_gigs(id)
);
CREATE TABLE public.item_dependencies (
  item_id uuid NOT NULL,
  depends_on_id uuid NOT NULL,
  CONSTRAINT item_dependencies_pkey PRIMARY KEY (item_id, depends_on_id),
  CONSTRAINT item_dependencies_item_id_fkey FOREIGN KEY (item_id) REFERENCES public.items(id),
  CONSTRAINT item_dependencies_depends_on_id_fkey FOREIGN KEY (depends_on_id) REFERENCES public.items(id)
);
CREATE TABLE public.item_links (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  item_id uuid NOT NULL,
  entity_type text NOT NULL,
  entity_id uuid NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT item_links_pkey PRIMARY KEY (id),
  CONSTRAINT item_links_item_id_fkey FOREIGN KEY (item_id) REFERENCES public.items(id)
);
CREATE TABLE public.item_tags (
  item_id uuid NOT NULL,
  tag_id uuid NOT NULL,
  CONSTRAINT item_tags_pkey PRIMARY KEY (item_id, tag_id),
  CONSTRAINT item_tags_item_id_fkey FOREIGN KEY (item_id) REFERENCES public.items(id),
  CONSTRAINT item_tags_tag_id_fkey FOREIGN KEY (tag_id) REFERENCES public.tags(id)
);
CREATE TABLE public.items (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  user_id uuid NOT NULL,
  role_id uuid,
  objective_id uuid,
  kind USER-DEFINED NOT NULL DEFAULT 'task'::item_kind,
  title text NOT NULL,
  notes text,
  status USER-DEFINED NOT NULL DEFAULT 'todo'::item_status,
  priority USER-DEFINED NOT NULL DEFAULT 'medium'::priority_level,
  priority_score numeric NOT NULL DEFAULT 0,
  energy_required USER-DEFINED,
  due_at timestamp with time zone,
  starts_at timestamp with time zone,
  recurrence text,
  peer_id uuid,
  peer_name text,
  estimated_min integer,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  deleted_at timestamp with time zone,
  CONSTRAINT items_pkey PRIMARY KEY (id),
  CONSTRAINT items_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id),
  CONSTRAINT items_role_id_fkey FOREIGN KEY (role_id) REFERENCES public.roles(id),
  CONSTRAINT items_peer_id_fkey FOREIGN KEY (peer_id) REFERENCES public.users(id),
  CONSTRAINT fk_items_objective FOREIGN KEY (objective_id) REFERENCES public.objectives(id)
);
CREATE TABLE public.learning_entries (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  user_id uuid NOT NULL,
  logged_date date NOT NULL,
  topic text NOT NULL,
  duration_min integer,
  source_url text,
  summary text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT learning_entries_pkey PRIMARY KEY (id),
  CONSTRAINT learning_entries_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id)
);
CREATE TABLE public.location_travel_times (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  user_id uuid NOT NULL,
  from_id uuid NOT NULL,
  to_id uuid NOT NULL,
  drive_min integer,
  walk_min integer,
  bike_min integer,
  transit_min integer,
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT location_travel_times_pkey PRIMARY KEY (id),
  CONSTRAINT location_travel_times_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id),
  CONSTRAINT location_travel_times_from_id_fkey FOREIGN KEY (from_id) REFERENCES public.user_locations(id),
  CONSTRAINT location_travel_times_to_id_fkey FOREIGN KEY (to_id) REFERENCES public.user_locations(id)
);
CREATE TABLE public.meal_logs (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  user_id uuid NOT NULL,
  recipe_id uuid,
  meal_type text NOT NULL,
  logged_at timestamp with time zone NOT NULL DEFAULT now(),
  note text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT meal_logs_pkey PRIMARY KEY (id),
  CONSTRAINT meal_logs_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id),
  CONSTRAINT meal_logs_recipe_id_fkey FOREIGN KEY (recipe_id) REFERENCES public.recipes(id)
);
CREATE TABLE public.meal_plan_members (
  plan_id uuid NOT NULL,
  user_id uuid NOT NULL,
  role text NOT NULL DEFAULT 'viewer'::text,
  joined_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT meal_plan_members_pkey PRIMARY KEY (plan_id, user_id),
  CONSTRAINT meal_plan_members_plan_id_fkey FOREIGN KEY (plan_id) REFERENCES public.meal_plans(id),
  CONSTRAINT meal_plan_members_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id)
);
CREATE TABLE public.meal_plan_slots (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  plan_id uuid NOT NULL,
  day_of_week smallint NOT NULL CHECK (day_of_week >= 0 AND day_of_week <= 6),
  meal_type text NOT NULL,
  recipe_id uuid,
  label text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT meal_plan_slots_pkey PRIMARY KEY (id),
  CONSTRAINT meal_plan_slots_plan_id_fkey FOREIGN KEY (plan_id) REFERENCES public.meal_plans(id),
  CONSTRAINT meal_plan_slots_recipe_id_fkey FOREIGN KEY (recipe_id) REFERENCES public.recipes(id)
);
CREATE TABLE public.meal_plans (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  user_id uuid NOT NULL,
  title text NOT NULL,
  is_active boolean NOT NULL DEFAULT false,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  deleted_at timestamp with time zone,
  CONSTRAINT meal_plans_pkey PRIMARY KEY (id),
  CONSTRAINT meal_plans_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id)
);
CREATE TABLE public.meeting_templates (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  user_id uuid NOT NULL,
  title text NOT NULL,
  agenda text,
  duration_min integer NOT NULL DEFAULT 60,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  deleted_at timestamp with time zone,
  CONSTRAINT meeting_templates_pkey PRIMARY KEY (id),
  CONSTRAINT meeting_templates_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id)
);
CREATE TABLE public.notification_deliveries (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  notification_id uuid NOT NULL,
  channel text NOT NULL,
  status text NOT NULL DEFAULT 'sent'::text,
  sent_at timestamp with time zone NOT NULL DEFAULT now(),
  error text,
  CONSTRAINT notification_deliveries_pkey PRIMARY KEY (id),
  CONSTRAINT notification_deliveries_notification_id_fkey FOREIGN KEY (notification_id) REFERENCES public.notifications(id)
);
CREATE TABLE public.notification_preferences (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  user_id uuid NOT NULL UNIQUE,
  channels jsonb NOT NULL DEFAULT '{}'::jsonb,
  quiet_start time without time zone,
  quiet_end time without time zone,
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT notification_preferences_pkey PRIMARY KEY (id),
  CONSTRAINT notification_preferences_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id)
);
CREATE TABLE public.notifications (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  user_id uuid NOT NULL,
  type text NOT NULL,
  title text NOT NULL,
  body text,
  data jsonb,
  read_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT notifications_pkey PRIMARY KEY (id),
  CONSTRAINT notifications_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id)
);
CREATE TABLE public.objective_members (
  objective_id uuid NOT NULL,
  user_id uuid NOT NULL,
  role text NOT NULL DEFAULT 'member'::text,
  equity_pct numeric CHECK (equity_pct >= 0::numeric AND equity_pct <= 100::numeric),
  joined_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT objective_members_pkey PRIMARY KEY (objective_id, user_id),
  CONSTRAINT objective_members_objective_id_fkey FOREIGN KEY (objective_id) REFERENCES public.objectives(id),
  CONSTRAINT objective_members_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id)
);
CREATE TABLE public.objective_milestones (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  objective_id uuid NOT NULL,
  user_id uuid NOT NULL,
  title text NOT NULL,
  due_date date,
  completed_at timestamp with time zone,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  deleted_at timestamp with time zone,
  CONSTRAINT objective_milestones_pkey PRIMARY KEY (id),
  CONSTRAINT objective_milestones_objective_id_fkey FOREIGN KEY (objective_id) REFERENCES public.objectives(id),
  CONSTRAINT objective_milestones_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id)
);
CREATE TABLE public.objective_reviews (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  objective_id uuid NOT NULL,
  user_id uuid NOT NULL,
  review_date date NOT NULL,
  progress integer CHECK (progress >= 0 AND progress <= 100),
  reflection text,
  next_actions text,
  mood integer CHECK (mood >= 1 AND mood <= 5),
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT objective_reviews_pkey PRIMARY KEY (id),
  CONSTRAINT objective_reviews_objective_id_fkey FOREIGN KEY (objective_id) REFERENCES public.objectives(id),
  CONSTRAINT objective_reviews_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id)
);
CREATE TABLE public.objective_steps (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  objective_id uuid NOT NULL,
  user_id uuid NOT NULL,
  title text NOT NULL,
  description text,
  resource_url text,
  duration_min integer,
  sort_order integer NOT NULL DEFAULT 0,
  completed_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  deleted_at timestamp with time zone,
  CONSTRAINT objective_steps_pkey PRIMARY KEY (id),
  CONSTRAINT objective_steps_objective_id_fkey FOREIGN KEY (objective_id) REFERENCES public.objectives(id),
  CONSTRAINT objective_steps_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id)
);
CREATE TABLE public.objectives (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  user_id uuid NOT NULL,
  role_id uuid,
  kind USER-DEFINED NOT NULL DEFAULT 'goal'::objective_kind,
  title text NOT NULL,
  description text,
  status USER-DEFINED NOT NULL DEFAULT 'todo'::item_status,
  priority USER-DEFINED NOT NULL DEFAULT 'medium'::priority_level,
  cadence USER-DEFINED,
  why text,
  progress integer NOT NULL DEFAULT 0 CHECK (progress >= 0 AND progress <= 100),
  starts_on date,
  target_date date,
  completed_at timestamp with time zone,
  is_public boolean NOT NULL DEFAULT false,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  deleted_at timestamp with time zone,
  CONSTRAINT objectives_pkey PRIMARY KEY (id),
  CONSTRAINT objectives_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id),
  CONSTRAINT objectives_role_id_fkey FOREIGN KEY (role_id) REFERENCES public.roles(id)
);
CREATE TABLE public.org_event_attendance (
  event_id uuid NOT NULL,
  user_id uuid NOT NULL,
  status USER-DEFINED NOT NULL DEFAULT 'pending'::invite_status,
  CONSTRAINT org_event_attendance_pkey PRIMARY KEY (event_id, user_id),
  CONSTRAINT org_event_attendance_event_id_fkey FOREIGN KEY (event_id) REFERENCES public.org_events(id),
  CONSTRAINT org_event_attendance_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id)
);
CREATE TABLE public.org_events (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  org_id uuid NOT NULL,
  title text NOT NULL,
  description text,
  starts_at timestamp with time zone NOT NULL,
  ends_at timestamp with time zone,
  location text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  deleted_at timestamp with time zone,
  CONSTRAINT org_events_pkey PRIMARY KEY (id),
  CONSTRAINT org_events_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id)
);
CREATE TABLE public.org_members (
  org_id uuid NOT NULL,
  user_id uuid NOT NULL,
  role text NOT NULL DEFAULT 'member'::text,
  joined_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT org_members_pkey PRIMARY KEY (org_id, user_id),
  CONSTRAINT org_members_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id),
  CONSTRAINT org_members_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id)
);
CREATE TABLE public.organizations (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  owner_id uuid NOT NULL,
  name text NOT NULL,
  description text,
  avatar_url text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  deleted_at timestamp with time zone,
  CONSTRAINT organizations_pkey PRIMARY KEY (id),
  CONSTRAINT organizations_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES public.users(id)
);
CREATE TABLE public.pantry_items (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  user_id uuid NOT NULL,
  name text NOT NULL,
  quantity text,
  unit text,
  expires_on date,
  in_stock boolean NOT NULL DEFAULT true,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT pantry_items_pkey PRIMARY KEY (id),
  CONSTRAINT pantry_items_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id)
);
CREATE TABLE public.password_reset_tokens (
  user_id uuid NOT NULL,
  code character NOT NULL,
  expires_at timestamp with time zone NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT password_reset_tokens_pkey PRIMARY KEY (user_id),
  CONSTRAINT password_reset_tokens_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id)
);
CREATE TABLE public.personal_records (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  user_id uuid NOT NULL,
  exercise_id uuid NOT NULL,
  value numeric NOT NULL,
  unit text NOT NULL,
  achieved_at date NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT personal_records_pkey PRIMARY KEY (id),
  CONSTRAINT personal_records_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id),
  CONSTRAINT personal_records_exercise_id_fkey FOREIGN KEY (exercise_id) REFERENCES public.exercise_library(id)
);
CREATE TABLE public.pomodoro_sessions (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  user_id uuid NOT NULL,
  item_id uuid,
  study_session_id uuid,
  started_at timestamp with time zone NOT NULL,
  ended_at timestamp with time zone,
  work_min integer NOT NULL DEFAULT 25,
  break_min integer NOT NULL DEFAULT 5,
  completed boolean NOT NULL DEFAULT false,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT pomodoro_sessions_pkey PRIMARY KEY (id),
  CONSTRAINT pomodoro_sessions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id),
  CONSTRAINT pomodoro_sessions_item_id_fkey FOREIGN KEY (item_id) REFERENCES public.items(id),
  CONSTRAINT pomodoro_sessions_study_session_id_fkey FOREIGN KEY (study_session_id) REFERENCES public.study_sessions(id)
);
CREATE TABLE public.prayer_logs (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  user_id uuid NOT NULL,
  prayer USER-DEFINED NOT NULL,
  prayed_at timestamp with time zone NOT NULL,
  prayed_date date NOT NULL,
  on_time boolean NOT NULL DEFAULT true,
  jamaa boolean NOT NULL DEFAULT false,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT prayer_logs_pkey PRIMARY KEY (id),
  CONSTRAINT prayer_logs_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id)
);
CREATE TABLE public.prayer_time_caches (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  lat double precision NOT NULL,
  lng double precision NOT NULL,
  date date NOT NULL,
  fajr time without time zone NOT NULL,
  dhuhr time without time zone NOT NULL,
  asr time without time zone NOT NULL,
  maghrib time without time zone NOT NULL,
  isha time without time zone NOT NULL,
  method smallint NOT NULL DEFAULT 2,
  fetched_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT prayer_time_caches_pkey PRIMARY KEY (id)
);
CREATE TABLE public.push_subscriptions (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  user_id uuid NOT NULL,
  endpoint text NOT NULL UNIQUE,
  p256dh text NOT NULL,
  auth text NOT NULL,
  user_agent text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT push_subscriptions_pkey PRIMARY KEY (id),
  CONSTRAINT push_subscriptions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id)
);
CREATE TABLE public.quran_logs (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  user_id uuid NOT NULL,
  logged_date date NOT NULL,
  juz smallint,
  surah smallint,
  ayah_start smallint,
  ayah_end smallint,
  pages numeric,
  note text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT quran_logs_pkey PRIMARY KEY (id),
  CONSTRAINT quran_logs_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id)
);
CREATE TABLE public.recipe_ingredients (
  recipe_id uuid NOT NULL,
  name text NOT NULL,
  quantity text,
  unit text,
  sort_order integer NOT NULL DEFAULT 0,
  CONSTRAINT recipe_ingredients_recipe_id_fkey FOREIGN KEY (recipe_id) REFERENCES public.recipes(id)
);
CREATE TABLE public.recipes (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  user_id uuid NOT NULL,
  title text NOT NULL,
  description text,
  prep_min integer,
  cook_min integer,
  servings smallint,
  image_url text,
  tags ARRAY,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  deleted_at timestamp with time zone,
  CONSTRAINT recipes_pkey PRIMARY KEY (id),
  CONSTRAINT recipes_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id)
);
CREATE TABLE public.reports (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  user_id uuid NOT NULL,
  title text NOT NULL,
  period_type text NOT NULL,
  period_start date NOT NULL,
  period_end date NOT NULL,
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT reports_pkey PRIMARY KEY (id),
  CONSTRAINT reports_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id)
);
CREATE TABLE public.resource_links (
  resource_id uuid NOT NULL,
  entity_type text NOT NULL,
  entity_id uuid NOT NULL,
  CONSTRAINT resource_links_pkey PRIMARY KEY (resource_id, entity_type, entity_id),
  CONSTRAINT resource_links_resource_id_fkey FOREIGN KEY (resource_id) REFERENCES public.resources(id)
);
CREATE TABLE public.resources (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  user_id uuid NOT NULL,
  url text,
  title text NOT NULL,
  description text,
  tags ARRAY,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  deleted_at timestamp with time zone,
  CONSTRAINT resources_pkey PRIMARY KEY (id),
  CONSTRAINT resources_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id)
);
CREATE TABLE public.roles (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  user_id uuid NOT NULL,
  name text NOT NULL,
  color text NOT NULL DEFAULT '#6366f1'::text,
  icon text,
  weekly_focus_min integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  deleted_at timestamp with time zone,
  CONSTRAINT roles_pkey PRIMARY KEY (id),
  CONSTRAINT roles_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id)
);
CREATE TABLE public.shares (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  owner_id uuid NOT NULL,
  entity_type USER-DEFINED NOT NULL,
  entity_id uuid NOT NULL,
  shared_with_user_id uuid,
  shared_with_team_id uuid,
  permission USER-DEFINED NOT NULL DEFAULT 'view'::permission_kind,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  deleted_at timestamp with time zone,
  CONSTRAINT shares_pkey PRIMARY KEY (id),
  CONSTRAINT shares_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES public.users(id),
  CONSTRAINT shares_shared_with_user_id_fkey FOREIGN KEY (shared_with_user_id) REFERENCES public.users(id),
  CONSTRAINT shares_shared_with_team_id_fkey FOREIGN KEY (shared_with_team_id) REFERENCES public.teams(id)
);
CREATE TABLE public.shopping_list_items (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  user_id uuid NOT NULL,
  plan_id uuid,
  name text NOT NULL,
  quantity text,
  unit text,
  checked boolean NOT NULL DEFAULT false,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT shopping_list_items_pkey PRIMARY KEY (id),
  CONSTRAINT shopping_list_items_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id),
  CONSTRAINT shopping_list_items_plan_id_fkey FOREIGN KEY (plan_id) REFERENCES public.meal_plans(id)
);
CREATE TABLE public.sleep_logs (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  user_id uuid NOT NULL,
  slept_at timestamp with time zone NOT NULL,
  woke_at timestamp with time zone NOT NULL,
  is_nap boolean NOT NULL DEFAULT false,
  quality smallint CHECK (quality >= 1 AND quality <= 5),
  note text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT sleep_logs_pkey PRIMARY KEY (id),
  CONSTRAINT sleep_logs_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id)
);
CREATE TABLE public.sport_logs (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  user_id uuid NOT NULL,
  activity text NOT NULL,
  duration_min integer,
  distance_km numeric,
  logged_at timestamp with time zone NOT NULL DEFAULT now(),
  note text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT sport_logs_pkey PRIMARY KEY (id),
  CONSTRAINT sport_logs_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id)
);
CREATE TABLE public.streaks (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  user_id uuid NOT NULL,
  habit_id uuid,
  area text,
  current integer NOT NULL DEFAULT 0,
  longest integer NOT NULL DEFAULT 0,
  last_logged date,
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT streaks_pkey PRIMARY KEY (id),
  CONSTRAINT streaks_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id),
  CONSTRAINT streaks_habit_id_fkey FOREIGN KEY (habit_id) REFERENCES public.habits(id)
);
CREATE TABLE public.study_sessions (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  user_id uuid NOT NULL,
  objective_id uuid,
  topic text NOT NULL,
  started_at timestamp with time zone NOT NULL,
  ended_at timestamp with time zone,
  note text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT study_sessions_pkey PRIMARY KEY (id),
  CONSTRAINT study_sessions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id),
  CONSTRAINT study_sessions_objective_id_fkey FOREIGN KEY (objective_id) REFERENCES public.objectives(id)
);
CREATE TABLE public.tags (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  user_id uuid NOT NULL,
  name text NOT NULL,
  color text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT tags_pkey PRIMARY KEY (id),
  CONSTRAINT tags_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id)
);
CREATE TABLE public.team_members (
  team_id uuid NOT NULL,
  user_id uuid NOT NULL,
  role text NOT NULL DEFAULT 'member'::text,
  joined_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT team_members_pkey PRIMARY KEY (team_id, user_id),
  CONSTRAINT team_members_team_id_fkey FOREIGN KEY (team_id) REFERENCES public.teams(id),
  CONSTRAINT team_members_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id)
);
CREATE TABLE public.teams (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  owner_id uuid NOT NULL,
  name text NOT NULL,
  description text,
  avatar_url text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  deleted_at timestamp with time zone,
  CONSTRAINT teams_pkey PRIMARY KEY (id),
  CONSTRAINT teams_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES public.users(id)
);
CREATE TABLE public.telegram_link_tokens (
  token uuid NOT NULL DEFAULT uuid_generate_v4(),
  user_id uuid NOT NULL,
  chat_id text NOT NULL UNIQUE,
  expires_at timestamp with time zone NOT NULL DEFAULT (now() + '00:10:00'::interval),
  CONSTRAINT telegram_link_tokens_pkey PRIMARY KEY (token),
  CONSTRAINT telegram_link_tokens_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id)
);
CREATE TABLE public.transaction_friends (
  transaction_id uuid NOT NULL,
  peer_id uuid,
  peer_name text,
  direction text NOT NULL,
  CONSTRAINT transaction_friends_pkey PRIMARY KEY (transaction_id),
  CONSTRAINT transaction_friends_transaction_id_fkey FOREIGN KEY (transaction_id) REFERENCES public.transactions(id),
  CONSTRAINT transaction_friends_peer_id_fkey FOREIGN KEY (peer_id) REFERENCES public.users(id)
);
CREATE TABLE public.transactions (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  user_id uuid NOT NULL,
  account_id uuid,
  category_id uuid,
  role_id uuid,
  objective_id uuid,
  kind USER-DEFINED NOT NULL DEFAULT 'expense'::tx_kind,
  amount numeric NOT NULL,
  currency character NOT NULL DEFAULT 'DZD'::bpchar,
  description text,
  txn_date date NOT NULL DEFAULT CURRENT_DATE,
  transfer_pair_id uuid,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  deleted_at timestamp with time zone,
  CONSTRAINT transactions_pkey PRIMARY KEY (id),
  CONSTRAINT transactions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id),
  CONSTRAINT transactions_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id),
  CONSTRAINT transactions_category_id_fkey FOREIGN KEY (category_id) REFERENCES public.categories(id),
  CONSTRAINT transactions_role_id_fkey FOREIGN KEY (role_id) REFERENCES public.roles(id),
  CONSTRAINT transactions_objective_id_fkey FOREIGN KEY (objective_id) REFERENCES public.objectives(id),
  CONSTRAINT transactions_transfer_pair_id_fkey FOREIGN KEY (transfer_pair_id) REFERENCES public.transactions(id)
);
CREATE TABLE public.university_timetables (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  user_id uuid NOT NULL UNIQUE,
  url text NOT NULL,
  parser_config jsonb,
  last_synced timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT university_timetables_pkey PRIMARY KEY (id),
  CONSTRAINT university_timetables_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id)
);
CREATE TABLE public.user_locations (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  user_id uuid NOT NULL,
  label text NOT NULL,
  address text,
  lat double precision,
  lng double precision,
  is_default boolean NOT NULL DEFAULT false,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  deleted_at timestamp with time zone,
  CONSTRAINT user_locations_pkey PRIMARY KEY (id),
  CONSTRAINT user_locations_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id)
);
CREATE TABLE public.user_sessions (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  user_id uuid NOT NULL,
  user_agent text,
  ip text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  last_seen timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT user_sessions_pkey PRIMARY KEY (id),
  CONSTRAINT user_sessions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id)
);
CREATE TABLE public.users (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  email text NOT NULL UNIQUE,
  name text NOT NULL,
  password_hash text NOT NULL,
  avatar_url text,
  preferences jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  deleted_at timestamp with time zone,
  telegram_chat_id text,
  CONSTRAINT users_pkey PRIMARY KEY (id)
);
CREATE TABLE public.venture_budgets (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  objective_id uuid NOT NULL,
  user_id uuid NOT NULL,
  category text NOT NULL,
  amount_cap numeric NOT NULL,
  spent numeric NOT NULL DEFAULT 0,
  currency character NOT NULL DEFAULT 'DZD'::bpchar,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT venture_budgets_pkey PRIMARY KEY (id),
  CONSTRAINT venture_budgets_objective_id_fkey FOREIGN KEY (objective_id) REFERENCES public.objectives(id),
  CONSTRAINT venture_budgets_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id)
);
CREATE TABLE public.weekly_template_blocks (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  user_id uuid NOT NULL,
  role_id uuid,
  day_of_week smallint NOT NULL CHECK (day_of_week >= 0 AND day_of_week <= 6),
  start_time time without time zone NOT NULL,
  end_time time without time zone NOT NULL,
  title text NOT NULL,
  kind USER-DEFINED NOT NULL DEFAULT 'block'::cal_kind,
  is_recurring boolean NOT NULL DEFAULT true,
  energy_required USER-DEFINED,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  deleted_at timestamp with time zone,
  CONSTRAINT weekly_template_blocks_pkey PRIMARY KEY (id),
  CONSTRAINT weekly_template_blocks_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id),
  CONSTRAINT weekly_template_blocks_role_id_fkey FOREIGN KEY (role_id) REFERENCES public.roles(id)
);
CREATE TABLE public.workout_routine_exercises (
  routine_id uuid NOT NULL,
  exercise_id uuid NOT NULL,
  sets smallint,
  reps smallint,
  duration_sec integer,
  sort_order integer NOT NULL DEFAULT 0,
  CONSTRAINT workout_routine_exercises_pkey PRIMARY KEY (routine_id, exercise_id),
  CONSTRAINT workout_routine_exercises_routine_id_fkey FOREIGN KEY (routine_id) REFERENCES public.workout_routines(id),
  CONSTRAINT workout_routine_exercises_exercise_id_fkey FOREIGN KEY (exercise_id) REFERENCES public.exercise_library(id)
);
CREATE TABLE public.workout_routines (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  user_id uuid NOT NULL,
  name text NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  deleted_at timestamp with time zone,
  CONSTRAINT workout_routines_pkey PRIMARY KEY (id),
  CONSTRAINT workout_routines_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id)
);