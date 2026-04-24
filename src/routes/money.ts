/**
 * Money routes — Phase 8
 *
 * Accounts      GET/POST /accounts, GET/PATCH/DELETE /accounts/:id
 * Categories    GET/POST /categories, PATCH/DELETE /categories/:id
 * Transactions  GET/POST /transactions, GET/PATCH/DELETE /transactions/:id
 *               POST /transactions/transfer
 *               GET /transactions/stats  (period summary)
 * Budgets       GET/POST /budgets, PATCH/DELETE /budgets/:id
 *               GET /budgets/vs-actual   (spent vs cap per category)
 * Splits        GET/POST /splits, GET/PATCH/DELETE /splits/:id
 *               POST /splits/:id/members  PUT (upsert)
 *               PATCH /splits/:id/settle
 * Venture budgets GET/POST /venture-budgets, PATCH/DELETE /venture-budgets/:id
 * Portfolio     GET /portfolio
 */

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { AppError } from '../middleware/error.js';

export const moneyRouter: Router = Router();
moneyRouter.use(requireAuth);

// ════════════════════════════════════════════════════════════════════════════
// ACCOUNTS
// ════════════════════════════════════════════════════════════════════════════
const AccountBody = z.object({
  name:       z.string().min(1).max(200),
  kind:       z.enum(['cash', 'bank', 'card', 'savings']).optional(),
  currency:   z.string().length(3).optional(),
  balance:    z.number().optional(),
  is_default: z.boolean().optional(),
});

moneyRouter.get('/accounts', async (req: Request, res: Response) => {
  const { rows } = await req.db!.query<Record<string, unknown>>(
    `SELECT * FROM accounts ORDER BY is_default DESC, created_at ASC`,
    [],
  );
  res.json(rows);
});

moneyRouter.post('/accounts', async (req: Request, res: Response) => {
  const b = AccountBody.parse(req.body);
  const { rows } = await req.db!.query<Record<string, unknown>>(
    `INSERT INTO accounts (user_id, name, kind, currency, balance, is_default)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [req.user!.id, b.name, b.kind ?? 'bank', b.currency ?? 'DZD',
     b.balance ?? 0, b.is_default ?? false],
  );
  res.status(201).json(rows[0]);
});

moneyRouter.get('/accounts/:id', async (req: Request, res: Response) => {
  const { rows } = await req.db!.query<Record<string, unknown>>(
    `SELECT * FROM accounts WHERE id=$1`, [req.params['id']],
  );
  if (!rows[0]) throw new AppError(404, 'Account not found');
  res.json(rows[0]);
});

moneyRouter.patch('/accounts/:id', async (req: Request, res: Response) => {
  const b = AccountBody.partial().parse(req.body);
  const sets: string[] = []; const vals: unknown[] = []; let n = 1;
  if (b.name       !== undefined) { sets.push(`name=$${n++}`);       vals.push(b.name); }
  if (b.kind       !== undefined) { sets.push(`kind=$${n++}`);       vals.push(b.kind); }
  if (b.currency   !== undefined) { sets.push(`currency=$${n++}`);   vals.push(b.currency); }
  if (b.balance    !== undefined) { sets.push(`balance=$${n++}`);    vals.push(b.balance); }
  if (b.is_default !== undefined) { sets.push(`is_default=$${n++}`); vals.push(b.is_default); }
  if (sets.length === 0) throw new AppError(400, 'Nothing to update');
  vals.push(req.params['id']);
  const { rows } = await req.db!.query<Record<string, unknown>>(
    `UPDATE accounts SET ${sets.join(',')} WHERE id=$${n} RETURNING *`, vals,
  );
  if (!rows[0]) throw new AppError(404, 'Account not found');
  res.json(rows[0]);
});

moneyRouter.delete('/accounts/:id', async (req: Request, res: Response) => {
  await req.db!.query(`UPDATE accounts SET deleted_at=NOW() WHERE id=$1`, [req.params['id']]);
  res.json({ ok: true });
});

// ════════════════════════════════════════════════════════════════════════════
// CATEGORIES
// ════════════════════════════════════════════════════════════════════════════
const CategoryBody = z.object({
  name:  z.string().min(1).max(100),
  kind:  z.enum(['income', 'expense', 'transfer']).optional(),
  icon:  z.string().optional(),
  color: z.string().optional(),
});

moneyRouter.get('/categories', async (req: Request, res: Response) => {
  const { rows } = await req.db!.query<Record<string, unknown>>(
    `SELECT * FROM categories WHERE user_id=$1 OR user_id IS NULL
     ORDER BY kind, name`,
    [req.user!.id],
  );
  res.json(rows);
});

moneyRouter.post('/categories', async (req: Request, res: Response) => {
  const b = CategoryBody.parse(req.body);
  const { rows } = await req.db!.query<Record<string, unknown>>(
    `INSERT INTO categories (user_id, name, kind, icon, color)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [req.user!.id, b.name, b.kind ?? 'expense', b.icon ?? null, b.color ?? null],
  );
  res.status(201).json(rows[0]);
});

