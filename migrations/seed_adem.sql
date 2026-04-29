-- ───────────────────────────────────────────────────────────────────────────
-- Seed: Adem's life inventory → Pulse
-- User: 54c86a98-3680-42c2-aa7e-fe8b107d112a (adem.benabdi.b@gmail.com)
-- Date context: 2026-04-28
--
-- Idempotency: the script first DELETES anything previously seeded by this
-- script (matched by metadata->>'seed' = 'adem_v1'), then re-inserts.
-- Existing ideas (LED fishing light, hydrogen generator) are kept and just
-- updated (role_id + linked to objectives).
-- Run inside Supabase SQL editor as a single statement.
-- ───────────────────────────────────────────────────────────────────────────

BEGIN;

-- ── Clean previous run of this seed ────────────────────────────────────────
DELETE FROM public.entity_links
 WHERE user_id = '54c86a98-3680-42c2-aa7e-fe8b107d112a'
   AND metadata->>'seed' = 'adem_v1';

DELETE FROM public.items
 WHERE user_id = '54c86a98-3680-42c2-aa7e-fe8b107d112a'
   AND notes LIKE '%[seed:adem_v1]%';

DELETE FROM public.habits
 WHERE user_id = '54c86a98-3680-42c2-aa7e-fe8b107d112a'
   AND description LIKE '%[seed:adem_v1]%';

DELETE FROM public.objectives
 WHERE user_id = '54c86a98-3680-42c2-aa7e-fe8b107d112a'
   AND description LIKE '%[seed:adem_v1]%';

DELETE FROM public.roles
 WHERE user_id = '54c86a98-3680-42c2-aa7e-fe8b107d112a'
   AND icon LIKE 'seed:%';   -- our marker on seeded roles

-- ── Main seed ──────────────────────────────────────────────────────────────
DO $$
DECLARE
  uid uuid := '54c86a98-3680-42c2-aa7e-fe8b107d112a';

  -- roles
  r_student  uuid;
  r_voltix   uuid;
  r_octobit  uuid;
  r_builder  uuid;
  r_personal uuid;
  r_pulse    uuid;

  -- objectives
  o_pfe        uuid;
  o_voltix     uuid;
  o_domino     uuid;
  o_timetable  uuid;
  o_pulse      uuid;
  o_octoplat   uuid;
  o_drone      uuid;
  o_rfid       uuid;
  o_cloud      uuid;
  o_khedra     uuid;
  o_hypertower uuid;

  -- existing ideas (already in DB)
  i_fishing  uuid := '9b4792f1-3d42-428d-98bf-98d56692ca7b';
  i_hydrogen uuid := 'f26849ac-3bbe-4683-9ebd-db3f52b30f29';

  -- task ids (collect a few we want to cross-link)
  t_pfe_review uuid; t_pfe_format uuid; t_pfe_diagrams uuid; t_pfe_submit uuid;
  t_voltix_landing uuid; t_voltix_pricing uuid; t_voltix_first_client uuid;
  t_domino_polish uuid; t_pulse_dogfood uuid; t_khedra_pitch uuid;
  t_octobit_handover uuid;

BEGIN

-- ── 1. Roles ───────────────────────────────────────────────────────────────
INSERT INTO public.roles (user_id, name, color, icon, weekly_focus_min, sort_order)
VALUES (uid, 'Student',  '#6366f1', 'seed:graduation-cap', 25*60, 1)
RETURNING id INTO r_student;

INSERT INTO public.roles (user_id, name, color, icon, weekly_focus_min, sort_order)
VALUES (uid, 'Voltix',   '#f59e0b', 'seed:briefcase',      15*60, 2)
RETURNING id INTO r_voltix;

INSERT INTO public.roles (user_id, name, color, icon, weekly_focus_min, sort_order)
VALUES (uid, 'OctoBit',  '#f43f5e', 'seed:users',           8*60, 3)
RETURNING id INTO r_octobit;

INSERT INTO public.roles (user_id, name, color, icon, weekly_focus_min, sort_order)
VALUES (uid, 'Builder',  '#10b981', 'seed:cpu',            12*60, 4)
RETURNING id INTO r_builder;

