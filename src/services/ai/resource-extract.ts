/**
 * services/ai/resource-extract.ts
 *
 * Fetches a URL, scrapes its text content, and asks Groq to return a
 * structured resource summary { title, description, url, tags }.
 *
 * Used by:
 *   - POST /api/knowledge/resources/extract  (web UI)
 *   - Telegram bot (auto-save shared links)
 */

import { groqChat, isGroqAvailable } from './groq.js';
import { logger } from '../../lib/logger.js';

const EXTRACT_PROMPT = `You are a resource extraction assistant. The user will give you the text content scraped from a web page.
You must return ONLY valid JSON (no markdown, no code fences) with exactly this structure:
{
  "title": "A short, clear title for this resource (max 10 words)",
  "description": "One concise sentence describing what this resource is or does",
  "url": "The most important link found (GitHub repo, website, tool URL, etc.) or empty string if none",
  "tags": ["tag1", "tag2", "tag3"]
}
Rules:
- title should be descriptive but short
- description must be ONE sentence only, max 20 words
- url should be the main resource link (not the source page itself), empty string if none found
- tags should be 2-5 relevant keywords (lowercase)
- Return ONLY the JSON object, nothing else`;

export interface ExtractedResource {
  title:       string;
  description: string;
  url:         string;
  tags:        string[];
  source_url:  string;
}

/** Detect first http(s) URL in arbitrary text. */
export function findUrl(text: string): string | null {
  const m = text.match(/https?:\/\/[^\s]+/i);
  return m ? m[0] : null;
}

export async function extractResourceFromUrl(url: string): Promise<ExtractedResource> {
  if (!isGroqAvailable()) throw new Error('AI service not configured');

  let pageText = '';
  try {
    const controller = new AbortController();
    const timeout    = setTimeout(() => controller.abort(), 10_000);
    const response   = await fetch(url, {
      signal:  controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PulseBot/1.0)' },
    });
    clearTimeout(timeout);
    const html = await response.text();
    pageText = html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 4000);
  } catch (err) {
    logger.warn({ err, url }, 'extractResourceFromUrl: failed to fetch URL');
    pageText = `URL: ${url}`;
  }

  const result = await groqChat(
    [
      { role: 'system', content: EXTRACT_PROMPT },
      { role: 'user',   content: `Source URL: ${url}\n\nPage content:\n${pageText}` },
    ],
    { temperature: 0.3, maxTokens: 500, jsonMode: true },
  );

  let parsed: { title?: string; description?: string; url?: string; tags?: string[] };
  try {
    parsed = JSON.parse(result.content);
  } catch {
    const m = result.content.match(/\{[\s\S]*\}/);
    if (!m) throw new Error('AI returned invalid JSON');
    parsed = JSON.parse(m[0]);
  }

  return {
    title:       parsed.title       ?? '',
    description: parsed.description ?? '',
    url:         parsed.url         || url,
    tags:        Array.isArray(parsed.tags) ? parsed.tags : [],
    source_url:  url,
  };
}