moneyRouter.patch('/categories/:id', async (req: Request, res: Response) => {
  const b = CategoryBody.partial().parse(req.body);
  const sets: string[] = []; const vals: unknown[] = []; let n = 1;
  if (b.name  !== undefined) { sets.push(`name=$${n++}`);  vals.push(b.name); }
  if (b.kind  !== undefined) { sets.push(`kind=$${n++}`);  vals.push(b.kind); }
  if (b.icon  !== undefined) { sets.push(`icon=$${n++}`);  vals.push(b.icon); }
  if (b.color !== undefined) { sets.push(`color=$${n++}`); vals.push(b.color); }
  if (sets.length === 0) throw new AppError(400, 'Nothing to update');
  vals.push(req.params['id']);
  const { rows } = await req.db!.query<Record<string, unknown>>(
    `UPDATE categories SET ${sets.join(',')} WHERE id=$${n} AND user_id=$${n + 1} RETURNING *`,
    [...vals, req.user!.id],
  );
  if (!rows[0]) throw new AppError(404, 'Category not found');
  res.json(rows[0]);
});

moneyRouter.delete('/categories/:id', async (req: Request, res: Response) => {
  await req.db!.query(
    `DELETE FROM categories WHERE id=$1 AND user_id=$2`, [req.params['id'], req.user!.id],
  );
  res.json({ ok: true });
});

// ════════════════════════════════════════════════════════════════════════════
// TRANSACTIONS
// ════════════════════════════════════════════════════════════════════════════
const TxBody = z.object({
  account_id:    z.string().uuid().optional(),
  category_id:   z.string().uuid().optional(),
  role_id:       z.string().uuid().optional(),
  objective_id:  z.string().uuid().optional(),
  kind:          z.enum(['income', 'expense', 'transfer']).optional(),
  amount:        z.number().positive(),
  currency:      z.string().length(3).optional(),
  description:   z.string().optional(),
  txn_date:      z.string().optional(),
  // optional linked peer
  peer_id:       z.string().uuid().optional(),
  peer_name:     z.string().optional(),
  peer_direction: z.enum(['owe', 'owed']).optional(),
});

// GET /api/money/transactions  ?from=&to=&kind=&account_id=&category_id=&page=&limit=
moneyRouter.get('/transactions', async (req: Request, res: Response) => {
  const q = req.query as Record<string, string | undefined>;
  const lim    = Math.min(Number(q['limit']) || 50, 200);
  const offset = (Math.max(Number(q['page']) || 1, 1) - 1) * lim;
  const { rows } = await req.db!.query<Record<string, unknown>>(
    `SELECT t.*,
       c.name AS category_name, c.icon AS category_icon, c.color AS category_color,
       a.name AS account_name,
       tf.peer_id, tf.peer_name, tf.direction AS peer_direction
     FROM transactions t
     LEFT JOIN categories c ON c.id = t.category_id
     LEFT JOIN accounts   a ON a.id = t.account_id
     LEFT JOIN transaction_friends tf ON tf.transaction_id = t.id
     WHERE ($1::date IS NULL OR t.txn_date >= $1::date)
       AND ($2::date IS NULL OR t.txn_date <= $2::date)
       AND ($3::text IS NULL OR t.kind = $3)
       AND ($4::uuid IS NULL OR t.account_id = $4::uuid)
       AND ($5::uuid IS NULL OR t.category_id = $5::uuid)
     ORDER BY t.txn_date DESC, t.created_at DESC
     LIMIT $6 OFFSET $7`,
    [q['from'] ?? null, q['to'] ?? null, q['kind'] ?? null,
     q['account_id'] ?? null, q['category_id'] ?? null, lim, offset],
  );
  res.json(rows);
});

