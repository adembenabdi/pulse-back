/**
 * services/ai/conversational.ts
 *
 * The shared conversational engine used by both Telegram and the in-app chat.
 *
 *   runIncoming(scoped, surface, chatId, text)
 *     1. If there's an open session waiting for input, route to applyChoice.
 *     2. Otherwise extractItems → classifyProjectLinks → organizeIdea (for
 *        new-project candidates) → persist a session row + return the preview.
 *
 *   applyChoice(scoped, sessionId, text)
 *     Parses a small reply grammar:
 *       ok                          → commit all surviving proposals
 *       cancel                      → drop the session
 *       X 1 3                       → mark proposals 1 & 3 as rejected
 *       1=2                         → for proposal 1, pick candidate #2
 *       1=new                       → force proposal 1 to a new project
 *       1=standalone                → unlink proposal 1 from any project
 *
 * The session row in `assistant_sessions` carries the full proposal batch
 * so each turn is recoverable from the database alone.
 */

import { groqChat, isGroqAvailable } from './groq.js';
import { extractItems, type ExtractedItem } from './extract.js';
import { dispatchProposals, type DispatchResult } from './dispatch.js';
import { organizeIdea } from './idea-organize.js';
import { logger } from '../../lib/logger.js';
import type { ScopedDb } from '../../lib/db.js';
import type { OrganizedIdea } from './idea-organize.js';

// ── types ────────────────────────────────────────────────────────────────────

export type Surface = 'telegram' | 'web';

export interface ProjectCandidate {
  id:    string;
  title: string;
  score: number;
}

export interface ProjectLink {
  mode:         'existing' | 'new' | 'standalone' | 'unknown';
  objective_id: string | null;
  candidates:   ProjectCandidate[];
}

export interface Proposal extends ExtractedItem {
  project_link: ProjectLink;
  structured?:  OrganizedIdea | null;
  /** Soft-deleted by the user mid-session via `X N`. */
  rejected?:    boolean;
}

export interface SessionRow {
  id:         string;
  user_id:    string;
  surface:    Surface;
  chat_id:    string | null;
  awaiting:   string;
  pending:    SessionPending;
  expires_at: string;
}

export interface SessionPending {
  proposals:       Proposal[];
  last_update_id?: number;
}

export interface RunResult {
  /** Plaintext reply to send back to the user. */
  reply:      string;
  session_id: string | null;
  /** True when no more user input is needed. */
  done:       boolean;
  /** When done & we actually committed something. */
  results?:   DispatchResult[];
  /** Fallback handling: caller may invoke free-form chat. */
  fallback?:  boolean;
}

// ── public API ───────────────────────────────────────────────────────────────

interface RunOpts {
  timezone?:   string;
  /** For Telegram idempotency. */
  updateId?:   number;
}

export async function runIncoming(
  db:      ScopedDb,
  surface: Surface,
  chatId:  string | null,
  text:    string,
  opts:    RunOpts = {},
): Promise<RunResult> {
  const trimmed = text.trim();
  if (!trimmed) return { reply: '', session_id: null, done: true };

  // 1. Resume open session?
  const open = await loadOpenSession(db, surface, chatId);
  if (open) {
    if (typeof opts.updateId === 'number' && open.pending.last_update_id === opts.updateId) {
      // Telegram retry of the same message – ignore.
      return { reply: '', session_id: open.id, done: false };
    }
    return await applyChoice(db, open, trimmed);
  }

  // Rate limit: at most RATE_LIMIT_MAX new sessions per user per RATE_LIMIT_WINDOW_MS.
  if (!recordSessionAttempt(db.userId)) {
    return {
      reply: '⚠️ You\'re going too fast. Wait a few seconds before sending another message.',
      session_id: null,
      done: true,
    };
  }

  // 2. Extract.
  const extracted = await extractItems(trimmed, opts.timezone ? { timezone: opts.timezone } : {});
  if (!extracted.length) {
    return { reply: '', session_id: null, done: true, fallback: true };
  }

  // 3. Classify each proposal against existing projects.
  const projects = await listActiveProjects(db);
  const linked   = await classifyProjectLinks(extracted, projects);

  // 4. For "new" idea-style proposals, organize them now so the preview can
  //    reflect the auto-generated plan.
  for (const p of linked) {
    if (p.kind === 'idea' && p.project_link.mode === 'new' && isGroqAvailable()) {
      try {
        p.structured = await organizeIdea({ title: p.title, description: p.description });
      } catch (err) {
        logger.warn({ err, title: p.title }, 'organizeIdea (preview) failed');
      }
    }
  }

  // 5. Persist session.
  const session = await openSession(db, surface, chatId, {
    proposals:       linked,
    ...(typeof opts.updateId === 'number' ? { last_update_id: opts.updateId } : {}),
  });

  return {
    reply:      renderPreview(linked),
    session_id: session.id,
    done:       false,
  };
}

