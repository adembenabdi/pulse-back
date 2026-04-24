/**
 * Freelance routes — Phase 8
 *
 * Clients      GET/POST /clients, GET/PATCH/DELETE /clients/:id
 * Gigs         GET/POST /gigs, GET/PATCH/DELETE /gigs/:id
 * Time entries GET /time-entries?gig_id=, POST /time-entries,
 *              PATCH /time-entries/:id (stop + close),
 *              DELETE /time-entries/:id
 * Invoices     GET/POST /invoices, GET/PATCH/DELETE /invoices/:id
 *              POST /invoices/:id/items, PATCH/DELETE /invoices/:id/items/:itemId
 *              POST /invoices/:id/payments
 *              POST /invoices/from-gig/:gigId  (auto-generate from time entries)
 */

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { AppError } from '../middleware/error.js';

export const freelanceRouter: Router = Router();
freelanceRouter.use(requireAuth);

// ════════════════════════════════════════════════════════════════════════════
// CLIENTS
// ════════════════════════════════════════════════════════════════════════════
const ClientBody = z.object({
  name:    z.string().min(1).max(200),
  email:   z.string().email().optional(),
  company: z.string().optional(),
  notes:   z.string().optional(),
});

freelanceRouter.get('/clients', async (req: Request, res: Response) => {
  const { rows } = await req.db!.query<Record<string, unknown>>(
    `SELECT fc.*,
       COUNT(DISTINCT fg.id)::int AS gig_count
     FROM freelance_clients fc
     LEFT JOIN freelance_gigs fg ON fg.client_id = fc.id AND fg.deleted_at IS NULL
     GROUP BY fc.id
     ORDER BY fc.created_at DESC`,
    [],
  );
  res.json(rows);
});

freelanceRouter.post('/clients', async (req: Request, res: Response) => {
  const b = ClientBody.parse(req.body);
  const { rows } = await req.db!.query<Record<string, unknown>>(
    `INSERT INTO freelance_clients (user_id, name, email, company, notes)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [req.user!.id, b.name, b.email ?? null, b.company ?? null, b.notes ?? null],
  );
  res.status(201).json(rows[0]);
});

freelanceRouter.get('/clients/:id', async (req: Request, res: Response) => {
  const { rows } = await req.db!.query<Record<string, unknown>>(
    `SELECT * FROM freelance_clients WHERE id=$1`, [req.params['id']],
  );
  if (!rows[0]) throw new AppError(404, 'Client not found');
  res.json(rows[0]);
});

freelanceRouter.patch('/clients/:id', async (req: Request, res: Response) => {
  const b = ClientBody.partial().parse(req.body);
  const sets: string[] = []; const vals: unknown[] = []; let n = 1;
  if (b.name    !== undefined) { sets.push(`name=$${n++}`);    vals.push(b.name); }
  if (b.email   !== undefined) { sets.push(`email=$${n++}`);   vals.push(b.email); }
  if (b.company !== undefined) { sets.push(`company=$${n++}`); vals.push(b.company); }
  if (b.notes   !== undefined) { sets.push(`notes=$${n++}`);   vals.push(b.notes); }
  if (sets.length === 0) throw new AppError(400, 'Nothing to update');
  vals.push(req.params['id']);
  const { rows } = await req.db!.query<Record<string, unknown>>(
    `UPDATE freelance_clients SET ${sets.join(',')} WHERE id=$${n} RETURNING *`, vals,
  );
  if (!rows[0]) throw new AppError(404, 'Client not found');
  res.json(rows[0]);
});

freelanceRouter.delete('/clients/:id', async (req: Request, res: Response) => {
  await req.db!.query(`UPDATE freelance_clients SET deleted_at=NOW() WHERE id=$1`, [req.params['id']]);
  res.json({ ok: true });
});

// ════════════════════════════════════════════════════════════════════════════
// GIGS
// ════════════════════════════════════════════════════════════════════════════
const GigBody = z.object({
  client_id:    z.string().uuid(),
  objective_id: z.string().uuid().optional(),
  title:        z.string().min(1).max(300),
  rate:         z.number().nonnegative().optional(),
  rate_kind:    z.enum(['hourly', 'fixed']).optional(),
  status:       z.enum(['active', 'completed', 'cancelled']).optional(),
  started_on:   z.string().optional(),
  ended_on:     z.string().optional(),
});

freelanceRouter.get('/gigs', async (req: Request, res: Response) => {
  const { client_id, status } = req.query as Record<string, string | undefined>;
  const { rows } = await req.db!.query<Record<string, unknown>>(
    `SELECT g.*,
       fc.name AS client_name,
       COALESCE(SUM(te.duration_min), 0)::int AS total_minutes,
       COUNT(DISTINCT te.id)::int              AS entry_count
     FROM freelance_gigs g
     JOIN freelance_clients fc ON fc.id = g.client_id
     LEFT JOIN freelance_time_entries te ON te.gig_id = g.id AND te.billable
     WHERE ($1::uuid IS NULL OR g.client_id = $1::uuid)
       AND ($2::text IS NULL OR g.status = $2)
     GROUP BY g.id, fc.name
     ORDER BY g.created_at DESC`,
    [client_id ?? null, status ?? null],
  );
  res.json(rows);
});

freelanceRouter.post('/gigs', async (req: Request, res: Response) => {
  const b = GigBody.parse(req.body);
  const { rows } = await req.db!.query<Record<string, unknown>>(
    `INSERT INTO freelance_gigs
       (user_id, client_id, objective_id, title, rate, rate_kind, status, started_on, ended_on)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [req.user!.id, b.client_id, b.objective_id ?? null, b.title,
     b.rate ?? null, b.rate_kind ?? 'hourly', b.status ?? 'active',
     b.started_on ?? null, b.ended_on ?? null],
  );
  res.status(201).json(rows[0]);
});

