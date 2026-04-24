/**
 * Items CRUD smoke tests
 * ──────────────────────
 * GET  /api/items        → 401  (no token)
 * POST /api/items        → 401  (no token)
 * POST /api/items        → 201  (authenticated)
 * GET  /api/items        → 200  (authenticated, returns array)
 * GET  /api/items/:id    → 200  (authenticated, returns created item)
 * PATCH /api/items/:id   → 200  (authenticated, updates title)
 * DELETE /api/items/:id  → 200  (authenticated, soft-deletes)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { app }  from '../index.js';
import { pool } from '../lib/db.js';
import type { Server } from 'http';

const TEST_EMAIL    = `items_test_${Date.now()}@pulse.test`;
const TEST_PASSWORD = 'TestPassword123!';

let server: Server;
let accessToken: string;
let createdId: string;

beforeAll(async () => {
  server = app.listen(0);

  // Register + login to get a token
  const res = await request(server)
    .post('/api/auth/register')
    .send({ email: TEST_EMAIL, password: TEST_PASSWORD, name: 'Items Tester' });

  accessToken = res.body.accessToken as string;
});

afterAll(async () => {
  try {
    await pool.query(`DELETE FROM users WHERE email = $1`, [TEST_EMAIL]);
  } catch { /* ignore */ }
  await new Promise<void>(res => server.close(() => res()));
  // Don't end pool here — auth.test.ts may already have done it
});

describe('Items — unauthenticated', () => {
  it('GET /api/items → 401', async () => {
    const res = await request(server).get('/api/items');
    expect(res.status).toBe(401);
  });

  it('POST /api/items → 401', async () => {
    const res = await request(server).post('/api/items').send({ title: 'Test' });
    expect(res.status).toBe(401);
  });
});

describe('Items — authenticated', () => {
  it('POST /api/items → 201 (creates item)', async () => {
    const res = await request(server)
      .post('/api/items')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ title: 'Test item from vitest', kind: 'task', status: 'inbox' });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ title: 'Test item from vitest' });
    createdId = res.body.id as string;
  });

  it('GET /api/items → 200 (returns array)', async () => {
    const res = await request(server)
      .get('/api/items')
      .set('Authorization', `Bearer ${accessToken}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('GET /api/items/:id → 200 (returns created item)', async () => {
    const res = await request(server)
      .get(`/api/items/${createdId}`)
      .set('Authorization', `Bearer ${accessToken}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: createdId, title: 'Test item from vitest' });
  });

  it('PATCH /api/items/:id → 200 (updates title)', async () => {
    const res = await request(server)
      .patch(`/api/items/${createdId}`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ title: 'Updated by vitest' });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ title: 'Updated by vitest' });
  });

  it('DELETE /api/items/:id → 200 (soft-deletes)', async () => {
    const res = await request(server)
      .delete(`/api/items/${createdId}`)
      .set('Authorization', `Bearer ${accessToken}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true });
  });
});