INSERT INTO public.roles (user_id, name, color, icon, weekly_focus_min, sort_order)
VALUES (uid, 'Pulse',    '#8b5cf6', 'seed:activity',       10*60, 5)
RETURNING id INTO r_pulse;

INSERT INTO public.roles (user_id, name, color, icon, weekly_focus_min, sort_order)
VALUES (uid, 'Personal', '#0ea5e9', 'seed:heart',          10*60, 6)
RETURNING id INTO r_personal;

-- ── 2. Objectives (projects + ventures + PFE learning goal) ────────────────

-- PFE — must be done by 6 May 2026 (code done, mémoire written)
INSERT INTO public.objectives
  (user_id, role_id, kind,            title,
   description, status,         priority, progress, starts_on,    target_date)
VALUES
  (uid, r_student, 'learning_goal', 'PFE — Final Year Project',
   E'Final year project (L3 ISIL). Code is functional and the mémoire is written. Remaining work: final review, LaTeX/Overleaf formatting polish, sequence + system diagrams, and submission of the code + mémoire by the deadline.\n\n[seed:adem_v1]',
   'in_progress', 'urgent', 80, '2026-01-15', '2026-05-06')
RETURNING id INTO o_pfe;

-- Voltix venture (multi-service agency)
INSERT INTO public.objectives
  (user_id, role_id, kind,     title,
   description, status,         priority, progress, starts_on)
VALUES
  (uid, r_voltix, 'venture', 'Voltix — multi-service agency',
   E'Founded with a friend. Income-generation venture. Services offered:\n• Web development\n• Software systems\n• Network installation\n• Electrical work (basic)\n• Technical maintenance\n• Cleaning (optional)\n\nShort-term goal: land first paying clients and generate steady income.\n\n[seed:adem_v1]',
   'in_progress', 'high', 10, '2026-04-01')
RETURNING id INTO o_voltix;

-- Software projects
INSERT INTO public.objectives (user_id, role_id, kind, title, description, status, priority, progress)
VALUES (uid, r_builder, 'project', 'Domino Web App',
        E'Multiplayer Domino game. Functional and portfolio-ready. Polish + showcase.\n\n[seed:adem_v1]',
        'in_progress', 'medium', 75)
RETURNING id INTO o_domino;

INSERT INTO public.objectives (user_id, role_id, kind, title, description, status, priority, progress)
VALUES (uid, r_student, 'project', 'University Timetable Platform',
        E'Schedule + absence tracking + classroom-like features + campus map + mobile version. Aimed at students/faculty.\n\n[seed:adem_v1]',
        'in_progress', 'medium', 25)
RETURNING id INTO o_timetable;

INSERT INTO public.objectives (user_id, role_id, kind, title, description, status, priority, progress)
VALUES (uid, r_pulse, 'project', 'Pulse — Personal Life OS',
        E'Tasks + calendar + habits + AI assistant + knowledge + entity graph. Own daily-driver product.\n\n[seed:adem_v1]',
        'in_progress', 'high', 60)
RETURNING id INTO o_pulse;

INSERT INTO public.objectives (user_id, role_id, kind, title, description, status, priority, progress)
VALUES (uid, r_octobit, 'project', 'OctoBit Platform',
        E'Club management system: activity organization, internal coordination, CTF infra, web platform.\n\n[seed:adem_v1]',
        'in_progress', 'medium', 40)
RETURNING id INTO o_octoplat;

-- Hardware / embedded
INSERT INTO public.objectives (user_id, role_id, kind, title, description, status, priority, progress)
VALUES (uid, r_builder, 'project', 'ESP32 Micro Drone',
        E'Experimental micro drone build. ESP32 flight controller + camera integration + 3D-printed frame.\n\n[seed:adem_v1]',
        'in_progress', 'low', 20)
RETURNING id INTO o_drone;