/** Apply the user's reply against an open session. */
export async function applyChoice(
  db:      ScopedDb,
  session: SessionRow,
  text:    string,
): Promise<RunResult> {
  const cleaned = text.trim().toLowerCase();
  const proposals = session.pending.proposals;

  if (cleaned === 'cancel' || cleaned === 'no' || cleaned === 'stop') {
    await closeSession(db, session.id);
    return { reply: 'Cancelled. Nothing was saved.', session_id: session.id, done: true };
  }

  if (cleaned === 'ok' || cleaned === 'yes' || cleaned === 'save' || cleaned === 'go') {
    return await commit(db, session);
  }

  // Reject items: "x 1 3" or "x1,3"
  if (/^x[\s,]/.test(cleaned) || cleaned === 'x') {
    const idxs = parseIndices(cleaned.slice(1));
    for (const i of idxs) {
      const p = proposals[i - 1];
      if (p) p.rejected = true;
    }
    await persistPending(db, session);
    return {
      reply:      renderPreview(proposals) + '\n\nReply *ok* to save the rest, or another command.',
      session_id: session.id,
      done:       false,
    };
  }

  // Pick a candidate / override: "1=2", "1=new", "1=standalone"
  const m = /^(\d+)\s*=\s*(\w+)/.exec(cleaned);
  if (m) {
    const idx = parseInt(m[1]!, 10) - 1;
    const choice = m[2]!;
    const p = proposals[idx];
    if (!p) {
      return { reply: `No proposal #${idx + 1}.`, session_id: session.id, done: false };
    }
    if (choice === 'new') {
      p.project_link = { mode: 'new', objective_id: null, candidates: p.project_link.candidates };
      if (p.kind !== 'idea') p.kind = 'idea';
      if (isGroqAvailable() && !p.structured) {
        try { p.structured = await organizeIdea({ title: p.title, description: p.description }); }
        catch (err) { logger.warn({ err }, 'organizeIdea on choice failed'); }
      }
    } else if (choice === 'standalone' || choice === 'none') {
      p.project_link = { mode: 'standalone', objective_id: null, candidates: p.project_link.candidates };
    } else {
      const n = parseInt(choice, 10);
      const cand = Number.isInteger(n) ? p.project_link.candidates[n - 1] : undefined;
      if (!cand) {
        return { reply: `Unknown choice "${choice}" for #${idx + 1}.`, session_id: session.id, done: false };
      }
      p.project_link = { mode: 'existing', objective_id: cand.id, candidates: p.project_link.candidates };
    }
    await persistPending(db, session);
    return {
      reply:      renderPreview(proposals) + '\n\nReply *ok* to save, or another command.',
      session_id: session.id,
      done:       false,
    };
  }

  return {
    reply:
      'I didn\'t understand. Reply with:\n' +
      '• `ok` – save everything shown\n' +
      '• `cancel` – throw it all away\n' +
      '• `x 1 3` – drop items 1 and 3\n' +
      '• `2=1` – for item 2, pick candidate 1\n' +
      '• `2=new` – make item 2 a brand-new project\n' +
      '• `2=standalone` – item 2 is unlinked',
    session_id: session.id,
    done:       false,
  };
}

// ── commit ───────────────────────────────────────────────────────────────────

async function commit(db: ScopedDb, session: SessionRow): Promise<RunResult> {
  const live = session.pending.proposals.filter((p) => !p.rejected);
  if (!live.length) {
    await closeSession(db, session.id);
    return { reply: 'Nothing left to save.', session_id: session.id, done: true };
  }

  const results = await dispatchProposals(db, live as ExtractedItem[]);

  // Wire entity_links for proposals bound to a project objective.
  for (let i = 0; i < live.length; i++) {
    const proposal = live[i]!;
    const result   = results[i];
    if (!result?.ok || !result.id || !result.table) continue;

    if (proposal.project_link.mode === 'existing' && proposal.project_link.objective_id) {
      const sourceType = entityTypeForTable(result.table);
      if (!sourceType) continue;
      try {
        await db.query(
          `INSERT INTO entity_links
             (user_id, source_type, source_id, target_type, target_id,
              relation, weight, metadata, created_by)
           VALUES ($1, $2, $3, 'objective', $4, 'contributes_to', 2, $5, 'ai')
           ON CONFLICT DO NOTHING`,
          [
            db.userId,
            sourceType,
            result.id,
            proposal.project_link.objective_id,
            JSON.stringify({ source: 'assistant', confidence: proposal.confidence }),
          ],
        );
      } catch (err) {
        logger.warn({ err }, 'failed to write entity_link');
      }
    }
  }

  await closeSession(db, session.id);
  return {
    reply:      renderCommitSummary(live, results),
    session_id: session.id,
    done:       true,
    results,
  };
}

