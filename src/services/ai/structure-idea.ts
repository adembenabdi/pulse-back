/**
 * services/ai/structure-idea.ts
 *
 * Turns a raw idea (title + free text) into a structured plan:
 *   { overview, steps: [{ title, done }], resources: [string], notes }
 */

import { groqChat, isGroqAvailable } from './groq.js';
import { logger } from '../../lib/logger.js';

export interface IdeaStep {
  title: string;
  done:  boolean;
}

export interface StructuredIdea {
  overview:  string;
  steps:     IdeaStep[];
  resources: string[];
  notes:     string;
  generated_at: string;
}

const SYSTEM = `You are an idea-structuring assistant. Given a raw idea, return a JSON object that helps the user pursue it.

Return ONLY valid JSON (no markdown) with this exact shape:
{
  "overview": "2-4 sentence global summary of the idea and its value",
  "steps": [{ "title": "concrete actionable step", "done": false }],   // 4-8 steps, ordered
  "resources": ["required resource, tool, skill or prerequisite"],     // 0-8 short strings
  "notes": "a short paragraph of considerations, risks or open questions to expand later"
}

Be concrete and practical. Do not include any text outside the JSON.`;

/** Naive fallback when Groq is unavailable. */
function fallback(title: string, raw: string): StructuredIdea {
  return {
    overview: raw || title,
    steps: [{ title: 'Define the first concrete step', done: false }],
    resources: [],
    notes: 'AI structuring unavailable — fill this in manually.',
    generated_at: new Date().toISOString(),
  };
}

export async function structureIdea(title: string, rawText?: string | null): Promise<StructuredIdea> {
  const raw = (rawText ?? '').trim();
  if (!isGroqAvailable()) return fallback(title, raw);

  try {
    const { content } = await groqChat(
      [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: `Title: ${title}\n\nIdea:\n${raw || title}` },
      ],
      { temperature: 0.4, maxTokens: 1200, jsonMode: true },
    );

    const parsed = JSON.parse(content) as Partial<StructuredIdea>;
    return {
      overview:  typeof parsed.overview === 'string' ? parsed.overview : (raw || title),
      steps:     Array.isArray(parsed.steps)
        ? parsed.steps
            .filter((s) => s && typeof (s as IdeaStep).title === 'string')
            .map((s) => ({ title: (s as IdeaStep).title, done: Boolean((s as IdeaStep).done) }))
        : [],
      resources: Array.isArray(parsed.resources)
        ? parsed.resources.filter((r): r is string => typeof r === 'string')
        : [],
      notes:     typeof parsed.notes === 'string' ? parsed.notes : '',
      generated_at: new Date().toISOString(),
    };
  } catch (err) {
    logger.error(err, 'structureIdea failed — using fallback');
    return fallback(title, raw);
  }
}