INSERT INTO public.objectives (user_id, role_id, kind, title, description, status, priority, progress)
VALUES (uid, r_octobit, 'project', 'RFID Presence System',
        E'ESP32 + RFID + relay attendance system for OctoBit / classroom use.\n\n[seed:adem_v1]',
        'in_progress', 'medium', 30)
RETURNING id INTO o_rfid;

INSERT INTO public.objectives (user_id, role_id, kind, title, description, status, priority, progress)
VALUES (uid, r_builder, 'project', 'Local Cloud Setup',
        E'Self-hosted infrastructure (storage, services, internal tools). Foundation for other projects.\n\n[seed:adem_v1]',
        'in_progress', 'low', 15)
RETURNING id INTO o_cloud;

-- Innovation ventures
INSERT INTO public.objectives (user_id, role_id, kind, title, description, status, priority, progress)
VALUES (uid, r_voltix, 'venture', 'Khedra — Agri-Tech',
        E'Drone imagery + AI recommendations for irrigation & fertilizer optimization. Mobile + web apps for farmers.\n\n[seed:adem_v1]',
        'todo', 'medium', 5)
RETURNING id INTO o_khedra;

INSERT INTO public.objectives (user_id, role_id, kind, title, description, status, priority, progress)
VALUES (uid, r_builder, 'venture', 'HyperTower — Vertical Farming',
        E'Vertical farming system with 3D-printed structure. Compact urban-grow concept.\n\n[seed:adem_v1]',
        'todo', 'low', 5)
RETURNING id INTO o_hypertower;

-- ── 3. Existing ideas — assign roles + link to objectives ──────────────────
UPDATE public.ideas SET role_id = r_voltix  WHERE id = i_fishing  AND user_id = uid;
UPDATE public.ideas SET role_id = r_builder WHERE id = i_hydrogen AND user_id = uid;

-- ── 4. Tasks (concrete near-term work) ─────────────────────────────────────

-- PFE (urgent — 8 days out)
INSERT INTO public.items (user_id, role_id, objective_id, kind, title, notes, status, priority, due_at, estimated_min)
VALUES (uid, r_student, o_pfe, 'task', 'Final review of mémoire (proofread + English check)',
        '[seed:adem_v1]', 'todo', 'urgent', '2026-05-02 18:00+01', 240)
RETURNING id INTO t_pfe_review;

INSERT INTO public.items (user_id, role_id, objective_id, kind, title, notes, status, priority, due_at, estimated_min)
VALUES (uid, r_student, o_pfe, 'task', 'Polish LaTeX / Overleaf formatting',
        '[seed:adem_v1]', 'todo', 'high', '2026-05-03 18:00+01', 120)
RETURNING id INTO t_pfe_format;

INSERT INTO public.items (user_id, role_id, objective_id, kind, title, notes, status, priority, due_at, estimated_min)
VALUES (uid, r_student, o_pfe, 'task', 'Finalize sequence diagrams + system model',
        '[seed:adem_v1]', 'todo', 'high', '2026-05-03 18:00+01', 180)
RETURNING id INTO t_pfe_diagrams;

INSERT INTO public.items (user_id, role_id, objective_id, kind, title, notes, status, priority, due_at, estimated_min)
VALUES (uid, r_student, o_pfe, 'task', 'Submit code + mémoire (PFE deadline)',
        '[seed:adem_v1]', 'todo', 'urgent', '2026-05-06 23:59+01', 60)
RETURNING id INTO t_pfe_submit;

-- Other coursework (Student)
INSERT INTO public.items (user_id, role_id, kind, title, notes, status, priority, estimated_min)
VALUES (uid, r_student, 'task', 'Revise XQuery / XML', '[seed:adem_v1]', 'todo', 'medium', 90),
       (uid, r_student, 'task', 'Revise cryptography & security', '[seed:adem_v1]', 'todo', 'medium', 90),
       (uid, r_student, 'task', 'Revise networking (réseaux)', '[seed:adem_v1]', 'todo', 'medium', 90),
       (uid, r_student, 'task', 'Collect resources (PDFs, examples) for revision', '[seed:adem_v1]', 'todo', 'low', 45);

