/**
 * Tests: Entity Links API
 *
 * Tests cover:
 *   - POST /api/links            (create, dedupe, validation)
 *   - GET  /api/links            (list by entity, direction filter)
 *   - GET  /api/links/graph      (graph subgraph response shape)
 *   - PATCH /api/links/:id       (update relation)
 *   - DELETE /api/links/:id      (delete)
 *   - GET  /api/links/suggestions (list pending)
 *   - POST /api/links/suggestions/:id/accept
 *   - POST /api/links/suggestions/:id/dismiss
 *   - Security: cross-user linking → 404
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { app }  from '../index.js';
import { pool } from '../lib/db.js';
import type { Server } from 'http';

// ── Test fixtures ─────────────────────────────────────────────────────────────

const EMAIL_A = `links_a_${Date.now()}@pulse.test`;
const EMAIL_B = `links_b_${Date.now()}@pulse.test`;
const PASSWORD = 'TestPassword123!';

let server: Server;
let tokenA: string;
let tokenB: string;
let userIdA: string;
let userIdB: string;

// Entity IDs created during tests
let itemId:      string;
let ideaId:      string;
let linkId:      string;
let suggestionId: string;

// ── Setup / teardown ──────────────────────────────────────────────────────────

beforeAll(async () => {
  server = app.listen(0);

  // Register user A
  const resA = await request(server)
    .post('/api/auth/register')
    .send({ email: EMAIL_A, password: PASSWORD, name: 'Links User A' });
  tokenA  = resA.body.accessToken as string;
  userIdA = resA.body.user.id     as string;

  // Register user B
  const resB = await request(server)
    .post('/api/auth/register')
    .send({ email: EMAIL_B, password: PASSWORD, name: 'Links User B' });
  tokenB  = resB.body.accessToken as string;
  userIdB = resB.body.user.id     as string;

  // Create an item owned by user A
  const itemRes = await pool.query<{ id: string }>(
    `INSERT INTO items (user_id, title, kind) VALUES ($1, 'Test Task', 'task') RETURNING id`,
    [userIdA],
  );
  itemId = itemRes.rows[0]!.id;

  // Create an idea owned by user A
  const ideaRes = await pool.query<{ id: string }>(
    `INSERT INTO ideas (user_id, title) VALUES ($1, 'Test Idea') RETURNING id`,
    [userIdA],
  );
  ideaId = ideaRes.rows[0]!.id;
});

afterAll(async () => {
  // Cleanup
  await pool.query(`DELETE FROM entity_links      WHERE user_id IN ($1,$2)`, [userIdA, userIdB]);
  await pool.query(`DELETE FROM link_suggestions  WHERE user_id IN ($1,$2)`, [userIdA, userIdB]);
  await pool.query(`DELETE FROM items             WHERE user_id IN ($1,$2)`, [userIdA, userIdB]);
  await pool.query(`DELETE FROM ideas             WHERE user_id IN ($1,$2)`, [userIdA, userIdB]);
  await pool.query(`DELETE FROM users             WHERE id      IN ($1,$2)`, [userIdA, userIdB]);

  await new Promise<void>(res => server.close(() => res()));
  await pool.end();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('POST /api/links', () => {
  it('creates a link between two owned entities (201)', async () => {
    const res = await request(server)
      .post('/api/links')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        source:   { type: 'item', id: itemId },
        target:   { type: 'idea', id: ideaId },
        relation: 'contributes_to',
      });

    expect(res.status).toBe(201);
    expect(res.body.link).toMatchObject({
      source_type: 'item',
      source_id:   itemId,
      target_type: 'idea',
      target_id:   ideaId,
      relation:    'contributes_to',
      created_by:  'user',
    });
    expect(res.body.source_preview).toBeTruthy();
    expect(res.body.target_preview).toBeTruthy();
    linkId = res.body.link.id as string;
  });

  it('deduplicates an existing link (upsert, 201)', async () => {
    const res = await request(server)
      .post('/api/links')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        source:   { type: 'item', id: itemId },
        target:   { type: 'idea', id: ideaId },
        relation: 'contributes_to',
      });
    expect(res.status).toBe(201);
    expect(res.body.link.id).toBe(linkId); // same row, upserted
  });

  it('rejects a self-link (400)', async () => {
    const res = await request(server)
      .post('/api/links')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        source:   { type: 'item', id: itemId },
        target:   { type: 'item', id: itemId },
        relation: 'related_to',
      });
    expect(res.status).toBe(400);
  });

  it('rejects custom relation without label (400)', async () => {
    const res = await request(server)
      .post('/api/links')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        source:   { type: 'item', id: itemId },
        target:   { type: 'idea', id: ideaId },
        relation: 'custom',
        // missing label
      });
    expect(res.status).toBe(400);
  });

  it('rejects linking to another user\'s entity (404)', async () => {
    // Create item owned by user B
    const bItem = await pool.query<{ id: string }>(
      `INSERT INTO items (user_id, title, kind) VALUES ($1, 'B Task', 'task') RETURNING id`,
      [userIdB],
    );
    const bItemId = bItem.rows[0]!.id;

    const res = await request(server)
      .post('/api/links')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        source:   { type: 'item', id: itemId },
        target:   { type: 'item', id: bItemId },
        relation: 'related_to',
      });
    expect(res.status).toBe(404);

    // Cleanup
    await pool.query(`DELETE FROM items WHERE id = $1`, [bItemId]);
  });

  it('rejects unauthenticated request (401)', async () => {
    const res = await request(server)
      .post('/api/links')
      .send({ source: { type: 'item', id: itemId }, target: { type: 'idea', id: ideaId }, relation: 'related_to' });
    expect(res.status).toBe(401);
  });
});

describe('GET /api/links', () => {
  it('returns outgoing links for an entity', async () => {
    const res = await request(server)
      .get('/api/links')
      .set('Authorization', `Bearer ${tokenA}`)
      .query({ entity_type: 'item', entity_id: itemId, direction: 'out' });

    expect(res.status).toBe(200);
    expect(res.body.links.length).toBeGreaterThanOrEqual(1);
    expect(res.body.links[0]).toHaveProperty('source_preview');
    expect(res.body.links[0]).toHaveProperty('target_preview');
  });

  it('returns incoming links for an entity', async () => {
    const res = await request(server)
      .get('/api/links')
      .set('Authorization', `Bearer ${tokenA}`)
      .query({ entity_type: 'idea', entity_id: ideaId, direction: 'in' });

    expect(res.status).toBe(200);
    expect(res.body.links.length).toBeGreaterThanOrEqual(1);
  });

  it('filters by relation type', async () => {
    const res = await request(server)
      .get('/api/links')
      .set('Authorization', `Bearer ${tokenA}`)
      .query({ entity_type: 'item', entity_id: itemId, relation: 'depends_on' });

    expect(res.status).toBe(200);
    expect(res.body.links.length).toBe(0); // we only created contributes_to
  });
});

describe('GET /api/links/graph', () => {
  it('returns nodes and edges shape', async () => {
    const res = await request(server)
      .get('/api/links/graph')
      .set('Authorization', `Bearer ${tokenA}`)
      .query({ root_type: 'item', root_id: itemId, depth: 1 });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('nodes');
    expect(res.body).toHaveProperty('edges');
    expect(Array.isArray(res.body.nodes)).toBe(true);
    expect(Array.isArray(res.body.edges)).toBe(true);
    // At minimum the source and target nodes should appear
    const nodeIds = (res.body.nodes as { id: string }[]).map(n => n.id);
    expect(nodeIds).toContain(`item:${itemId}`);
    expect(nodeIds).toContain(`idea:${ideaId}`);
  });

  it('returns full user graph when no root specified', async () => {
    const res = await request(server)
      .get('/api/links/graph')
      .set('Authorization', `Bearer ${tokenA}`);

    expect(res.status).toBe(200);
    expect(res.body.edge_count).toBeGreaterThanOrEqual(1);
  });
});

describe('PATCH /api/links/:id', () => {
  it('updates relation type', async () => {
    const res = await request(server)
      .patch(`/api/links/${linkId}`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ relation: 'references' });

    expect(res.status).toBe(200);
    expect(res.body.relation).toBe('references');
  });

  it('rejects updating another user\'s link (404)', async () => {
    const res = await request(server)
      .patch(`/api/links/${linkId}`)
      .set('Authorization', `Bearer ${tokenB}`)
      .send({ relation: 'uses' });
    expect(res.status).toBe(404);
  });
});

describe('DELETE /api/links/:id', () => {
  it('deletes an owned link (204)', async () => {
    const res = await request(server)
      .delete(`/api/links/${linkId}`)
      .set('Authorization', `Bearer ${tokenA}`);
    expect(res.status).toBe(204);
  });

  it('returns 404 for already-deleted link', async () => {
    const res = await request(server)
      .delete(`/api/links/${linkId}`)
      .set('Authorization', `Bearer ${tokenA}`);
    expect(res.status).toBe(404);
  });
});

describe('Link suggestions', () => {
  beforeAll(async () => {
    // Recreate the link first (was deleted)
    await pool.query(
      `INSERT INTO entity_links (user_id, source_type, source_id, target_type, target_id, relation)
       VALUES ($1, 'item', $2, 'idea', $3, 'contributes_to')`,
      [userIdA, itemId, ideaId],
    );

    // Directly insert a suggestion
    const res = await pool.query<{ id: string }>(
      `INSERT INTO link_suggestions (user_id, source_type, source_id, target_type, target_id, relation, confidence, reason)
       VALUES ($1, 'item', $2, 'idea', $3, 'uses', 0.85, 'Test suggestion')
       RETURNING id`,
      [userIdA, itemId, ideaId],
    );
    suggestionId = res.rows[0]!.id;
  });

  it('GET /api/links/suggestions — returns pending suggestions', async () => {
    const res = await request(server)
      .get('/api/links/suggestions')
      .set('Authorization', `Bearer ${tokenA}`)
      .query({ status: 'pending' });

    expect(res.status).toBe(200);
    expect(res.body.suggestions.length).toBeGreaterThanOrEqual(1);
    expect(res.body.suggestions[0]).toHaveProperty('source_preview');
    expect(res.body.suggestions[0]).toHaveProperty('target_preview');
  });

  it('POST /api/links/suggestions/:id/accept — promotes to entity_links', async () => {
    const res = await request(server)
      .post(`/api/links/suggestions/${suggestionId}/accept`)
      .set('Authorization', `Bearer ${tokenA}`);

    expect(res.status).toBe(200);
    expect(res.body.link).toMatchObject({ created_by: 'ai' });

    // Verify suggestion is now accepted
    const { rows } = await pool.query<{ status: string }>(
      `SELECT status FROM link_suggestions WHERE id = $1`,
      [suggestionId],
    );
    expect(rows[0]?.status).toBe('accepted');
  });

  it('POST /api/links/suggestions/:id/accept — 409 if already accepted', async () => {
    const res = await request(server)
      .post(`/api/links/suggestions/${suggestionId}/accept`)
      .set('Authorization', `Bearer ${tokenA}`);
    expect(res.status).toBe(409);
  });

  it('POST /api/links/suggestions/:id/dismiss — dismisses pending suggestion', async () => {
    // Insert fresh suggestion
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO link_suggestions (user_id, source_type, source_id, target_type, target_id, relation, confidence)
       VALUES ($1, 'item', $2, 'idea', $3, 'blocks', 0.4)
       RETURNING id`,
      [userIdA, itemId, ideaId],
    );
    const dismissId = rows[0]!.id;

    const res = await request(server)
      .post(`/api/links/suggestions/${dismissId}/dismiss`)
      .set('Authorization', `Bearer ${tokenA}`);
    expect(res.status).toBe(204);

    const { rows: check } = await pool.query<{ status: string }>(
      `SELECT status FROM link_suggestions WHERE id = $1`,
      [dismissId],
    );
    expect(check[0]?.status).toBe('dismissed');
  });
});
