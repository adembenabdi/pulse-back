/**
 * services/ai/link-suggest.ts
 *
 * Given a newly-created entity, suggest up to 5 links to existing entities
 * that are semantically related. Uses Groq with JSON mode for structured output.
 *
 * Returns an array of suggestions sorted by confidence descending.
 * The caller is responsible for persisting them to link_suggestions.
 */

import { groqChat, isGroqAvailable }  from './groq.js';
import { db }                          from '../../lib/db.js';
import { logger }                      from '../../lib/logger.js';
import { ENTITY_TYPES, type EntityType } from '../../lib/entities.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface NewEntityContext {
  type:        EntityType;
  id:          string;
  title:       string;
  description?: string | null;
}

export interface LinkSuggestion {
  target_type:  string;
  target_id:    string;
  relation:     string;
  confidence:   number;   // 0–1
  reason:       string;
}

// ── Candidate fetch ───────────────────────────────────────────────────────────
// Fetch a limited set of recent entities across key types so the LLM can choose.

const CANDIDATE_QUERIES: Partial<Record<EntityType, string>> = {
  item:      `SELECT id, title AS label, 'item'      AS type FROM items       WHERE user_id = $1 AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 10`,
  idea:      `SELECT id, title AS label, 'idea'      AS type FROM ideas       WHERE user_id = $1 AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 10`,
  objective: `SELECT id, title AS label, 'objective' AS type FROM objectives  WHERE user_id = $1 AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 10`,
  habit:     `SELECT id, title AS label, 'habit'     AS type FROM habits      WHERE user_id = $1 AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 5`,
  resource:  `SELECT id, title AS label, 'resource'  AS type FROM resources   WHERE user_id = $1 AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 5`,
  recipe:    `SELECT id, title AS label, 'recipe'    AS type FROM recipes     WHERE user_id = $1 AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 5`,
};

interface CandidateRow {
  id:    string;
  label: string;
  type:  string;
}

async function fetchCandidates(userId: string, excludeType: EntityType, excludeId: string): Promise<CandidateRow[]> {
  const results = await Promise.all(
    Object.entries(CANDIDATE_QUERIES).map(async ([, sql]) => {
      try {
        const { rows } = await db.admin.query<CandidateRow>(sql, [userId]);
        return rows;
      } catch {
        return [];
      }
    }),
  );

  return results
    .flat()
    .filter(r => !(r.type === excludeType && r.id === excludeId));
}

// ── Main suggest function ─────────────────────────────────────────────────────

export async function suggestLinks(
  userId:    string,
  newEntity: NewEntityContext,
): Promise<LinkSuggestion[]> {
  if (!isGroqAvailable()) {
    logger.warn('suggestLinks: GROQ_API_KEY not set — skipping link suggestions');
    return [];
  }

  try {
    const candidates = await fetchCandidates(userId, newEntity.type, newEntity.id);
    if (candidates.length === 0) return [];

    const candidateList = candidates
      .map(c => `- [${c.type}:${c.id}] "${c.label}"`)
      .join('\n');

    const systemPrompt = `You are an intelligent link suggester for a personal Life OS app.
Given a new entity and a list of existing entities, suggest up to 5 meaningful relationships between them.

Available relation types:
- depends_on     : new entity cannot proceed until target is done
- blocks         : new entity prevents target from proceeding  
- contributes_to : new entity helps achieve target (task → objective)
- uses           : new entity consumes / references target (meal plan → recipe)
- related_to     : generic semantic relevance
- references     : new entity cites or links to target
- mentions_person: new entity involves a person

Rules:
- Only suggest links that make clear semantic sense.
- Confidence 0.0–1.0: 0.9+ only for very obvious links, 0.5–0.7 for plausible ones.
- Return VALID JSON array only, no explanation text.
- Maximum 5 suggestions. If nothing is relevant, return [].`;

    const userPrompt = `New entity:
Type: ${newEntity.type}
ID:   ${newEntity.id}
Title: ${newEntity.title}${newEntity.description ? `\nDescription: ${newEntity.description}` : ''}

Existing entities to consider linking to:
${candidateList}

Return JSON array of suggestions:
[{"target_type":"...","target_id":"...","relation":"...","confidence":0.0,"reason":"..."}]`;

    const result = await groqChat(
      [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: userPrompt   },
      ],
      { jsonMode: true, maxTokens: 512, temperature: 0.3 },
    );

    let parsed: unknown;
    try {
      // Groq may wrap in an object; handle both array and { suggestions: [] }
      const raw = JSON.parse(result.content);
      parsed = Array.isArray(raw) ? raw : (raw as Record<string, unknown>).suggestions ?? raw.links ?? [];
    } catch {
      logger.warn({ content: result.content }, 'suggestLinks: failed to parse JSON response');
      return [];
    }

    if (!Array.isArray(parsed)) return [];

    // Validate and clean each suggestion
    const validated: LinkSuggestion[] = [];
    for (const item of parsed as unknown[]) {
      if (
        typeof item === 'object' && item !== null &&
        typeof (item as Record<string, unknown>).target_type === 'string' &&
        typeof (item as Record<string, unknown>).target_id   === 'string' &&
        typeof (item as Record<string, unknown>).relation    === 'string' &&
        typeof (item as Record<string, unknown>).confidence  === 'number' &&
        ENTITY_TYPES.includes((item as Record<string, unknown>).target_type as EntityType)
      ) {
        const sug = item as Record<string, unknown>;
        // Ensure target exists in our candidate list (prevents hallucinated IDs)
        const candidate = candidates.find(
          c => c.id === sug.target_id && c.type === sug.target_type,
        );
        if (!candidate) continue;

        validated.push({
          target_type: sug.target_type as string,
          target_id:   sug.target_id   as string,
          relation:    sug.relation    as string,
          confidence:  Math.min(1, Math.max(0, sug.confidence as number)),
          reason:      typeof sug.reason === 'string' ? sug.reason : '',
        });
      }
    }

    return validated
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, 5);
  } catch (err) {
    logger.error(err, 'suggestLinks: unexpected error');
    return [];
  }
}

// ── Persist suggestions ───────────────────────────────────────────────────────

export async function persistSuggestions(
  userId:    string,
  source:    NewEntityContext,
  suggestions: LinkSuggestion[],
): Promise<void> {
  if (!suggestions.length) return;

  // Insert suggestions; ignore duplicates
  const values = suggestions.map((s, i) => {
    const base = i * 7;
    return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7})`;
  }).join(', ');

  const params: unknown[] = [];
  for (const s of suggestions) {
    params.push(userId, source.type, source.id, s.target_type, s.target_id, s.relation, s.confidence, s.reason);
  }

  // Rebuild with 8 params per row (added reason)
  const valuesEight = suggestions.map((_, i) => {
    const base = i * 8;
    return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8})`;
  }).join(', ');

  const paramsEight: unknown[] = [];
  for (const s of suggestions) {
    paramsEight.push(userId, source.type, source.id, s.target_type, s.target_id, s.relation, s.confidence, s.reason ?? null);
  }

  try {
    await db.admin.query(
      `INSERT INTO link_suggestions
         (user_id, source_type, source_id, target_type, target_id, relation, confidence, reason)
       VALUES ${valuesEight}
       ON CONFLICT DO NOTHING`,
      paramsEight,
    );
  } catch (err) {
    logger.warn(err, 'persistSuggestions: insert failed');
  }
}