-- Voltix
INSERT INTO public.items (user_id, role_id, objective_id, kind, title, notes, status, priority, estimated_min)
VALUES (uid, r_voltix, o_voltix, 'task', 'Build Voltix landing page (services + contact)',
        '[seed:adem_v1]', 'todo', 'high', 240)
RETURNING id INTO t_voltix_landing;

INSERT INTO public.items (user_id, role_id, objective_id, kind, title, notes, status, priority, estimated_min)
VALUES (uid, r_voltix, o_voltix, 'task', 'Define service packages + pricing grid',
        '[seed:adem_v1]', 'todo', 'high', 120)
RETURNING id INTO t_voltix_pricing;

INSERT INTO public.items (user_id, role_id, objective_id, kind, title, notes, status, priority, estimated_min)
VALUES (uid, r_voltix, o_voltix, 'task', 'Reach out for first paying client (network outreach)',
        '[seed:adem_v1]', 'todo', 'high', 90)
RETURNING id INTO t_voltix_first_client;

INSERT INTO public.items (user_id, role_id, objective_id, kind, title, notes, status, priority, estimated_min)
VALUES (uid, r_voltix, o_voltix, 'task', 'Register Voltix legally / pick structure',
        '[seed:adem_v1]', 'todo', 'medium', 120),
       (uid, r_voltix, o_voltix, 'task', 'Build a small portfolio of past work',
        '[seed:adem_v1]', 'todo', 'medium', 120);

-- Domino
INSERT INTO public.items (user_id, role_id, objective_id, kind, title, notes, status, priority, estimated_min)
VALUES (uid, r_builder, o_domino, 'task', 'Polish UI + deploy Domino as portfolio piece',
        '[seed:adem_v1]', 'todo', 'medium', 180)
RETURNING id INTO t_domino_polish;

-- Pulse
INSERT INTO public.items (user_id, role_id, objective_id, kind, title, notes, status, priority, estimated_min)
VALUES (uid, r_pulse, o_pulse, 'task', 'Daily dogfood: log everything in Pulse for 2 weeks',
        '[seed:adem_v1]', 'todo', 'high', 30)
RETURNING id INTO t_pulse_dogfood;

INSERT INTO public.items (user_id, role_id, objective_id, kind, title, notes, status, priority, estimated_min)
VALUES (uid, r_pulse, o_pulse, 'task', 'Iterate on graph view based on real usage',
        '[seed:adem_v1]', 'todo', 'medium', 240),
       (uid, r_pulse, o_pulse, 'task', 'Wire AI link suggestions into onboarding',
        '[seed:adem_v1]', 'todo', 'medium', 180);

-- OctoBit
INSERT INTO public.items (user_id, role_id, objective_id, kind, title, notes, status, priority, estimated_min)
VALUES (uid, r_octobit, o_octoplat, 'task', 'Document handover plan (presidency transition)',
        '[seed:adem_v1]', 'todo', 'high', 120)
RETURNING id INTO t_octobit_handover;

INSERT INTO public.items (user_id, role_id, objective_id, kind, title, notes, status, priority, estimated_min)
VALUES (uid, r_octobit, o_octoplat, 'task', 'Ship CTF platform v1', '[seed:adem_v1]', 'todo', 'medium', 480),
       (uid, r_octobit, o_rfid,     'task', 'Test RFID presence prototype end-to-end', '[seed:adem_v1]', 'todo', 'medium', 240);

-- OctoBit events as objectives (no calendar dates per your choice)
INSERT INTO public.objectives (user_id, role_id, kind, title, description, status, priority)
VALUES (uid, r_octobit, 'project', 'Event: Escape Room',  E'OctoBit event. Plan, prep, run.\n\n[seed:adem_v1]', 'todo', 'medium'),
       (uid, r_octobit, 'project', 'Event: Octo Day',      E'OctoBit signature day.\n\n[seed:adem_v1]',         'todo', 'medium'),
       (uid, r_octobit, 'project', 'Event: Octobre Rose',  E'Awareness campaign.\n\n[seed:adem_v1]',            'todo', 'medium'),
       (uid, r_octobit, 'project', 'Event: Novembre Bleu', E'Awareness campaign.\n\n[seed:adem_v1]',            'todo', 'medium');

