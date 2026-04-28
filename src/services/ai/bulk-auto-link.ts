/**
 * services/ai/bulk-auto-link.ts
 *
 * Scans ALL of a user's entities and uses Groq to automatically discover
 * and create meaningful links between them.
 *
 * Strategy:
 *   1. Fetch up to N recent entities across all key types
 *   2. Break them into overlapping windows of ~30 entities each
 *   3. For each window, ask Groq to find all meaningful pairs
 *   4. Deduplicate + insert directly into entity_links (created_by='ai')
 *   5. Return a summary { created, skipped }
 */

import { groqChat, isGroqAvailable } from './groq.js';
import { admin }                      from '../../lib/db.js';
import { logger }                     from '../../lib/logger.js';
import type { EntityType }            from '../../lib/entities.js';

const VALID_RELATIONS = [
  'depends_on', 'blocks', 'contributes_to', 'uses',
  'related_to', 'references', 'mentions_person',
] as const;

// ── Fetch all candidate entities ──────────────────────────────────────────────

interface EntityRow {
  id:    string;
  type:  EntityType;
  label: string;
}

const ENTITY_FETCH: Partial<Record<EntityType, string>> = {
  item:          `SELECT id, title AS label, 'item'          AS type FROM items          WHERE user_id=$1 AND deleted_at IS NULL ORDER BY updated_at DESC LIMIT 30`,
  idea:          `SELECT id, title AS label, 'idea'          AS type FROM ideas          WHERE user_id=$1 AND deleted_at IS NULL ORDER BY updated_at DESC LIMIT 20`,
  objective:     `SELECT id, title AS label, 'objective'     AS type FROM objectives     WHERE user_id=$1 AND deleted_at IS NULL ORDER BY updated_at DESC LIMIT 15`,
  habit:         `SELECT id, title AS label, 'habit'         AS type FROM habits         WHERE user_id=$1 AND deleted_at IS NULL ORDER BY created_at  DESC LIMIT 10`,
  resource:      `SELECT id, title AS label, 'resource'      AS type FROM resources      WHERE user_id=$1 AND deleted_at IS NULL ORDER BY created_at  DESC LIMIT 10`,
  calendar_item: `SELECT id, title AS label, 'calendar_item' AS type FROM calendar_items WHERE user_id=$1 AND deleted_at IS NULL ORDER BY starts_at   DESC LIMIT 10`,
  freelance_gig: `SELECT id, title AS label, 'freelance_gig' AS type FROM freelance_gigs WHERE user_id=$1 AND deleted_at IS NULL ORDER BY created_at  DESC LIMIT 10`,
};

async function fetchAllEntities(userId: string): Promise<EntityRow[]> {
  const batches = await Promise.all(
    Object.values(ENTITY_FETCH).map(async (sql) => {
      try {
        const { rows } = await admin.query<EntityRow>(sql, [userId]);
        return rows;
      } catch {
        return [] as EntityRow[];
      }
    }),
  );
  return batches.flat();
}

// ── Ask Groq to find links in a window of entities ───────────────────────────

interface RawLink {
  source_type: string;
  source_id:   string;
  target_type: string;
  target_id:   string;
  relation:    string;
  confidence:  number;
  reason:      string;
}