function entityTypeForTable(table: string): string | null {
  switch (table) {
    case 'items':          return 'item';
    case 'ideas':          return 'idea';
    case 'calendar_items': return 'calendar_item';
    case 'resources':      return 'resource';
    case 'habit_logs':     return 'habit';   // links via the parent habit
    default:               return null;
  }
}

// ── classification ───────────────────────────────────────────────────────────

interface ProjectRow { id: string; title: string; description: string | null; }

async function listActiveProjects(db: ScopedDb): Promise<ProjectRow[]> {
  const { rows } = await db.query<ProjectRow>(
    `SELECT id, title, description
     FROM objectives
     WHERE user_id = $1
       AND kind = 'project'
       AND deleted_at IS NULL
       AND status IN ('todo', 'in_progress')
     ORDER BY updated_at DESC
     LIMIT 50`,
    [db.userId],
  );
  return rows;
}

const NEW_PROJECT_THRESHOLD = 0.4;
const STRONG_MATCH_THRESHOLD = 0.7;

/**
 * Decide for each proposal whether it belongs to an existing project, is a
 * new project, or stands alone.
 *
 * Strategy:
 *   • Quick rule first: ideas → new (unless a strong substring match exists).
 *     Notes / habit_logs → standalone. Resources → standalone (linkable later).
 *   • For task / event / meeting / reminder, score every project against the
 *     proposal text and apply confidence thresholds.
 *   • If Groq is available, run one JSON call to refine ambiguous picks.
 */
async function classifyProjectLinks(
  proposals: ExtractedItem[],
  projects:  ProjectRow[],
): Promise<Proposal[]> {
  const out: Proposal[] = [];

  for (const p of proposals) {
    const candidates = scoreProjects(p, projects);
    const link: ProjectLink = decideLink(p, candidates);
    out.push({ ...p, project_link: link });
  }

  // Optional AI refinement pass over the unknowns to break ties.
  const ambiguous = out
    .map((p, i) => ({ p, i }))
    .filter(({ p }) => p.project_link.mode === 'unknown' && p.project_link.candidates.length > 0);

  if (ambiguous.length && projects.length && isGroqAvailable()) {
    try {
      await refineWithGroq(out, projects);
    } catch (err) {
      logger.warn({ err }, 'project link refinement failed');
    }
  }

  return out;
}

function decideLink(p: ExtractedItem, candidates: ProjectCandidate[]): ProjectLink {
  if (p.kind === 'note' || p.kind === 'habit_log') {
    return { mode: 'standalone', objective_id: null, candidates };
  }
  if (p.kind === 'idea') {
    const top = candidates[0];
    if (top && top.score >= STRONG_MATCH_THRESHOLD) {
      return { mode: 'existing', objective_id: top.id, candidates };
    }
    return { mode: 'new', objective_id: null, candidates };
  }
  // task / event / meeting / reminder / resource
  const top = candidates[0];
  if (!top) return { mode: 'standalone', objective_id: null, candidates };
  if (top.score >= STRONG_MATCH_THRESHOLD) {
    return { mode: 'existing', objective_id: top.id, candidates };
  }
  if (top.score >= NEW_PROJECT_THRESHOLD) {
    return { mode: 'unknown', objective_id: null, candidates };
  }
  return { mode: 'standalone', objective_id: null, candidates };
}

