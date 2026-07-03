/**
 * chat.ts — Stateless RAG chat endpoint
 *
 * POST /api/chat
 * Body: { articleId: number, storyId: number | null, question: string }
 *
 * Context strategy:
 *   - Re-runs the same timeline dedup logic as GET /api/stories/:id/timeline
 *   - Fetches full_text for each timeline article
 *   - Builds a system prompt with the current article text first (up to 2500 chars),
 *     then remaining timeline articles (budget split evenly across them)
 *   - Calls Cerebras zai-glm-4.7 (via the existing OpenAI-compatible client)
 *   - Returns { answer: string }
 *
 * Stateless by design — no chat history, no DB writes.
 */

import { Router } from 'express';
import { pool } from '../db/index.js';
import OpenAI from 'openai';

const router = Router();

const TIMELINE_WINDOW_DAYS = 14;
const TIMELINE_DEDUP_THRESHOLD = 0.85;

// Reuse the same Cerebras client setup as cerebrasClient.ts
const cerebras = new OpenAI({
  apiKey: process.env.CEREBRAS_API_KEY,
  baseURL: 'https://api.cerebras.ai/v1',
});

// ── Helpers ──────────────────────────────────────────────────────────────────

function cosineSim(a: number[], b: number[]): number {
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot  += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  if (magA === 0 || magB === 0) return 0;
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

function parseEmb(raw: string | null): number[] | null {
  if (!raw) return null;
  try { return typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { return null; }
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
  });
}

// ── Timeline dedup (mirrors stories.ts) ──────────────────────────────────────

async function getTimelineArticleIds(storyId: number, currentArticleId: number): Promise<number[]> {
  const candidatesRes = await pool.query<{
    id: number;
    published_at: string;
    embedding: string | null;
    day_rank: number;
  }>(
    `SELECT * FROM (
       SELECT a.id, a.published_at, a.embedding,
              ROW_NUMBER() OVER (
                PARTITION BY DATE(a.published_at AT TIME ZONE 'UTC')
                ORDER BY a.importance_score DESC NULLS LAST, a.published_at DESC
              ) AS day_rank
       FROM articles a
       WHERE a.story_id = $1
         AND a.published_at >= NOW() - INTERVAL '${TIMELINE_WINDOW_DAYS} days'
     ) sub
     WHERE sub.day_rank <= 4
     ORDER BY sub.published_at DESC`,
    [storyId]
  );

  const selectedPerDay = new Map<string, number>();
  const selectedEmbeddings: number[][] = [];
  const result: number[] = [];

  // Pin the current article first
  const pinned = candidatesRes.rows.find(r => r.id === currentArticleId);
  if (pinned) {
    const emb = parseEmb(pinned.embedding);
    if (emb) selectedEmbeddings.push(emb);
    const day = pinned.published_at.toString().substring(0, 10);
    selectedPerDay.set(day, (selectedPerDay.get(day) ?? 0) + 1);
    result.push(pinned.id);
  }

  // Dedup remaining candidates
  for (const row of candidatesRes.rows) {
    if (row.id === currentArticleId) continue;

    const day = row.published_at.toString().substring(0, 10);
    const dayCount = selectedPerDay.get(day) ?? 0;
    if (dayCount >= 2) continue;

    const emb = parseEmb(row.embedding);
    if (emb && selectedEmbeddings.length > 0) {
      const isDuplicate = selectedEmbeddings.some(sel => cosineSim(emb!, sel) >= TIMELINE_DEDUP_THRESHOLD);
      if (isDuplicate) continue;
    }

    if (emb) selectedEmbeddings.push(emb);
    selectedPerDay.set(day, dayCount + 1);
    result.push(row.id);
  }

  // Sort chronologically (newest first — matches UI)
  const idToDate = new Map(candidatesRes.rows.map(r => [r.id, r.published_at]));
  result.sort((a, b) => new Date(idToDate.get(b) ?? 0).getTime() - new Date(idToDate.get(a) ?? 0).getTime());

  return result;
}

// ── Build RAG context ─────────────────────────────────────────────────────────

interface ArticleContext {
  id: number;
  title: string;
  published_at: string;
  text: string; // full_text || content || description
}

