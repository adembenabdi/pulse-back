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

/** Scrape Open Graph / meta tags from raw HTML. */
function extractMeta(html: string, sourceUrl: string): { title: string; description: string } {
  const get = (pattern: RegExp) => {
    const m = html.match(pattern);
    return m && m[1] ? m[1].replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim() : '';
  };
  const title =
    get(/property=["']og:title["'][^>]*content=["']([^"']+)["']/i) ||
    get(/content=["']([^"']+)["'][^>]*property=["']og:title["']/i) ||
    get(/<title[^>]*>([^<]+)<\/title>/i) ||
    sourceUrl;
  const description =
    get(/property=["']og:description["'][^>]*content=["']([^"']+)["']/i) ||
    get(/content=["']([^"']+)["'][^>]*property=["']og:description["']/i) ||
    get(/name=["']description["'][^>]*content=["']([^"']+)["']/i) ||
    get(/content=["']([^"']+)["'][^>]*name=["']description["']/i) ||
    '';
  return { title, description };
}

export async function extractResourceFromUrl(url: string): Promise<ExtractedResource> {
  // ── Step 1: always fetch and get meta tags (no AI required) ──────────────
  let html = '';
  try {
    const controller = new AbortController();
    const timeout    = setTimeout(() => controller.abort(), 10_000);
    const response   = await fetch(url, {
      signal:  controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PulseBot/1.0)' },
    });
    clearTimeout(timeout);
    html = await response.text();
  } catch (err) {
    logger.warn({ err, url }, 'extractResourceFromUrl: failed to fetch URL');
  }

  const meta = extractMeta(html, url);

  // ── Step 2: if Groq is available, enrich with AI ─────────────────────────
  if (isGroqAvailable() && html) {
    const pageText = html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 4000);

    try {
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
        title:       parsed.title       || meta.title,
        description: parsed.description || meta.description,
        url:         parsed.url         || url,
        tags:        Array.isArray(parsed.tags) ? parsed.tags : [],
        source_url:  url,
      };
    } catch (err) {
      logger.warn({ err, url }, 'extractResourceFromUrl: AI enrichment failed — falling back to meta tags');
    }
  }

  // ── Fallback: return meta tags only ──────────────────────────────────────
  return {
    title:       meta.title,
    description: meta.description,
    url,
    tags:        [],
    source_url:  url,
  };
}