-- Khedra pitch task
INSERT INTO public.items (user_id, role_id, objective_id, kind, title, notes, status, priority, estimated_min)
VALUES (uid, r_voltix, o_khedra, 'task', 'Draft Khedra one-pager (problem, solution, market)',
        '[seed:adem_v1]', 'todo', 'medium', 120)
RETURNING id INTO t_khedra_pitch;

-- Hardware notes
INSERT INTO public.items (user_id, role_id, objective_id, kind, title, notes, status, priority, estimated_min)
VALUES (uid, r_builder, o_drone,      'task', 'Order remaining drone components',  '[seed:adem_v1]', 'todo', 'low',    60),
       (uid, r_builder, o_cloud,      'task', 'Set up local cloud base OS + storage', '[seed:adem_v1]', 'todo', 'low', 180),
       (uid, r_builder, o_hypertower, 'task', 'Sketch HyperTower v0 design',       '[seed:adem_v1]', 'todo', 'low',   120);

-- Personal admin
INSERT INTO public.items (user_id, role_id, kind, title, notes, status, priority, estimated_min)
VALUES (uid, r_personal, 'task', 'Weekly review (every Sunday)', '[seed:adem_v1]', 'todo', 'medium', 30);

-- ── 5. Habits ──────────────────────────────────────────────────────────────
INSERT INTO public.habits (user_id, role_id, title, description, recurrence, target_count, color, icon)
VALUES
  (uid, r_student,  'Daily study block (90 min)',
   E'Focused revision: PFE, XQuery, crypto, networking. Rotate topic.\n\n[seed:adem_v1]',
   'FREQ=DAILY', 1, '#6366f1', 'book-open'),

  (uid, r_pulse,    'Log the day in Pulse',
   E'Capture tasks/ideas/events daily to dogfood the system.\n\n[seed:adem_v1]',
   'FREQ=DAILY', 1, '#8b5cf6', 'activity'),

  (uid, r_personal, 'Sleep log',
   E'Log bedtime + wake + quality each morning.\n\n[seed:adem_v1]',
   'FREQ=DAILY', 1, '#0ea5e9', 'moon'),

  (uid, r_personal, 'Gym session',
   E'Strength session, 3x per week.\n\n[seed:adem_v1]',
   'FREQ=WEEKLY;BYDAY=MO,WE,FR', 1, '#0ea5e9', 'dumbbell'),

  (uid, r_personal, 'Weekly review',
   E'Sunday evening: review past week, plan next.\n\n[seed:adem_v1]',
   'FREQ=WEEKLY;BYDAY=SU', 1, '#0ea5e9', 'calendar-check');

-- ── 6. Entity links (relationships across the graph) ───────────────────────

-- Ideas linked to ventures/projects they belong to
INSERT INTO public.entity_links
  (user_id, source_type, source_id, target_type, target_id, relation, metadata, created_by)
