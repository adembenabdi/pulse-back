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

// ── oEmbed support ────────────────────────────────────────────────────────────

interface OEmbedResponse {
  title?:        string;
  author_name?:  string;
  html?:         string;
  thumbnail_url?: string;
}

/**
 * Maps URL patterns to their oEmbed endpoint.
 * These all work without authentication.
 */
const OEMBED_PROVIDERS: Array<{ pattern: RegExp; endpoint: string }> = [
  { pattern: /youtube\.com|youtu\.be/,  endpoint: 'https://www.youtube.com/oembed' },
  { pattern: /vimeo\.com/,              endpoint: 'https://vimeo.com/api/oembed.json' },
  { pattern: /twitter\.com|x\.com/,    endpoint: 'https://publish.twitter.com/oembed' },
  { pattern: /tiktok\.com/,            endpoint: 'https://www.tiktok.com/oembed' },
  { pattern: /soundcloud\.com/,        endpoint: 'https://soundcloud.com/oembed' },
  { pattern: /open\.spotify\.com/,     endpoint: 'https://open.spotify.com/oembed' },
];

async function tryOEmbed(url: string): Promise<{ title: string; description: string } | null> {
  const provider = OEMBED_PROVIDERS.find(p => p.pattern.test(url));
  if (!provider) return null;

  try {
    const endpoint = `${provider.endpoint}?url=${encodeURIComponent(url)}&format=json`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8_000);
    const res = await fetch(endpoint, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PulseBot/1.0)' },
    });
    clearTimeout(timeout);
    if (!res.ok) return null;
    const data = await res.json() as OEmbedResponse;
    // Extract plain text from the embedded HTML if present
    const htmlText = data.html
      ? data.html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 500)
      : '';
    const title = data.title ?? '';
    const description = htmlText || (data.author_name ? `By ${data.author_name}` : '');
    return { title, description };
  } catch {
    return null;
  }
}

/**
 * Threads and Instagram serve full SSR content (including post text in og:description)
 * when the request comes from Meta's own crawler user agent.
 */
async function fetchSocialPage(url: string): Promise<string> {
  const agents = [
    'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
    'Twitterbot/1.0',
    'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
  ];
  for (const ua of agents) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10_000);
      const res = await fetch(url, {
        signal:  controller.signal,
        headers: { 'User-Agent': ua },
      });
      clearTimeout(timeout);
      if (!res.ok) continue;
      const html = await res.text();
      // Check we got actual content, not a login wall
      if (html.includes('og:description') || html.includes('og:title')) return html;
    } catch { /* try next */ }
  }
  return '';
}

/**
 * For URLs where scraping is blocked and oEmbed fails,
 * build a minimal description from the URL path itself.
 */
function describeFromUrl(url: string): { title: string; description: string } {
  try {
    const u = new URL(url);
    const parts = u.pathname.split('/').filter(Boolean);
    // e.g. threads.net/@username/post/abc → "Post by @username"
    if (u.hostname.includes('threads.net') || u.hostname.includes('instagram.com')) {
      const username = parts.find(p => p.startsWith('@')) ?? parts[0] ?? '';
      return {
        title:       `${u.hostname.includes('threads') ? 'Threads' : 'Instagram'} post${username ? ` by ${username}` : ''}`,
        description: `Shared from ${u.hostname}`,
      };
    }
    const slug = parts[parts.length - 1]?.replace(/[-_]/g, ' ') ?? '';
    return {
      title:       slug ? slug.charAt(0).toUpperCase() + slug.slice(1) : u.hostname,
      description: `From ${u.hostname}`,
    };
  } catch {
    return { title: url, description: '' };
  }
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
  const isSocial = /threads\.net|instagram\.com/.test(url);

  // ── Step 1: fetch HTML ────────────────────────────────────────────────────
  // Social sites need special crawler user agents to get SSR content with post text
  let html = '';
  if (isSocial) {
    html = await fetchSocialPage(url);
  } else {
    // Try oEmbed first for known platforms (YouTube, Twitter, etc.)
    const oEmbed = await tryOEmbed(url);
    if (oEmbed) {
      // If oEmbed gave us real content, skip scraping unless AI can enrich it
      if (!isGroqAvailable() || !oEmbed.description) {
        return { title: oEmbed.title, description: oEmbed.description, url, tags: [], source_url: url };
      }
      // Feed oEmbed content into AI for tags
      const result = await tryAiEnrich(`Source URL: ${url}\n\n${oEmbed.title}\n${oEmbed.description}`);
      return {
        title:       result?.title       || oEmbed.title,
        description: result?.description || oEmbed.description,
        url:         result?.url         || url,
        tags:        result?.tags        ?? [],
        source_url:  url,
      };
    }
    // Regular page scrape
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
  }

  // ── Step 2: extract meta tags ─────────────────────────────────────────────
  const meta = html ? extractMeta(html, url) : describeFromUrl(url);

  // ── Step 3: build page text for AI ───────────────────────────────────────
  // For social pages we only use meta description (that's where post text lives)
  // For regular pages we also strip and pass body text
  const pageText = isSocial
    ? `Post URL: ${url}\nTitle: ${meta.title}\nContent: ${meta.description}`
    : html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 4000);

  // ── Step 4: AI enrichment ─────────────────────────────────────────────────
  if (isGroqAvailable() && pageText) {
    const result = await tryAiEnrich(`Source URL: ${url}\n\n${pageText}`);
    if (result) {
      return {
        title:       result.title       || meta.title,
        description: result.description || meta.description,
        url:         result.url         || url,
        tags:        result.tags        ?? [],
        source_url:  url,
      };
    }
  }

  // ── Fallback ──────────────────────────────────────────────────────────────
  return { title: meta.title, description: meta.description, url, tags: [], source_url: url };
}

async function tryAiEnrich(content: string): Promise<{ title: string; description: string; url: string; tags: string[] } | null> {
  try {
    const result = await groqChat(
      [
        { role: 'system', content: EXTRACT_PROMPT },
        { role: 'user',   content },
      ],
      { temperature: 0.3, maxTokens: 500, jsonMode: true },
    );
    let parsed: { title?: string; description?: string; url?: string; tags?: string[] };
    try {
      parsed = JSON.parse(result.content);
    } catch {
      const m = result.content.match(/\{[\s\S]*\}/);
      if (!m) return null;
      parsed = JSON.parse(m[0]);
    }
    return {
      title:       parsed.title       ?? '',
      description: parsed.description ?? '',
      url:         parsed.url         ?? '',
      tags:        Array.isArray(parsed.tags) ? parsed.tags : [],
    };
  } catch (err) {
    logger.warn({ err }, 'tryAiEnrich failed');
    return null;
  }
}