// GET /api/money/transactions/stats  ?from=&to=
moneyRouter.get('/transactions/stats', async (req: Request, res: Response) => {
  const { from, to } = req.query as Record<string, string | undefined>;
  const { rows } = await req.db!.query<Record<string, unknown>>(
    `SELECT
       kind,
       COUNT(*)::int           AS count,
       SUM(amount)::numeric    AS total,
       AVG(amount)::numeric    AS avg
     FROM transactions
     WHERE ($1::date IS NULL OR txn_date >= $1::date)
       AND ($2::date IS NULL OR txn_date <= $2::date)
     GROUP BY kind`,
    [from ?? null, to ?? null],
  );
  res.json(rows);
});

// POST /api/money/transactions
moneyRouter.post('/transactions', async (req: Request, res: Response) => {
  const b = TxBody.parse(req.body);
  const { rows } = await req.db!.query<Record<string, unknown>>(
    `INSERT INTO transactions
       (user_id, account_id, category_id, role_id, objective_id,
        kind, amount, currency, description, txn_date)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [req.user!.id, b.account_id ?? null, b.category_id ?? null,
     b.role_id ?? null, b.objective_id ?? null,
     b.kind ?? 'expense', b.amount, b.currency ?? 'DZD',
     b.description ?? null, b.txn_date ?? new Date().toISOString().slice(0, 10)],
  );
  const tx = rows[0]!;
  // Attach peer link if provided
  if (b.peer_id ?? b.peer_name) {
    await req.db!.query(
      `INSERT INTO transaction_friends (transaction_id, peer_id, peer_name, direction)
       VALUES ($1,$2,$3,$4) ON CONFLICT (transaction_id) DO NOTHING`,
      [(tx as Record<string, unknown>)['id'], b.peer_id ?? null,
       b.peer_name ?? null, b.peer_direction ?? 'owe'],
    );
  }
  res.status(201).json(tx);
});

// POST /api/money/transactions/transfer  — paired income+expense
moneyRouter.post('/transactions/transfer', async (req: Request, res: Response) => {
  const body = z.object({
    from_account_id: z.string().uuid(),
    to_account_id:   z.string().uuid(),
    amount:          z.number().positive(),
    currency:        z.string().length(3).optional(),
    description:     z.string().optional(),
    txn_date:        z.string().optional(),
  }).parse(req.body);

  const date = body.txn_date ?? new Date().toISOString().slice(0, 10);
  // Insert expense leg first
  const { rows: r1 } = await req.db!.query<Record<string, unknown>>(
    `INSERT INTO transactions (user_id, account_id, kind, amount, currency, description, txn_date)
     VALUES ($1,$2,'transfer',$3,$4,$5,$6) RETURNING *`,
    [req.user!.id, body.from_account_id, body.amount,
     body.currency ?? 'DZD', body.description ?? null, date],
  );
  const leg1 = r1[0]!;
  // Insert income leg, link back
  const { rows: r2 } = await req.db!.query<Record<string, unknown>>(
    `INSERT INTO transactions (user_id, account_id, kind, amount, currency, description, txn_date, transfer_pair_id)
     VALUES ($1,$2,'transfer',$3,$4,$5,$6,$7) RETURNING *`,
    [req.user!.id, body.to_account_id, body.amount,
     body.currency ?? 'DZD', body.description ?? null, date,
     (leg1 as Record<string, unknown>)['id']],
  );
  const leg2 = r2[0]!;
  // Back-link leg1 → leg2
  await req.db!.query(
    `UPDATE transactions SET transfer_pair_id=$1 WHERE id=$2`,
    [(leg2 as Record<string, unknown>)['id'], (leg1 as Record<string, unknown>)['id']],
  );
  res.status(201).json({ from: leg1, to: leg2 });
});

moneyRouter.get('/transactions/:id', async (req: Request, res: Response) => {
  const { rows } = await req.db!.query<Record<string, unknown>>(
    `SELECT t.*, tf.peer_id, tf.peer_name, tf.direction AS peer_direction
     FROM transactions t
     LEFT JOIN transaction_friends tf ON tf.transaction_id = t.id
     WHERE t.id=$1`,
    [req.params['id']],
  );
  if (!rows[0]) throw new AppError(404, 'Transaction not found');
  res.json(rows[0]);
});

moneyRouter.patch('/transactions/:id', async (req: Request, res: Response) => {
  const b = TxBody.omit({ peer_id: true, peer_name: true, peer_direction: true }).partial().parse(req.body);
  const sets: string[] = []; const vals: unknown[] = []; let n = 1;
  if (b.account_id   !== undefined) { sets.push(`account_id=$${n++}`);   vals.push(b.account_id); }
  if (b.category_id  !== undefined) { sets.push(`category_id=$${n++}`);  vals.push(b.category_id); }
  if (b.role_id      !== undefined) { sets.push(`role_id=$${n++}`);      vals.push(b.role_id); }
  if (b.objective_id !== undefined) { sets.push(`objective_id=$${n++}`); vals.push(b.objective_id); }
  if (b.kind         !== undefined) { sets.push(`kind=$${n++}`);         vals.push(b.kind); }
  if (b.amount       !== undefined) { sets.push(`amount=$${n++}`);       vals.push(b.amount); }
  if (b.currency     !== undefined) { sets.push(`currency=$${n++}`);     vals.push(b.currency); }
  if (b.description  !== undefined) { sets.push(`description=$${n++}`);  vals.push(b.description); }
  if (b.txn_date     !== undefined) { sets.push(`txn_date=$${n++}`);     vals.push(b.txn_date); }
  if (sets.length === 0) throw new AppError(400, 'Nothing to update');
  vals.push(req.params['id']);
  const { rows } = await req.db!.query<Record<string, unknown>>(
    `UPDATE transactions SET ${sets.join(',')} WHERE id=$${n} RETURNING *`, vals,
  );
  if (!rows[0]) throw new AppError(404, 'Transaction not found');
  res.json(rows[0]);
});

moneyRouter.delete('/transactions/:id', async (req: Request, res: Response) => {
  await req.db!.query(`UPDATE transactions SET deleted_at=NOW() WHERE id=$1`, [req.params['id']]);
  res.json({ ok: true });
});

// ════════════════════════════════════════════════════════════════════════════
// BUDGETS
// ════════════════════════════════════════════════════════════════════════════
const BudgetBody = z.object({
  role_id:     z.string().uuid().optional(),
  category_id: z.string().uuid().optional(),
  period_type: z.enum(['weekly', 'monthly', 'yearly']).optional(),
  amount_cap:  z.number().positive(),
  currency:    z.string().length(3).optional(),
});

moneyRouter.get('/budgets', async (req: Request, res: Response) => {
  const { rows } = await req.db!.query<Record<string, unknown>>(
    `SELECT b.*, c.name AS category_name, c.icon AS category_icon
     FROM budgets b
     LEFT JOIN categories c ON c.id = b.category_id
     ORDER BY b.period_type, c.name`,
    [],
  );
  res.json(rows);
});

// GET /api/money/budgets/vs-actual  ?period_type=monthly&month=2026-04
moneyRouter.get('/budgets/vs-actual', async (req: Request, res: Response) => {
  const { period_type = 'monthly', month } = req.query as Record<string, string | undefined>;
  // Default: current month
  const now   = new Date();
  const start = month ? `${month}-01` : `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
  const end   = month
    ? new Date(new Date(`${month}-01`).setMonth(new Date(`${month}-01`).getMonth() + 1)).toISOString().slice(0, 10)
    : new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString().slice(0, 10);

  const { rows } = await req.db!.query<Record<string, unknown>>(
    `SELECT
       b.id, b.amount_cap, b.currency, b.period_type,
       c.id AS category_id, c.name AS category_name, c.icon AS category_icon,
       COALESCE(SUM(t.amount), 0)::numeric AS spent
     FROM budgets b
     LEFT JOIN categories c ON c.id = b.category_id
     LEFT JOIN transactions t
       ON t.category_id = b.category_id
      AND t.txn_date BETWEEN $1::date AND $2::date
      AND t.kind = 'expense'
      AND t.deleted_at IS NULL
     WHERE b.period_type = $3
     GROUP BY b.id, c.id`,
    [start, end, period_type],
  );
  res.json(rows);
});

moneyRouter.post('/budgets', async (req: Request, res: Response) => {
  const b = BudgetBody.parse(req.body);
  const { rows } = await req.db!.query<Record<string, unknown>>(
    `INSERT INTO budgets (user_id, role_id, category_id, period_type, amount_cap, currency)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [req.user!.id, b.role_id ?? null, b.category_id ?? null,
     b.period_type ?? 'monthly', b.amount_cap, b.currency ?? 'DZD'],
  );
  res.status(201).json(rows[0]);
});

moneyRouter.patch('/budgets/:id', async (req: Request, res: Response) => {
  const b = BudgetBody.partial().parse(req.body);
  const sets: string[] = []; const vals: unknown[] = []; let n = 1;
  if (b.role_id     !== undefined) { sets.push(`role_id=$${n++}`);     vals.push(b.role_id); }
  if (b.category_id !== undefined) { sets.push(`category_id=$${n++}`); vals.push(b.category_id); }
  if (b.period_type !== undefined) { sets.push(`period_type=$${n++}`); vals.push(b.period_type); }
  if (b.amount_cap  !== undefined) { sets.push(`amount_cap=$${n++}`);  vals.push(b.amount_cap); }
  if (b.currency    !== undefined) { sets.push(`currency=$${n++}`);    vals.push(b.currency); }
  if (sets.length === 0) throw new AppError(400, 'Nothing to update');
  vals.push(req.params['id']);
  const { rows } = await req.db!.query<Record<string, unknown>>(
    `UPDATE budgets SET ${sets.join(',')} WHERE id=$${n} RETURNING *`, vals,
  );
  if (!rows[0]) throw new AppError(404, 'Budget not found');
  res.json(rows[0]);
});

moneyRouter.delete('/budgets/:id', async (req: Request, res: Response) => {
  await req.db!.query(`UPDATE budgets SET deleted_at=NOW() WHERE id=$1`, [req.params['id']]);
  res.json({ ok: true });
});

// ════════════════════════════════════════════════════════════════════════════
// EXPENSE SPLITS
// ════════════════════════════════════════════════════════════════════════════
const SplitBody = z.object({
  transaction_id: z.string().uuid().optional(),
  title:          z.string().min(1).max(300),
  total_amount:   z.number().positive(),
  currency:       z.string().length(3).optional(),
  members: z.array(z.object({
    user_id:   z.string().uuid().optional(),
    name:      z.string().optional(),
    share_amt: z.number().nonnegative(),
  })).optional(),
});

moneyRouter.get('/splits', async (req: Request, res: Response) => {
  const { rows } = await req.db!.query<Record<string, unknown>>(
    `SELECT s.*,
       json_agg(json_build_object(
         'user_id', m.user_id, 'name', m.name,
         'share_amt', m.share_amt, 'paid', m.paid, 'forgiven', m.forgiven
       )) AS members
     FROM expense_splits s
     LEFT JOIN expense_split_members m ON m.split_id = s.id
     GROUP BY s.id
     ORDER BY s.created_at DESC`,
    [],
  );
  res.json(rows);
});

moneyRouter.post('/splits', async (req: Request, res: Response) => {
  const b = SplitBody.parse(req.body);
  const { rows } = await req.db!.query<Record<string, unknown>>(
    `INSERT INTO expense_splits (user_id, transaction_id, title, total_amount, currency)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [req.user!.id, b.transaction_id ?? null,
     b.title, b.total_amount, b.currency ?? 'DZD'],
  );
  const split = rows[0]!;
  const splitId = (split as Record<string, unknown>)['id'] as string;
  if (b.members?.length) {
    for (const m of b.members) {
      await req.db!.query(
        `INSERT INTO expense_split_members (split_id, user_id, name, share_amt)
         VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
        [splitId, m.user_id ?? null, m.name ?? null, m.share_amt],
      );
    }
  }
  res.status(201).json(split);
});

moneyRouter.get('/splits/:id', async (req: Request, res: Response) => {
  const { rows } = await req.db!.query<Record<string, unknown>>(
    `SELECT s.*,
       json_agg(json_build_object(
         'user_id', m.user_id, 'name', m.name,
         'share_amt', m.share_amt, 'paid', m.paid, 'forgiven', m.forgiven
       )) AS members
     FROM expense_splits s
     LEFT JOIN expense_split_members m ON m.split_id = s.id
     WHERE s.id=$1
     GROUP BY s.id`,
    [req.params['id']],
  );
  if (!rows[0]) throw new AppError(404, 'Split not found');
  res.json(rows[0]);
});

moneyRouter.patch('/splits/:id', async (req: Request, res: Response) => {
  const b = SplitBody.omit({ members: true }).partial().parse(req.body);
  const sets: string[] = []; const vals: unknown[] = []; let n = 1;
  if (b.title          !== undefined) { sets.push(`title=$${n++}`);          vals.push(b.title); }
  if (b.total_amount   !== undefined) { sets.push(`total_amount=$${n++}`);   vals.push(b.total_amount); }
  if (b.currency       !== undefined) { sets.push(`currency=$${n++}`);       vals.push(b.currency); }
  if (b.transaction_id !== undefined) { sets.push(`transaction_id=$${n++}`); vals.push(b.transaction_id); }
  if (sets.length === 0) throw new AppError(400, 'Nothing to update');
  vals.push(req.params['id']);
  const { rows } = await req.db!.query<Record<string, unknown>>(
    `UPDATE expense_splits SET ${sets.join(',')} WHERE id=$${n} RETURNING *`, vals,
  );
  if (!rows[0]) throw new AppError(404, 'Split not found');
  res.json(rows[0]);
});

moneyRouter.delete('/splits/:id', async (req: Request, res: Response) => {
  await req.db!.query(`UPDATE expense_splits SET deleted_at=NOW() WHERE id=$1`, [req.params['id']]);
  res.json({ ok: true });
});

// PATCH /api/money/splits/:id/settle  — mark fully settled
moneyRouter.patch('/splits/:id/settle', async (req: Request, res: Response) => {
  const { rows } = await req.db!.query<Record<string, unknown>>(
    `UPDATE expense_splits SET settled=TRUE WHERE id=$1 RETURNING *`, [req.params['id']],
  );
  if (!rows[0]) throw new AppError(404, 'Split not found');
  res.json(rows[0]);
});

// PUT /api/money/splits/:id/members/:memberId  — mark paid / forgiven
moneyRouter.patch('/splits/:id/members', async (req: Request, res: Response) => {
  const body = z.object({
    user_id:  z.string().uuid().optional(),
    name:     z.string().optional(),
    paid:     z.boolean().optional(),
    forgiven: z.boolean().optional(),
  }).parse(req.body);

  const sets: string[] = []; const vals: unknown[] = []; let n = 1;
  if (body.paid     !== undefined) { sets.push(`paid=$${n++}`);     vals.push(body.paid); }
  if (body.forgiven !== undefined) { sets.push(`forgiven=$${n++}`); vals.push(body.forgiven); }
  if (sets.length === 0) throw new AppError(400, 'Nothing to update');

  const filter = body.user_id
    ? `split_id=$${n++} AND user_id=$${n++}`
    : `split_id=$${n++} AND name=$${n++}`;
  if (body.user_id) { vals.push(req.params['id']); vals.push(body.user_id); }
  else              { vals.push(req.params['id']); vals.push(body.name ?? null); }

  await req.db!.query(
    `UPDATE expense_split_members SET ${sets.join(',')} WHERE ${filter}`, vals,
  );
  res.json({ ok: true });
});

// ════════════════════════════════════════════════════════════════════════════
// VENTURE BUDGETS
// ════════════════════════════════════════════════════════════════════════════
const VBudgetBody = z.object({
  objective_id: z.string().uuid(),
  category:     z.string().min(1).max(200),
  amount_cap:   z.number().positive(),
  currency:     z.string().length(3).optional(),
});

moneyRouter.get('/venture-budgets', async (req: Request, res: Response) => {
  const { objective_id } = req.query as Record<string, string | undefined>;
  const { rows } = await req.db!.query<Record<string, unknown>>(
    `SELECT * FROM venture_budgets
     WHERE ($1::uuid IS NULL OR objective_id = $1::uuid)
     ORDER BY created_at DESC`,
    [objective_id ?? null],
  );
  res.json(rows);
});

moneyRouter.post('/venture-budgets', async (req: Request, res: Response) => {
  const b = VBudgetBody.parse(req.body);
  const { rows } = await req.db!.query<Record<string, unknown>>(
    `INSERT INTO venture_budgets (objective_id, user_id, category, amount_cap, currency)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [b.objective_id, req.user!.id, b.category, b.amount_cap, b.currency ?? 'DZD'],
  );
  res.status(201).json(rows[0]);
});

moneyRouter.patch('/venture-budgets/:id', async (req: Request, res: Response) => {
  const b = VBudgetBody.partial().omit({ objective_id: true }).parse(req.body);
  const sets: string[] = []; const vals: unknown[] = []; let n = 1;
  if (b.category   !== undefined) { sets.push(`category=$${n++}`);   vals.push(b.category); }
  if (b.amount_cap !== undefined) { sets.push(`amount_cap=$${n++}`); vals.push(b.amount_cap); }
  if (b.currency   !== undefined) { sets.push(`currency=$${n++}`);   vals.push(b.currency); }
  if (sets.length === 0) throw new AppError(400, 'Nothing to update');
  vals.push(req.params['id']);
  const { rows } = await req.db!.query<Record<string, unknown>>(
    `UPDATE venture_budgets SET ${sets.join(',')} WHERE id=$${n} RETURNING *`, vals,
  );
  if (!rows[0]) throw new AppError(404, 'Venture budget not found');
  res.json(rows[0]);
});

moneyRouter.delete('/venture-budgets/:id', async (req: Request, res: Response) => {
  await req.db!.query(`DELETE FROM venture_budgets WHERE id=$1`, [req.params['id']]);
  res.json({ ok: true });
});

// ════════════════════════════════════════════════════════════════════════════
// PORTFOLIO  (aggregate across ventures + projects)
// ════════════════════════════════════════════════════════════════════════════
moneyRouter.get('/portfolio', async (req: Request, res: Response) => {
  const { rows } = await req.db!.query<Record<string, unknown>>(
    `SELECT
       o.id, o.title, o.kind, o.status,
       COALESCE(SUM(vb.amount_cap), 0)::numeric  AS budget_total,
       COALESCE(SUM(vb.spent), 0)::numeric        AS budget_spent,
       COUNT(DISTINCT m.id)::int                  AS milestone_count,
       COUNT(DISTINCT ms.id) FILTER (WHERE ms.completed_at IS NOT NULL)::int AS milestones_done,
       COUNT(DISTINCT i.id)::int                  AS item_count,
       COUNT(DISTINCT i.id) FILTER (WHERE i.status = 'done')::int AS items_done
     FROM objectives o
     LEFT JOIN venture_budgets vb ON vb.objective_id = o.id
     LEFT JOIN objective_milestones m ON m.objective_id = o.id
     LEFT JOIN objective_milestones ms ON ms.objective_id = o.id
     LEFT JOIN items i ON i.objective_id = o.id AND i.deleted_at IS NULL
     WHERE o.kind IN ('venture','project')
     GROUP BY o.id
     ORDER BY o.created_at DESC`,
    [],
  );
  res.json(rows);
});