async function findLinksInWindow(entities: EntityRow[]): Promise<RawLink[]> {
  if (entities.length < 2) return [];

  const list = entities
    .map(e => `[${e.type}:${e.id}] "${e.label}"`)
    .join('\n');

  const systemPrompt = `You are an expert at finding meaningful connections in a personal Life OS.
Given a list of entities (tasks, ideas, objectives, habits, resources, events, gigs), 
identify ALL meaningful relationships between them.

Available relation types:
- depends_on     : source cannot proceed until target is done
- blocks         : source prevents target from proceeding
- contributes_to : source helps achieve target (e.g. task → objective, habit → objective)
- uses           : source consumes or relies on target (e.g. meal plan → recipe, gig → skill)
- related_to     : general semantic overlap
- references     : source cites or links to target
- mentions_person: source involves a specific person

Rules:
- Only suggest links that have clear semantic meaning — not random noise.
- confidence 0.0–1.0. Use 0.9+ only for obvious structural links (task → its objective).
- Skip self-links (same id).
- Return ONLY a valid JSON array. No explanation outside the JSON.
- Maximum 20 links per call.`;

  const userPrompt = `Entities:\n${list}\n\nReturn JSON array:\n[{"source_type":"...","source_id":"...","target_type":"...","target_id":"...","relation":"...","confidence":0.0,"reason":"..."}]`;

  let content: string;
  try {
    const result = await groqChat(
      [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: userPrompt   },
      ],
      { jsonMode: true, maxTokens: 1024, temperature: 0.2 },
    );
    content = result.content;
  } catch (err) {
    logger.warn(err, 'bulk-auto-link: groqChat failed');
    return [];
  }

  let parsed: unknown;
  try {
    const raw = JSON.parse(content);
    parsed = Array.isArray(raw)
      ? raw
      : (raw as Record<string, unknown>).links
        ?? (raw as Record<string, unknown>).suggestions
        ?? [];
  } catch {
    logger.warn({ content }, 'bulk-auto-link: JSON parse failed');
    return [];
  }

  if (!Array.isArray(parsed)) return [];

  // Validate against the entity list we sent
  const entitySet = new Map(entities.map(e => [`${e.type}:${e.id}`, e]));

  const valid: RawLink[] = [];
  for (const item of parsed as unknown[]) {
    if (typeof item !== 'object' || item === null) continue;
    const r = item as Record<string, unknown>;

    const srcKey = `${r.source_type}:${r.source_id}`;
    const tgtKey = `${r.target_type}:${r.target_id}`;

    if (srcKey === tgtKey) continue; // no self-links
    if (!entitySet.has(srcKey)) continue; // hallucinated id
    if (!entitySet.has(tgtKey)) continue; // hallucinated id
    if (!VALID_RELATIONS.includes(r.relation as typeof VALID_RELATIONS[number])) continue;
    if (typeof r.confidence !== 'number') continue;

    valid.push({
      source_type: r.source_type as string,
      source_id:   r.source_id   as string,
      target_type: r.target_type as string,
      target_id:   r.target_id   as string,
      relation:    r.relation    as string,
      confidence:  Math.min(1, Math.max(0, r.confidence as number)),
      reason:      typeof r.reason === 'string' ? r.reason : '',
    });
  }

  return valid;
}

// ── Deduplicate + persist ─────────────────────────────────────────────────────

async function persistLinks(userId: string, links: RawLink[]): Promise<{ created: number; skipped: number }> {
  if (!links.length) return { created: 0, skipped: 0 };

  let created = 0;
  let skipped = 0;

  // Insert one-by-one so we can count actual inserts vs conflicts
  for (const link of links) {
    try {
      const { rowCount } = await admin.query(
        `INSERT INTO entity_links
           (user_id, source_type, source_id, target_type, target_id, relation, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, 'ai')
         ON CONFLICT (user_id, source_type, source_id, target_type, target_id, relation)
         DO NOTHING`,
        [userId, link.source_type, link.source_id, link.target_type, link.target_id, link.relation],
      );
      if (rowCount && rowCount > 0) created++;
      else skipped++;
    } catch (err) {
      logger.warn(err, 'bulk-auto-link: insert failed for one link');
      skipped++;
    }
  }

  return { created, skipped };
}

// ── Public entry point ────────────────────────────────────────────────────────

export interface AutoLinkResult {
  entities_scanned: number;
  links_found:      number;
  links_created:    number;
  links_skipped:    number;
}

export async function bulkAutoLink(userId: string): Promise<AutoLinkResult> {
  if (!isGroqAvailable()) {
    throw new Error('GROQ_API_KEY is not configured — AI auto-linking is unavailable');
  }

  const entities = await fetchAllEntities(userId);
  if (entities.length < 2) {
    return { entities_scanned: entities.length, links_found: 0, links_created: 0, links_skipped: 0 };
  }

  logger.info({ userId, entityCount: entities.length }, 'bulk-auto-link: starting');

  // Split into overlapping windows of 25 so Groq has manageable context
  // and cross-window pairs are also caught by the overlapping strategy
  const WINDOW = 25;
  const STEP   = 15; // overlap = 10 entities between windows
  const allLinks: RawLink[] = [];

  for (let i = 0; i < entities.length; i += STEP) {
    const window = entities.slice(i, i + WINDOW);
    const found  = await findLinksInWindow(window);
    allLinks.push(...found);
  }

  // Deduplicate by canonical key (bidirectional: A→B and B→A collapse)
  const seen = new Set<string>();
  const deduped = allLinks.filter(l => {
    const key = [l.source_type, l.source_id, l.target_type, l.target_id, l.relation].sort().join('|');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Only persist links with confidence ≥ 0.55
  const highConfidence = deduped.filter(l => l.confidence >= 0.55);

  logger.info({ found: deduped.length, persisting: highConfidence.length }, 'bulk-auto-link: persisting');

  const { created, skipped } = await persistLinks(userId, highConfidence);

  return {
    entities_scanned: entities.length,
    links_found:      deduped.length,
    links_created:    created,
    links_skipped:    skipped,
  };
}