function scoreProjects(p: ExtractedItem, projects: ProjectRow[]): ProjectCandidate[] {
  const text = `${p.title} ${p.description ?? ''} ${p.raw}`.toLowerCase();
  const tokens = new Set(text.split(/\s+/).filter((w) => w.length > 3));
  const out: ProjectCandidate[] = [];
  for (const proj of projects) {
    const titleLow = proj.title.toLowerCase();
    let score = 0;
    if (text.includes(titleLow)) {
      score += 0.85;
    } else {
      const projTokens = titleLow.split(/\s+/).filter((w) => w.length > 3);
      const overlap = projTokens.filter((t) => tokens.has(t)).length;
      if (projTokens.length) score += (overlap / projTokens.length) * 0.6;
    }
    if (proj.description) {
      const descTokens = proj.description.toLowerCase().split(/\s+/).filter((w) => w.length > 4);
      const hits = descTokens.filter((t) => tokens.has(t)).length;
      if (descTokens.length) score += Math.min(0.3, (hits / descTokens.length) * 0.5);
    }
    if (score > 0.05) out.push({ id: proj.id, title: proj.title, score: Math.min(1, score) });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, 3);
}

async function refineWithGroq(out: Proposal[], projects: ProjectRow[]): Promise<void> {
  const projectList = projects.map((pr, i) => `${i + 1}. [${pr.id}] ${pr.title}`).join('\n');
  const proposalList = out
    .map((p, i) => `${i + 1}. (${p.kind}) ${p.title}${p.description ? ' — ' + p.description : ''}`)
    .join('\n');

  const system = `You assign user inputs to existing projects. Respond ONLY with JSON:
{"assignments":[{"index":N,"project_id":"uuid|null","mode":"existing|new|standalone"}]}
Use "existing" only when the input clearly belongs to one listed project.
Use "new" when it should become its own project.
Use "standalone" for one-off tasks, reminders, notes, or resources unrelated to any project.`;

  const user = `PROJECTS:\n${projectList || '(none)'}\n\nINPUTS:\n${proposalList}\n\nReturn JSON now.`;

  const result = await groqChat(
    [{ role: 'system', content: system }, { role: 'user', content: user }],
    { temperature: 0.1, maxTokens: 500, jsonMode: true },
  );
  const parsed = JSON.parse(result.content) as {
    assignments?: Array<{ index?: number; project_id?: string | null; mode?: string }>;
  };
  if (!Array.isArray(parsed.assignments)) return;

  const validIds = new Set(projects.map((p) => p.id));
  for (const a of parsed.assignments) {
    const i = (a.index ?? 0) - 1;
    const target = out[i];
    if (!target || target.project_link.mode !== 'unknown') continue;
    if (a.mode === 'existing' && a.project_id && validIds.has(a.project_id)) {
      target.project_link = {
        mode: 'existing',
        objective_id: a.project_id,
        candidates: target.project_link.candidates,
      };
    } else if (a.mode === 'new') {
      target.project_link = { mode: 'new', objective_id: null, candidates: target.project_link.candidates };
    } else if (a.mode === 'standalone') {
      target.project_link = { mode: 'standalone', objective_id: null, candidates: target.project_link.candidates };
    }
  }
}

// ── rendering ────────────────────────────────────────────────────────────────

function renderPreview(proposals: Proposal[]): string {
  const lines: string[] = ['*Here\'s what I picked up — confirm before saving:*', ''];
  proposals.forEach((p, i) => {
    const n = i + 1;
    if (p.rejected) {
      lines.push(`~${n}. ${p.title}~  _(dropped)_`);
      return;
    }
    const head = `*${n}.* ${kindIcon(p.kind)} ${escapeMd(p.title)}`;
    const tail = renderProjectLink(p);
    lines.push(`${head}${tail ? '  ' + tail : ''}`);
    if (p.kind === 'idea' && p.structured) {
      const taskCount = p.structured.tasks?.length ?? 0;
      lines.push(`    _${escapeMd(p.structured.summary || p.structured.next_step || '')}_`);
      if (taskCount) lines.push(`    ${taskCount} task${taskCount === 1 ? '' : 's'} ready`);
    } else if (p.description) {
      lines.push(`    _${escapeMd(p.description)}_`);
    }
  });
  lines.push('');
  lines.push('Reply *ok* to save, *cancel* to discard, *x N* to drop one, *N=K* to pick a project.');
  return lines.join('\n');
}

function renderProjectLink(p: Proposal): string {
  const link = p.project_link;
  if (link.mode === 'new') return '→ *new project*';
  if (link.mode === 'standalone') return '→ standalone';
  if (link.mode === 'existing') {
    const cand = link.candidates.find((c) => c.id === link.objective_id);
    return cand ? `→ *${escapeMd(cand.title)}*` : '→ project';
  }
  // unknown — show options
  const opts = link.candidates
    .slice(0, 3)
    .map((c, i) => `${i + 1}) ${escapeMd(c.title)}`)
    .join('  ');
  return `→ ? (${opts || 'no match'}, or =new / =standalone)`;
}