VALUES
  -- LED fishing light is a Voltix venture-track idea
  (uid, 'idea', i_fishing,  'objective', o_voltix, 'contributes_to',
   '{"seed":"adem_v1","note":"productizable energy-efficient hardware service"}'::jsonb, 'user'),

  -- Hydrogen generator idea relates to Voltix as a technical service area
  (uid, 'idea', i_hydrogen, 'objective', o_voltix, 'related_to',
   '{"seed":"adem_v1","note":"R&D direction, electrical+energy services"}'::jsonb, 'user'),

  -- Both energy ideas relate to each other
  (uid, 'idea', i_fishing,  'idea', i_hydrogen, 'related_to',
   '{"seed":"adem_v1","theme":"energy optimization"}'::jsonb, 'user'),

  -- Pulse uses Khedra/Voltix as future ecosystem? simple cross-links
  (uid, 'objective', o_khedra,     'objective', o_voltix, 'contributes_to',
   '{"seed":"adem_v1","note":"Khedra is a Voltix-incubated venture"}'::jsonb, 'user'),
  (uid, 'objective', o_hypertower, 'objective', o_voltix, 'related_to',
   '{"seed":"adem_v1"}'::jsonb, 'user'),

  -- RFID system used by OctoBit platform
  (uid, 'objective', o_rfid, 'objective', o_octoplat, 'uses',
   '{"seed":"adem_v1","note":"presence subsystem"}'::jsonb, 'user'),

  -- PFE blocks everything else short-term
  (uid, 'objective', o_pfe, 'objective', o_voltix,    'blocks', '{"seed":"adem_v1","reason":"capacity until 6 May"}'::jsonb, 'user'),
  (uid, 'objective', o_pfe, 'objective', o_pulse,     'blocks', '{"seed":"adem_v1"}'::jsonb, 'user'),
  (uid, 'objective', o_pfe, 'objective', o_octoplat,  'blocks', '{"seed":"adem_v1"}'::jsonb, 'user'),

  -- PFE submission task depends on review/format/diagrams
  (uid, 'item', t_pfe_submit, 'item', t_pfe_review,   'depends_on', '{"seed":"adem_v1"}'::jsonb, 'user'),
  (uid, 'item', t_pfe_submit, 'item', t_pfe_format,   'depends_on', '{"seed":"adem_v1"}'::jsonb, 'user'),
  (uid, 'item', t_pfe_submit, 'item', t_pfe_diagrams, 'depends_on', '{"seed":"adem_v1"}'::jsonb, 'user'),

  -- Voltix outreach depends on landing + pricing
  (uid, 'item', t_voltix_first_client, 'item', t_voltix_landing, 'depends_on', '{"seed":"adem_v1"}'::jsonb, 'user'),
  (uid, 'item', t_voltix_first_client, 'item', t_voltix_pricing, 'depends_on', '{"seed":"adem_v1"}'::jsonb, 'user'),

  -- Domino feeds Voltix portfolio
  (uid, 'item', t_domino_polish, 'objective', o_voltix, 'contributes_to',
   '{"seed":"adem_v1","note":"portfolio piece for Voltix outreach"}'::jsonb, 'user'),

  -- Pulse dogfooding feeds Pulse project
  (uid, 'item', t_pulse_dogfood, 'objective', o_pulse, 'contributes_to', '{"seed":"adem_v1"}'::jsonb, 'user'),

  -- Khedra pitch contributes to Khedra
  (uid, 'item', t_khedra_pitch, 'objective', o_khedra, 'contributes_to', '{"seed":"adem_v1"}'::jsonb, 'user'),

  -- OctoBit handover contributes to OctoBit platform
  (uid, 'item', t_octobit_handover, 'objective', o_octoplat, 'contributes_to', '{"seed":"adem_v1"}'::jsonb, 'user');

END $$;

COMMIT;

-- ── Verify ─────────────────────────────────────────────────────────────────
SELECT 'roles'        AS table, COUNT(*) FROM public.roles        WHERE user_id = '54c86a98-3680-42c2-aa7e-fe8b107d112a' AND deleted_at IS NULL
UNION ALL SELECT 'objectives',     COUNT(*) FROM public.objectives    WHERE user_id = '54c86a98-3680-42c2-aa7e-fe8b107d112a' AND deleted_at IS NULL
UNION ALL SELECT 'items',          COUNT(*) FROM public.items         WHERE user_id = '54c86a98-3680-42c2-aa7e-fe8b107d112a' AND deleted_at IS NULL
UNION ALL SELECT 'habits',         COUNT(*) FROM public.habits        WHERE user_id = '54c86a98-3680-42c2-aa7e-fe8b107d112a' AND deleted_at IS NULL
UNION ALL SELECT 'ideas',          COUNT(*) FROM public.ideas         WHERE user_id = '54c86a98-3680-42c2-aa7e-fe8b107d112a' AND deleted_at IS NULL
UNION ALL SELECT 'entity_links',   COUNT(*) FROM public.entity_links  WHERE user_id = '54c86a98-3680-42c2-aa7e-fe8b107d112a';
