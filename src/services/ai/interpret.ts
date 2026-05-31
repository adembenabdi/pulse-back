/**
 * services/ai/interpret.ts
 *
 * Classifies a free-form message into either:
 *  - a CAPTURE (one or more task / idea / event items), or
 *  - a QUERY (an open-ended question about the user's data).
 */

import { groqChat, isGroqAvailable } from './groq.js';
import { logger } from '../../lib/logger.js';

export type CaptureItem =
  | {
      type: 'task';
      title: string;
      notes?: string | null;
      priority?: 'low' | 'medium' | 'high' | 'urgent' | null;
      due_at?: string | null;       // ISO 8601
      project_name?: string | null; // existing or new project to attach to
    }
  | {
      type: 'idea';
      title: string;
      raw_text?: string | null;
    }
  | {
      type: 'event';
      title: string;
      starts_at: string;            // ISO 8601
      ends_at?: string | null;
      location?: string | null;
      description?: string | null;
    };

export interface Interpretation {
  mode: 'capture' | 'query';
  items: CaptureItem[];
  question: string | null;
}

interface InterpretContext {
  timezone: string;
  nowIso: string;
  projectNames: string[];
}

function buildSystem(ctx: InterpretContext): string {
  return `You are the brain of a personal productivity assistant. Decide what the user wants.

Current date-time (user timezone ${ctx.timezone}): ${ctx.nowIso}
Existing projects: ${ctx.projectNames.length ? ctx.projectNames.join(', ') : '(none yet)'}

Return ONLY valid JSON (no markdown) with this shape:
{
  "mode": "capture" | "query",
  "items": [ ...CaptureItem ],   // present when mode = "capture"
  "question": "the user's question"  // present when mode = "query"
}

CaptureItem variants:
- Task:  { "type": "task", "title": str, "notes": str|null, "priority": "low|medium|high|urgent"|null, "due_at": ISO|null, "project_name": str|null }
- Idea:  { "type": "idea", "title": str, "raw_text": str|null }
- Event: { "type": "event", "title": str, "starts_at": ISO, "ends_at": ISO|null, "location": str|null, "description": str|null }

Rules:
- If the message ASKS something (e.g. "what's due this week?", "show my incomplete prayers"), mode = "query" and copy the question.
- If the message STATES things to capture, mode = "capture". One message may contain MULTIPLE items.
- "task" = an actionable to-do. Attach to a project_name if one is clearly implied; reuse an existing project name when it matches.
- "idea" = a concept/thought to explore later.
- "event" = something at a specific time (meeting, appointment, class). Always resolve relative dates ("tomorrow 2pm") to absolute ISO 8601 in the user's timezone.
- Default priority to null unless implied. Never invent times for tasks unless a deadline is given.
- Output JSON only.`;
}

function emptyQuery(text: string): Interpretation {
  return { mode: 'query', items: [], question: text };
}

export async function interpret(
  text: string,
  ctx: InterpretContext,
): Promise<Interpretation> {
  if (!isGroqAvailable()) {
    // Without AI, treat everything as a single task capture.
    return { mode: 'capture', items: [{ type: 'task', title: text }], question: null };
  }

  try {
    const { content } = await groqChat(
      [
        { role: 'system', content: buildSystem(ctx) },
        { role: 'user', content: text },
      ],
      { temperature: 0.2, maxTokens: 1400, jsonMode: true },
    );

    const parsed = JSON.parse(content) as Partial<Interpretation>;
    if (parsed.mode === 'query') {
      return emptyQuery(typeof parsed.question === 'string' ? parsed.question : text);
    }

    const items = Array.isArray(parsed.items)
      ? parsed.items.filter((i): i is CaptureItem => Boolean(i) && typeof (i as CaptureItem).type === 'string')
      : [];

    if (items.length === 0) return emptyQuery(text);
    return { mode: 'capture', items, question: null };
  } catch (err) {
    logger.error(err, 'interpret failed — falling back to query');
    return emptyQuery(text);
  }
}