function renderCommitSummary(proposals: Proposal[], results: DispatchResult[]): string {
  const lines: string[] = ['*Saved:*'];
  results.forEach((r, i) => {
    const p = proposals[i]!;
    if (r.ok) {
      const link = p.project_link.mode === 'existing'
        ? ` — linked to ${escapeMd(p.project_link.candidates.find((c) => c.id === p.project_link.objective_id)?.title || 'project')}`
        : p.project_link.mode === 'new'
          ? ' — new project'
          : '';
      lines.push(`✓ ${kindIcon(p.kind)} ${escapeMd(p.title)}${link}`);
    } else {
      lines.push(`✗ ${escapeMd(p.title)} — ${escapeMd(r.error || 'failed')}`);
    }
  });
  return lines.join('\n');
}

function kindIcon(kind: ExtractedItem['kind']): string {
  switch (kind) {
    case 'task':      return '☐';
    case 'note':      return '✎';
    case 'idea':      return '💡';
    case 'event':     return '📅';
    case 'meeting':   return '👥';
    case 'reminder':  return '⏰';
    case 'resource':  return '🔗';
    case 'habit_log': return '✓';
  }
}

const MD_ESCAPE = /([_*[\]()~`>#+\-=|{}.!\\])/g;
function escapeMd(s: string): string {
  return s.replace(MD_ESCAPE, '\\$1');
}

function parseIndices(s: string): number[] {
  return s
    .split(/[\s,]+/)
    .map((x) => parseInt(x, 10))
    .filter((n) => Number.isInteger(n) && n > 0);
}

// ── rate limit (in-memory, per-process) ──────────────────────────────────────

const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX       = 6;
const _attempts = new Map<string, number[]>();

function recordSessionAttempt(userId: string): boolean {
  const now = Date.now();
  const cutoff = now - RATE_LIMIT_WINDOW_MS;
  const stamps = (_attempts.get(userId) ?? []).filter((t) => t > cutoff);
  if (stamps.length >= RATE_LIMIT_MAX) {
    _attempts.set(userId, stamps);
    return false;
  }
  stamps.push(now);
  _attempts.set(userId, stamps);
  return true;
}

// ── session storage ──────────────────────────────────────────────────────────

async function loadOpenSession(
  db:      ScopedDb,
  surface: Surface,
  chatId:  string | null,
): Promise<SessionRow | null> {
  const { rows } = await db.query<SessionRow>(
    `SELECT id, user_id, surface, chat_id, awaiting, pending, expires_at
     FROM assistant_sessions
     WHERE user_id = $1 AND surface = $2
       AND COALESCE(chat_id, '') = COALESCE($3, '')
       AND expires_at > NOW()`,
    [db.userId, surface, chatId],
  );
  return rows[0] ?? null;
}

async function openSession(
  db:      ScopedDb,
  surface: Surface,
  chatId:  string | null,
  pending: SessionPending,
): Promise<SessionRow> {
  // Replace any existing (expired or otherwise) row for this chat.
  await db.query(
    `DELETE FROM assistant_sessions
     WHERE user_id = $1 AND surface = $2 AND COALESCE(chat_id, '') = COALESCE($3, '')`,
    [db.userId, surface, chatId],
  );
  const { rows } = await db.query<SessionRow>(
    `INSERT INTO assistant_sessions (user_id, surface, chat_id, awaiting, pending)
     VALUES ($1, $2, $3, 'confirm_batch', $4::jsonb)
     RETURNING id, user_id, surface, chat_id, awaiting, pending, expires_at`,
    [db.userId, surface, chatId, JSON.stringify(pending)],
  );
  return rows[0]!;
}

async function persistPending(db: ScopedDb, session: SessionRow): Promise<void> {
  await db.query(
    `UPDATE assistant_sessions
     SET pending = $1::jsonb,
         expires_at = NOW() + interval '15 minutes',
         updated_at = NOW()
     WHERE id = $2 AND user_id = $3`,
    [JSON.stringify(session.pending), session.id, db.userId],
  );
}

async function closeSession(db: ScopedDb, sessionId: string): Promise<void> {
  await db.query(
    `DELETE FROM assistant_sessions WHERE id = $1 AND user_id = $2`,
    [sessionId, db.userId],
  );
}

export const _internals = {
  scoreProjects,
  decideLink,
  renderPreview,
  parseIndices,
};
