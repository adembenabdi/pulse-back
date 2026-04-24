/**
 * Auth smoke tests
 * ─────────────────
 * POST /api/auth/register  → 201  { user, accessToken, refreshToken }
 * POST /api/auth/login     → 200  { user, accessToken, refreshToken }
 * GET  /api/auth/me        → 200  { id, email, ... }   (with access token)
 * GET  /api/auth/me        → 401                       (no token)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { app }  from '../index.js';
import { pool } from '../lib/db.js';
import type { Server } from 'http';

const TEST_EMAIL    = `test_${Date.now()}@pulse.test`;
const TEST_PASSWORD = 'TestPassword123!';

let server: Server;
let accessToken: string;

beforeAll(() => {
  // Use a random port so tests don't collide with a running dev server
  server = app.listen(0);
});

afterAll(async () => {
  // Clean up test user
  try {
    await pool.query(`DELETE FROM users WHERE email = $1`, [TEST_EMAIL]);
  } catch { /* ignore */ }
  await new Promise<void>(res => server.close(() => res()));
  await pool.end();
});

describe('POST /api/auth/register', () => {
  it('creates a user and returns tokens (201)', async () => {
    const res = await request(server)
      .post('/api/auth/register')
      .send({ email: TEST_EMAIL, password: TEST_PASSWORD, name: 'Test User' });

    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty('accessToken');
    expect(res.body).toHaveProperty('refreshToken');
    expect(res.body.user).toMatchObject({ email: TEST_EMAIL });

    accessToken = res.body.accessToken as string;
  });

  it('rejects duplicate email (409)', async () => {
    const res = await request(server)
      .post('/api/auth/register')
      .send({ email: TEST_EMAIL, password: TEST_PASSWORD, name: 'Dup' });

    expect(res.status).toBe(409);
  });
});

describe('POST /api/auth/login', () => {
  it('returns tokens for valid credentials (200)', async () => {
    const res = await request(server)
      .post('/api/auth/login')
      .send({ email: TEST_EMAIL, password: TEST_PASSWORD });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('accessToken');
  });

  it('rejects wrong password (401)', async () => {
    const res = await request(server)
      .post('/api/auth/login')
      .send({ email: TEST_EMAIL, password: 'wrongpassword' });

    expect(res.status).toBe(401);
  });
});

describe('GET /api/auth/me', () => {
  it('returns the current user when authenticated (200)', async () => {
    const res = await request(server)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${accessToken}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ email: TEST_EMAIL });
  });

  it('returns 401 without a token', async () => {
    const res = await request(server).get('/api/auth/me');
    expect(res.status).toBe(401);
  });
});
