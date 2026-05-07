/**
 * services/ai/groq.ts — centralized Groq client
 *
 * Provides a singleton Groq instance and a `groqChat()` helper that:
 * - Sends a chat completion request
 * - Returns both the message and token counts (for cost tracking)
 */

import Groq from 'groq-sdk';
import { logger } from '../../lib/logger.js';

const API_KEY = process.env['GROQ_API_KEY'];

// Lazy singleton — only instantiated when used
let _client: Groq | null = null;

export function getGroqClient(): Groq {
  if (!_client) {
    if (!API_KEY) throw new Error('GROQ_API_KEY is not set');
    _client = new Groq({ apiKey: API_KEY });
  }
  return _client;
}

/** Returns true if GROQ_API_KEY is set and usable. */
export function isGroqAvailable(): boolean {
  return Boolean(API_KEY);
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface GroqResult {
  content:           string;
  model:             string;
  prompt_tokens:     number;
  completion_tokens: number;
}

// Default model — use llama-3.3-70b-versatile for quality, gemma2-9b-it for speed
const DEFAULT_MODEL = process.env['GROQ_MODEL'] ?? 'llama-3.3-70b-versatile';

export async function groqChat(
  messages: ChatMessage[],
  opts: { model?: string; temperature?: number; maxTokens?: number; jsonMode?: boolean } = {},
): Promise<GroqResult> {
  const client = getGroqClient();

  const send = async (): Promise<GroqResult> => {
    const completion = await client.chat.completions.create({
      model:       opts.model ?? DEFAULT_MODEL,
      messages,
      temperature: opts.temperature ?? 0.7,
      max_tokens:  opts.maxTokens ?? 1024,
      ...(opts.jsonMode ? { response_format: { type: 'json_object' } } : {}),
    });

    const choice = completion.choices[0];
    if (!choice?.message.content) throw new Error('Empty response from Groq');

    return {
      content:           choice.message.content,
      model:             completion.model,
      prompt_tokens:     completion.usage?.prompt_tokens     ?? 0,
      completion_tokens: completion.usage?.completion_tokens ?? 0,
    };
  };

  try {
    return await send();
  } catch (err) {
    // One retry with a small backoff for transient failures (network, 5xx, rate-limit blips).
    logger.warn(err, 'groqChat first attempt failed — retrying once');
    await new Promise((r) => setTimeout(r, 1500));
    try {
      return await send();
    } catch (err2) {
      logger.error(err2, 'groqChat retry failed');
      throw err2;
    }
  }
}
