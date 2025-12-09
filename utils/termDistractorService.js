import OpenAI from "openai";
import cache from "./cache.js";
import pLimit from "p-limit";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

const DEFAULT_BATCH_SIZE =
  parseInt(process.env.DISTRACTOR_BATCH_SIZE, 10) || 20;
const MAX_CONCURRENCY =
  parseInt(process.env.DISTRACTOR_MAX_CONCURRENCY, 10) || 10;
const CACHE_TTL = parseInt(process.env.DISTRACTOR_CACHE_TTL || "3600", 10); // seconds

function cacheKeyForTerm(term, count) {
  return `termDistr:${Buffer.from(term).toString("base64")}:${count}`;
}

function safeParseJSONMaybeArray(text) {
  if (!text) return [];

  text = text
    .replace(/^```json/i, "")
    .replace(/^```/, "")
    .replace(/```$/, "")
    .trim();

  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed;
    if (parsed && typeof parsed === "object") {
      return Object.values(parsed).flat();
    }
  } catch (err) {}

  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const cleaned = lines.map((l) =>
    l
      .replace(/^[0-9\)\.\-\s]+/, "")
      .replace(/^"(.*)"$/, "$1")
      .trim()
  );
  return cleaned;
}

async function generateTermForSingle(term, count = 3) {
  if (!term) return [];

  const key = cacheKeyForTerm(term, count);
  const cached = await cache.get(key);
  if (cached) return cached;

  const prompt = `
You are an assistant that generates plausible but incorrect terms or concepts for multiple-choice questions.

Generate exactly ${count} wrong terms for the given correct term.
- Do NOT repeat the correct term.
- Avoid synonyms/very close paraphrases of the correct term.
- Keep terms concise and phrase-like.

Return a JSON array of strings ONLY. Example: ["wrong1", "wrong2", "wrong3"]

No comments, no explanations, only the JSON object.

Correct term: ${term}
`;

  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const response = await openai.chat.completions.create({
        model: MODEL,
        messages: [
          { role: "system", content: "You generate plausible wrong multiple-choice terms." },
          { role: "user", content: prompt },
        ],
        temperature: 0.75,
        max_tokens: 200,
      });

      const text = response.choices?.[0]?.message?.content?.trim() || "";
      let parsed = safeParseJSONMaybeArray(text).map((s) =>
        typeof s === "string" ? s.trim() : String(s)
      );

      parsed = Array.from(new Set(parsed)).filter(Boolean).slice(0, count);
      while (parsed.length < count) parsed.push("");

      await cache.set(key, parsed, CACHE_TTL);

      return parsed;
    } catch (err) {
      console.error(`generateTermForSingle attempt ${attempt} failed:`, err?.message || err);
      if (attempt === maxAttempts) return Array.from({ length: count }, () => "");
      await new Promise((r) => setTimeout(r, 300 * attempt));
    }
  }

  return Array(count).fill("");
}

async function generateTermDistractorsForItems(items = [], count = 3) {
  if (!Array.isArray(items) || items.length === 0) return {};

  const results = {};
  const limit = pLimit(MAX_CONCURRENCY);
  const batchSize = Math.max(1, DEFAULT_BATCH_SIZE);

  const processSingle = async (it) => {
    const arr = await generateTermForSingle(it.term, count);
    results[it.id] = arr;
  };

  const batches = [];
  for (let i = 0; i < items.length; i += batchSize) {
    batches.push(items.slice(i, i + batchSize));
  }

  for (const batch of batches) {
    const uncached = [];
    for (const it of batch) {
      const key = cacheKeyForTerm(it.term, count);
      const c = await cache.get(key);
      if (c) {
        results[it.id] = c;
      } else {
        uncached.push(it);
      }
    }

    if (uncached.length === 0) continue;


    const batchPromptParts = uncached
      .map((it, idx) => {
        return `### ITEM ${idx}\nid: ${it.id}\nterm: ${it.term}\n`;
      })
      .join("\n");

    const batchPrompt = `
You are given multiple items. For each item, generate exactly ${count} wrong but plausible terms.

Rules:
- Do NOT repeat the correct term.
- Avoid synonyms/very close paraphrases.
- Keep them concise, phrase-like.

Return a JSON object where keys are the ids and values are arrays of strings. Example:
{"q1": ["wrong1","wrong2","wrong3"], "q2": ["w1","w2","w3"]}

No comments, no explanations, only the JSON object.

Items:
${batchPromptParts}
`;

    let batchedSucceeded = false;
    try {
      const response = await openai.chat.completions.create({
        model: MODEL,
        messages: [
          { role: "system", content: "You produce JSON mapping ids to term distractor arrays." },
          { role: "user", content: batchPrompt },
        ],
        temperature: 0.7,
        max_tokens: Math.min(2000, 150 * uncached.length),
      });

      let text = response.choices?.[0]?.message?.content?.trim() || "";
      text = text.replace(/^```json/i, "").replace(/^```/, "").replace(/```$/, "").trim();

      try {
        const parsed = JSON.parse(text);

        for (const it of uncached) {
          const arr = Array.isArray(parsed[it.id])
            ? parsed[it.id].map((s) => String(s).trim())
            : [];
          const unique = Array.from(new Set(arr)).filter(Boolean).slice(0, count);
          while (unique.length < count) unique.push("");
          results[it.id] = unique;

          const key = cacheKeyForTerm(it.term, count);
          await cache.set(key, unique, CACHE_TTL);
        }
        batchedSucceeded = true;
      } catch (parseErr) {
        console.warn(
          "[termDistractorService] Batch parse failed, falling back to single-item generation:",
          parseErr
        );
      }
    } catch (err) {
      console.error("[termDistractorService] Batch call failed:", err?.message || err);
    }

    if (!batchedSucceeded) {
      await Promise.all(uncached.map((it) => limit(() => processSingle(it))));
    }
  }

  for (const it of items) {
    if (!results[it.id]) results[it.id] = Array(count).fill("");
  }

  return results;
}

export { generateTermDistractorsForItems, generateTermForSingle };
