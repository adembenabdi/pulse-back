/**
 * services/ai/idea-organize.ts
 *
 * Takes a freeform idea (title + optional raw description) and asks Groq to
 * return a structured plan: clean summary, actionable tasks, materials,
 * creative extra features, risks, and a recommended next step.
 *
 * Used by:
 *   - POST /api/ideas/organize          (preview, no save)
 *   - POST /api/ideas/:id/organize      (persist on an existing idea)
 *   - POST /api/ideas (when called with `auto_organize: true`)
 */

import { groqChat, isGroqAvailable } from './groq.js';
import { logger } from '../../lib/logger.js';

export interface OrganizedTask {
  title:       string;
  effort_min:  number;
  priority:    'low' | 'medium' | 'high';
  done:        boolean;
}

export interface OrganizedMaterial {
  name:     string;
  category: 'tool' | 'service' | 'hardware' | 'knowledge' | 'other';
  note:     string;
}

export interface OrganizedFeature {
  title:       string;
  description: string;
}

export interface OrganizedIdea {
  summary:         string;
  target_audience: string;
  tasks:           OrganizedTask[];
  materials:       OrganizedMaterial[];
  extra_features:  OrganizedFeature[];
  risks:           string[];
  next_step:       string;
  generated_at:    string;
}

const SYSTEM_PROMPT = `You are an elite project planning assistant. The user will describe an idea or project.
You must return ONLY valid JSON (no markdown, no code fences) with EXACTLY this structure:
{
  "summary":         "A clear, well-written 2-4 sentence summary of the idea",
  "target_audience": "1 sentence describing who this is for",
  "tasks": [
    {"title": "Actionable step", "effort_min": 30, "priority": "high", "done": false}
  ],
  "materials": [
    {"name": "...", "category": "tool|service|hardware|knowledge|other", "note": "1 short sentence"}
  ],
  "extra_features": [
    {"title": "Feature name", "description": "1-2 sentences of what it adds"}
  ],
  "risks":     ["short risk or pitfall", "..."],
  "next_step": "The single most important thing to do RIGHT NOW (1 sentence)"
}

Rules:
- 5 to 10 tasks, ordered logically from first to last, each starting with a verb.
- effort_min is a realistic minute estimate (5..480). priority is one of low|medium|high.
- materials: 0 to 8 items. Only include if genuinely needed.
- extra_features: 3 to 6 creative directions the user probably hasn't thought of.
- risks: 2 to 5 short, concrete risks (not generic platitudes).
- Keep everything practical, specific, and concise. NO filler.
- Return ONLY the JSON object. No prose before or after.`;

function parseJson(raw: string): unknown {
  try { return JSON.parse(raw); } catch { /* fallthrough */ }
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('AI returned invalid JSON');
  return JSON.parse(match[0]);
}

function clampInt(n: unknown, min: number, max: number, fallback: number): number {
  const v = typeof n === 'number' && Number.isFinite(n) ? Math.round(n) : fallback;
  return Math.max(min, Math.min(max, v));
}

function asString(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v.trim() : fallback;
}

function normalize(raw: unknown): OrganizedIdea {
  const r = (raw ?? {}) as Record<string, unknown>;
  const tasksIn     = Array.isArray(r['tasks'])          ? r['tasks']          : [];
  const materialsIn = Array.isArray(r['materials'])      ? r['materials']      : [];
  const featuresIn  = Array.isArray(r['extra_features']) ? r['extra_features'] : [];
  const risksIn     = Array.isArray(r['risks'])          ? r['risks']          : [];

  return {
    summary:         asString(r['summary']),
    target_audience: asString(r['target_audience']),
    tasks: tasksIn.slice(0, 12).map((t): OrganizedTask => {
      const o = (typeof t === 'string' ? { title: t } : (t ?? {})) as Record<string, unknown>;
      const pr = asString(o['priority'], 'medium').toLowerCase();
      return {
        title:      asString(o['title']),
        effort_min: clampInt(o['effort_min'], 5, 480, 30),
        priority:   (pr === 'low' || pr === 'high' ? pr : 'medium') as 'low' | 'medium' | 'high',
        done:       !!o['done'],
      };
    }).filter(t => t.title.length > 0),
    materials: materialsIn.slice(0, 10).map((m): OrganizedMaterial => {
      const o = (typeof m === 'string' ? { name: m } : (m ?? {})) as Record<string, unknown>;
      const cat = asString(o['category'], 'other').toLowerCase();
      const allowed: OrganizedMaterial['category'][] = ['tool', 'service', 'hardware', 'knowledge', 'other'];
      return {
        name:     asString(o['name']),
        category: (allowed.includes(cat as OrganizedMaterial['category'])
                    ? cat
                    : 'other') as OrganizedMaterial['category'],
        note:     asString(o['note']),
      };
    }).filter(m => m.name.length > 0),
    extra_features: featuresIn.slice(0, 8).map((f): OrganizedFeature => {
      const o = (typeof f === 'string' ? { title: f, description: '' } : (f ?? {})) as Record<string, unknown>;
      return {
        title:       asString(o['title']),
        description: asString(o['description']),
      };
    }).filter(f => f.title.length > 0),
    risks: risksIn.map(v => asString(v)).filter(s => s.length > 0).slice(0, 6),
    next_step:    asString(r['next_step']),
    generated_at: new Date().toISOString(),
  };
}

export async function organizeIdea(input: { title: string; description?: string | null }): Promise<OrganizedIdea> {
  if (!isGroqAvailable()) throw new Error('AI service not configured');

  const userMsg = `Title: ${input.title}\n\nDescription:\n${input.description?.trim() || '(no description provided — use the title to infer intent)'}`;

  const result = await groqChat(
    [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user',   content: userMsg },
    ],
    { temperature: 0.7, maxTokens: 2000, jsonMode: true },
  );

  let parsed: unknown;
  try {
    parsed = parseJson(result.content);
  } catch (err) {
    logger.error({ err, raw: result.content }, 'organizeIdea: invalid JSON from Groq');
    throw new Error('AI returned invalid JSON');
  }
  return normalize(parsed);
}