freelanceRouter.get('/gigs/:id', async (req: Request, res: Response) => {
  const { rows } = await req.db!.query<Record<string, unknown>>(
    `SELECT g.*, fc.name AS client_name FROM freelance_gigs g
     JOIN freelance_clients fc ON fc.id = g.client_id
     WHERE g.id=$1`,
    [req.params['id']],
  );
  if (!rows[0]) throw new AppError(404, 'Gig not found');
  res.json(rows[0]);
});

freelanceRouter.patch('/gigs/:id', async (req: Request, res: Response) => {
  const b = GigBody.omit({ client_id: true }).partial().parse(req.body);
  const sets: string[] = []; const vals: unknown[] = []; let n = 1;
  if (b.objective_id !== undefined) { sets.push(`objective_id=$${n++}`); vals.push(b.objective_id); }
  if (b.title        !== undefined) { sets.push(`title=$${n++}`);        vals.push(b.title); }
  if (b.rate         !== undefined) { sets.push(`rate=$${n++}`);         vals.push(b.rate); }
  if (b.rate_kind    !== undefined) { sets.push(`rate_kind=$${n++}`);    vals.push(b.rate_kind); }
  if (b.status       !== undefined) { sets.push(`status=$${n++}`);       vals.push(b.status); }
  if (b.started_on   !== undefined) { sets.push(`started_on=$${n++}`);   vals.push(b.started_on); }
  if (b.ended_on     !== undefined) { sets.push(`ended_on=$${n++}`);     vals.push(b.ended_on); }
  if (sets.length === 0) throw new AppError(400, 'Nothing to update');
  vals.push(req.params['id']);
  const { rows } = await req.db!.query<Record<string, unknown>>(
    `UPDATE freelance_gigs SET ${sets.join(',')} WHERE id=$${n} RETURNING *`, vals,
  );
  if (!rows[0]) throw new AppError(404, 'Gig not found');
  res.json(rows[0]);
});

freelanceRouter.delete('/gigs/:id', async (req: Request, res: Response) => {
  await req.db!.query(`UPDATE freelance_gigs SET deleted_at=NOW() WHERE id=$1`, [req.params['id']]);
  res.json({ ok: true });
});

// ════════════════════════════════════════════════════════════════════════════
// TIME ENTRIES
// ════════════════════════════════════════════════════════════════════════════
const TimeEntryBody = z.object({
  gig_id:      z.string().uuid(),
  description: z.string().optional(),
  started_at:  z.string().datetime().optional(),
  ended_at:    z.string().datetime().optional(),
  billable:    z.boolean().optional(),
});

freelanceRouter.get('/time-entries', async (req: Request, res: Response) => {
  const { gig_id, from, to } = req.query as Record<string, string | undefined>;
  const { rows } = await req.db!.query<Record<string, unknown>>(
    `SELECT te.*,
       EXTRACT(EPOCH FROM (COALESCE(te.ended_at, NOW()) - te.started_at)) / 60 AS computed_min
     FROM freelance_time_entries te
     WHERE ($1::uuid IS NULL OR te.gig_id = $1::uuid)
       AND ($2::date IS NULL OR te.started_at::date >= $2::date)
       AND ($3::date IS NULL OR te.started_at::date <= $3::date)
     ORDER BY te.started_at DESC
     LIMIT 200`,
    [gig_id ?? null, from ?? null, to ?? null],
  );
  res.json(rows);
});