async function buildContext(
  currentArticleId: number,
  timelineIds: number[],
): Promise<{ current: ArticleContext; others: ArticleContext[] }> {
  if (timelineIds.length === 0) {
    // Fallback: just fetch the current article alone
    const r = await pool.query<{ id: number; title: string; published_at: string; full_text: string | null; content: string | null; description: string | null }>(
      `SELECT id, title, published_at, full_text, content, description FROM articles WHERE id = $1`,
      [currentArticleId]
    );
    const row = r.rows[0];
    const text = row?.full_text || row?.content || row?.description || '';
    return {
      current: { id: currentArticleId, title: row?.title ?? '', published_at: row?.published_at ?? '', text },
      others: [],
    };
  }

  const rows = await pool.query<{ id: number; title: string; published_at: string; full_text: string | null; content: string | null; description: string | null }>(
    `SELECT id, title, published_at, full_text, content, description FROM articles WHERE id = ANY($1)`,
    [timelineIds]
  );

  const byId = new Map(rows.rows.map(r => [r.id, r]));

  const toCtx = (id: number): ArticleContext => {
    const r = byId.get(id);
    return {
      id,
      title: r?.title ?? `Article ${id}`,
      published_at: r?.published_at ?? '',
      text: r?.full_text || r?.content || r?.description || '',
    };
  };

  const current = toCtx(currentArticleId);
  const others = timelineIds.filter(id => id !== currentArticleId).map(toCtx);

  return { current, others };
}

// ── System prompt builder ─────────────────────────────────────────────────────

const CURRENT_ARTICLE_BUDGET = 2500;
const OTHERS_TOTAL_BUDGET = 3500;

function buildSystemPrompt(current: ArticleContext, others: ArticleContext[]): string {
  const perOther = others.length > 0 ? Math.floor(OTHERS_TOTAL_BUDGET / others.length) : 0;

  const currentSnippet = current.text.slice(0, CURRENT_ARTICLE_BUDGET);

  const otherSnippets = others.map((a, i) => {
    const snippet = a.text.slice(0, perOther);
    return `CONTEXT — Timeline Article ${i + 2}: "${a.title}" (${formatDate(a.published_at)})\n${snippet}`;
  }).join('\n\n');

  return `You are a news analyst assistant. Answer the user's question ONLY based on the article context provided below. Do NOT use any outside knowledge or information not present in the context. If the answer cannot be found in the context, respond with: "I don't have enough information from these articles to answer that."

Keep your answer concise and grounded in the source text.

CONTEXT — Current Article (what the user is reading): "${current.title}" (${formatDate(current.published_at)})
${currentSnippet}${others.length > 0 ? `\n\n${otherSnippets}` : ''}`;
}

// ── Route ─────────────────────────────────────────────────────────────────────

router.post('/', async (req, res) => {
  try {
    const { articleId, storyId, question, history } = req.body as {
      articleId?: number;
      storyId?: number | null;
      question?: string;
      history?: Array<{ role: 'user' | 'assistant'; content: string }>;
    };

    if (!articleId || typeof articleId !== 'number') {
      return res.status(400).json({ error: 'articleId is required' });
    }
    if (!question || typeof question !== 'string' || question.trim().length === 0) {
      return res.status(400).json({ error: 'question is required' });
    }

    // Sanitize history: only allow valid roles, cap at 10 messages (5 pairs)
    const safeHistory = (Array.isArray(history) ? history : [])
      .filter(m => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
      .slice(-10);

    console.log(`[CHAT] articleId=${articleId} storyId=${storyId} historyLen=${safeHistory.length} question="${question.slice(0, 60)}"`);

    // Determine which article IDs are in the timeline
    let timelineIds: number[] = [articleId];
    if (storyId && typeof storyId === 'number') {
      timelineIds = await getTimelineArticleIds(storyId, articleId);
    }
    console.log(`[CHAT] timeline ids: ${timelineIds.join(', ')}`);

    // Fetch text for each article
    const { current, others } = await buildContext(articleId, timelineIds);
    console.log(`[CHAT] current article: "${current.title}" (${current.text.length} chars), ${others.length} others`);

    // Build RAG system prompt
    const systemPrompt = buildSystemPrompt(current, others);
    console.log(`[CHAT] system prompt length: ${systemPrompt.length} chars`);

    // Build messages: system → history (last 5 Q&A) → current question
    const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
      { role: 'system', content: systemPrompt },
      ...safeHistory,
      { role: 'user', content: question.trim() },
    ];

    // Call Cerebras — MUST use max_tokens 4096+, model uses 1000+ reasoning tokens
    const response = await cerebras.chat.completions.create({
      model: 'zai-glm-4.7',
      messages,
      temperature: 0.3,
      max_tokens: 4096,
    });

    const answer = response.choices[0]?.message?.content;
    console.log(`[CHAT] answer length: ${answer?.length ?? 0}`);

    if (!answer) {
      console.error('[CHAT] Empty response from model. Finish reason:', response.choices[0]?.finish_reason);
      return res.status(500).json({ error: 'Model returned empty response' });
    }

    return res.json({ answer });
  } catch (err) {
    console.error('[CHAT] Error:', err);
    return res.status(500).json({ error: 'Failed to generate response' });
  }
});


export default router;