// POST — start a new time entry (or log a completed one)
freelanceRouter.post('/time-entries', async (req: Request, res: Response) => {
  const b = TimeEntryBody.parse(req.body);
  const startedAt = b.started_at ?? new Date().toISOString();
  const durMin = b.ended_at
    ? Math.round((new Date(b.ended_at).getTime() - new Date(startedAt).getTime()) / 60000)
    : null;
  const { rows } = await req.db!.query<Record<string, unknown>>(
    `INSERT INTO freelance_time_entries
       (user_id, gig_id, description, started_at, ended_at, duration_min, billable)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [req.user!.id, b.gig_id, b.description ?? null,
     startedAt, b.ended_at ?? null, durMin, b.billable ?? true],
  );
  res.status(201).json(rows[0]);
});

// PATCH — stop (set ended_at) or edit
freelanceRouter.patch('/time-entries/:id', async (req: Request, res: Response) => {
  const b = TimeEntryBody.omit({ gig_id: true }).partial().parse(req.body);
  const sets: string[] = []; const vals: unknown[] = []; let n = 1;
  if (b.description !== undefined) { sets.push(`description=$${n++}`); vals.push(b.description); }
  if (b.started_at  !== undefined) { sets.push(`started_at=$${n++}`);  vals.push(b.started_at); }
  if (b.billable    !== undefined) { sets.push(`billable=$${n++}`);     vals.push(b.billable); }
  if (b.ended_at !== undefined) {
    sets.push(`ended_at=$${n++}`); vals.push(b.ended_at);
    // recompute duration_min
    sets.push(`duration_min=EXTRACT(EPOCH FROM ($${n}::timestamptz - started_at)) / 60`);
    vals.push(b.ended_at); n++;
  }
  if (sets.length === 0) throw new AppError(400, 'Nothing to update');
  vals.push(req.params['id']);
  const { rows } = await req.db!.query<Record<string, unknown>>(
    `UPDATE freelance_time_entries SET ${sets.join(',')} WHERE id=$${n} RETURNING *`, vals,
  );
  if (!rows[0]) throw new AppError(404, 'Time entry not found');
  res.json(rows[0]);
});

freelanceRouter.delete('/time-entries/:id', async (req: Request, res: Response) => {
  await req.db!.query(`DELETE FROM freelance_time_entries WHERE id=$1`, [req.params['id']]);
  res.json({ ok: true });
});

// ════════════════════════════════════════════════════════════════════════════
// INVOICES
// ════════════════════════════════════════════════════════════════════════════
const InvoiceBody = z.object({
  client_id:   z.string().uuid(),
  gig_id:      z.string().uuid().optional(),
  number:      z.string().min(1).max(50),
  issued_date: z.string().optional(),
  due_date:    z.string().optional(),
  currency:    z.string().length(3).optional(),
  notes:       z.string().optional(),
  status:      z.enum(['draft', 'sent', 'paid', 'void']).optional(),
});

const InvoiceItemBody = z.object({
  description: z.string().min(1),
  quantity:    z.number().positive().optional(),
  unit_price:  z.number().nonnegative(),
  sort_order:  z.number().int().optional(),
});

freelanceRouter.get('/invoices', async (req: Request, res: Response) => {
  const { client_id, status } = req.query as Record<string, string | undefined>;
  const { rows } = await req.db!.query<Record<string, unknown>>(
    `SELECT inv.*,
       fc.name AS client_name,
       COALESCE(SUM(ii.quantity * ii.unit_price), 0)::numeric AS total_amount,
       COUNT(ii.id)::int AS line_count
     FROM invoices inv
     JOIN freelance_clients fc ON fc.id = inv.client_id
     LEFT JOIN invoice_items ii ON ii.invoice_id = inv.id
     WHERE ($1::uuid IS NULL OR inv.client_id = $1::uuid)
       AND ($2::text IS NULL OR inv.status = $2)
       AND inv.deleted_at IS NULL
     GROUP BY inv.id, fc.name
     ORDER BY inv.issued_date DESC`,
    [client_id ?? null, status ?? null],
  );
  res.json(rows);
});

freelanceRouter.post('/invoices', async (req: Request, res: Response) => {
  const b = InvoiceBody.parse(req.body);
  const { rows } = await req.db!.query<Record<string, unknown>>(
    `INSERT INTO invoices
       (user_id, client_id, gig_id, number, status, issued_date, due_date, currency, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [req.user!.id, b.client_id, b.gig_id ?? null, b.number,
     b.status ?? 'draft',
     b.issued_date ?? new Date().toISOString().slice(0, 10),
     b.due_date ?? null, b.currency ?? 'DZD', b.notes ?? null],
  );
  res.status(201).json(rows[0]);
});

// Auto-generate invoice from a gig's unbilled time entries
freelanceRouter.post('/invoices/from-gig/:gigId', async (req: Request, res: Response) => {
  const { gigId } = req.params;
  const { rows: gigRows } = await req.db!.query<Record<string, unknown>>(
    `SELECT g.*, fc.name AS client_name
     FROM freelance_gigs g JOIN freelance_clients fc ON fc.id = g.client_id
     WHERE g.id=$1`,
    [gigId],
  );
  const gig = gigRows[0];
  if (!gig) throw new AppError(404, 'Gig not found');

  const { rows: entries } = await req.db!.query<Record<string, unknown>>(
    `SELECT * FROM freelance_time_entries
     WHERE gig_id=$1 AND billable=TRUE AND ended_at IS NOT NULL`,
    [gigId],
  );
  if (!entries.length) throw new AppError(400, 'No billable time entries for this gig');

  const num = `INV-${Date.now().toString(36).toUpperCase()}`;
  const { rows: invRows } = await req.db!.query<Record<string, unknown>>(
    `INSERT INTO invoices (user_id, client_id, gig_id, number, status, currency)
     VALUES ($1,$2,$3,$4,'draft','DZD') RETURNING *`,
    [req.user!.id, (gig as Record<string, unknown>)['client_id'], gigId, num],
  );
  const inv = invRows[0]!;
  const invId = (inv as Record<string, unknown>)['id'];
  const rate = Number((gig as Record<string, unknown>)['rate'] ?? 0);

  let order = 0;
  for (const e of entries) {
    const hrs = Number((e as Record<string, unknown>)['duration_min'] ?? 0) / 60;
    const desc = String((e as Record<string, unknown>)['description'] ?? 'Work');
    await req.db!.query(
      `INSERT INTO invoice_items (invoice_id, description, quantity, unit_price, sort_order)
       VALUES ($1,$2,$3,$4,$5)`,
      [invId, desc, Math.round(hrs * 100) / 100, rate, order++],
    );
  }
  res.status(201).json(inv);
});

freelanceRouter.get('/invoices/:id', async (req: Request, res: Response) => {
  const { rows } = await req.db!.query<Record<string, unknown>>(
    `SELECT inv.*, fc.name AS client_name FROM invoices inv
     JOIN freelance_clients fc ON fc.id = inv.client_id
     WHERE inv.id=$1 AND inv.deleted_at IS NULL`,
    [req.params['id']],
  );
  if (!rows[0]) throw new AppError(404, 'Invoice not found');
  const { rows: items } = await req.db!.query<Record<string, unknown>>(
    `SELECT * FROM invoice_items WHERE invoice_id=$1 ORDER BY sort_order`, [req.params['id']],
  );
  const { rows: payments } = await req.db!.query<Record<string, unknown>>(
    `SELECT * FROM invoice_payments WHERE invoice_id=$1 ORDER BY paid_at`, [req.params['id']],
  );
  res.json({ ...rows[0], items, payments });
});

freelanceRouter.patch('/invoices/:id', async (req: Request, res: Response) => {
  const b = InvoiceBody.omit({ client_id: true }).partial().parse(req.body);
  const sets: string[] = []; const vals: unknown[] = []; let n = 1;
  if (b.gig_id      !== undefined) { sets.push(`gig_id=$${n++}`);      vals.push(b.gig_id); }
  if (b.number      !== undefined) { sets.push(`number=$${n++}`);      vals.push(b.number); }
  if (b.status      !== undefined) { sets.push(`status=$${n++}`);      vals.push(b.status); }
  if (b.issued_date !== undefined) { sets.push(`issued_date=$${n++}`); vals.push(b.issued_date); }
  if (b.due_date    !== undefined) { sets.push(`due_date=$${n++}`);    vals.push(b.due_date); }
  if (b.currency    !== undefined) { sets.push(`currency=$${n++}`);    vals.push(b.currency); }
  if (b.notes       !== undefined) { sets.push(`notes=$${n++}`);       vals.push(b.notes); }
  if (sets.length === 0) throw new AppError(400, 'Nothing to update');
  vals.push(req.params['id']);
  const { rows } = await req.db!.query<Record<string, unknown>>(
    `UPDATE invoices SET ${sets.join(',')} WHERE id=$${n} RETURNING *`, vals,
  );
  if (!rows[0]) throw new AppError(404, 'Invoice not found');
  res.json(rows[0]);
});

freelanceRouter.delete('/invoices/:id', async (req: Request, res: Response) => {
  await req.db!.query(`UPDATE invoices SET deleted_at=NOW() WHERE id=$1`, [req.params['id']]);
  res.json({ ok: true });
});

// POST /invoices/:id/send  — mark draft as sent (no actual delivery yet)
freelanceRouter.post('/invoices/:id/send', async (req: Request, res: Response) => {
  const { rows } = await req.db!.query<Record<string, unknown>>(
    `UPDATE invoices
     SET status = 'sent', updated_at = NOW()
     WHERE id = $1 AND deleted_at IS NULL
     RETURNING *`,
    [req.params['id']],
  );
  if (!rows[0]) throw new AppError(404, 'Invoice not found');
  res.json(rows[0]);
});

// POST /invoices/:id/items
freelanceRouter.post('/invoices/:id/items', async (req: Request, res: Response) => {
  const b = InvoiceItemBody.parse(req.body);
  const { rows } = await req.db!.query<Record<string, unknown>>(
    `INSERT INTO invoice_items (invoice_id, description, quantity, unit_price, sort_order)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [req.params['id'], b.description, b.quantity ?? 1, b.unit_price, b.sort_order ?? 0],
  );
  res.status(201).json(rows[0]);
});

// PATCH /invoices/:id/items/:itemId
freelanceRouter.patch('/invoices/:id/items/:itemId', async (req: Request, res: Response) => {
  const b = InvoiceItemBody.partial().parse(req.body);
  const sets: string[] = []; const vals: unknown[] = []; let n = 1;
  if (b.description !== undefined) { sets.push(`description=$${n++}`); vals.push(b.description); }
  if (b.quantity    !== undefined) { sets.push(`quantity=$${n++}`);    vals.push(b.quantity); }
  if (b.unit_price  !== undefined) { sets.push(`unit_price=$${n++}`);  vals.push(b.unit_price); }
  if (b.sort_order  !== undefined) { sets.push(`sort_order=$${n++}`);  vals.push(b.sort_order); }
  if (sets.length === 0) throw new AppError(400, 'Nothing to update');
  vals.push(req.params['itemId']); vals.push(req.params['id']);
  const { rows } = await req.db!.query<Record<string, unknown>>(
    `UPDATE invoice_items SET ${sets.join(',')} WHERE id=$${n} AND invoice_id=$${n + 1} RETURNING *`, vals,
  );
  if (!rows[0]) throw new AppError(404, 'Invoice item not found');
  res.json(rows[0]);
});

// DELETE /invoices/:id/items/:itemId
freelanceRouter.delete('/invoices/:id/items/:itemId', async (req: Request, res: Response) => {
  await req.db!.query(
    `DELETE FROM invoice_items WHERE id=$1 AND invoice_id=$2`,
    [req.params['itemId'], req.params['id']],
  );
  res.json({ ok: true });
});

// POST /invoices/:id/payments  — record a manual payment
freelanceRouter.post('/invoices/:id/payments', async (req: Request, res: Response) => {
  const body = z.object({
    amount:  z.number().positive(),
    paid_at: z.string().datetime().optional(),
    method:  z.string().optional(),
  }).parse(req.body);
  const { rows } = await req.db!.query<Record<string, unknown>>(
    `INSERT INTO invoice_payments (invoice_id, amount, paid_at, method)
     VALUES ($1,$2,$3,$4) RETURNING *`,
    [req.params['id'], body.amount,
     body.paid_at ?? new Date().toISOString(), body.method ?? null],
  );
  // Auto-mark invoice paid if fully covered
  await req.db!.query(
    `UPDATE invoices SET status='paid'
     WHERE id=$1 AND (SELECT COALESCE(SUM(amount),0) FROM invoice_payments WHERE invoice_id=$1) >=
       (SELECT COALESCE(SUM(quantity*unit_price),0) FROM invoice_items WHERE invoice_id=$1)`,
    [req.params['id']],
  );
  res.status(201).json(rows[0]);
});
