import OpenAI from "openai";
import cache from "./cache.js";
import pLimit from "p-limit";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

const DEFAULT_BATCH_SIZE =
  parseInt(process.env.DISTRACTOR_BATCH_SIZE, 10) || 20; // large def
const MAX_CONCURRENCY =
  parseInt(process.env.DISTRACTOR_MAX_CONCURRENCY, 10) || 10;
const CACHE_TTL = parseInt(process.env.DISTRACTOR_CACHE_TTL || "3600", 10); // seconds

function cacheKeyFor(term, correct, count) {
  const key = `distr:${Buffer.from(`${term}||${correct}`).toString(
    "base64"
  )}:${count}`;
  return key;
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

async function generateForSingle(term, correctDefinition, count = 3) {
  if (!term || !correctDefinition) return [];

  const key = cacheKeyFor(term, correctDefinition, count);
  const cached = await cache.get(key);
  if (cached) {
    return cached;
  }

  const prompt = `
You are an assistant that creates plausible but incorrect multiple-choice definitions (distractors).
Generate exactly ${count} wrong definitions for the given term.
- Do NOT repeat the correct definition.
- Keep each distractor short (recommended 6-25 words).
- Avoid synonyms/close paraphrases of the correct definition.
Return a JSON array of strings ONLY. Example: ["wrong one", "wrong two", "wrong three"]

Term: ${term}
Correct definition: ${correctDefinition}
`;

  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const response = await openai.chat.completions.create({
        model: MODEL,
        messages: [
          {
            role: "system",
            content: "You generate plausible wrong multiple-choice options.",
          },
          { role: "user", content: prompt },
        ],
        temperature: 0.75,
        max_tokens: 400,
      });

      const text = response.choices?.[0]?.message?.content?.trim() || "";
      let parsed = safeParseJSONMaybeArray(text).map((s) =>
        typeof s === "string" ? s.trim() : String(s)
      );

      parsed = Array.from(new Set(parsed)).filter(Boolean).slice(0, count);
      while (parsed.length < count) parsed.push(""); 
      // cache
      await cache.set(key, parsed, CACHE_TTL);
      return parsed;
    } catch (err) {
      console.error(
        `generateForSingle attempt ${attempt} failed:`,
        err?.message || err
      );
      if (attempt === maxAttempts) {
        return Array.from({ length: count }, () => "");
      }
      await new Promise((r) => setTimeout(r, 300 * attempt));
    }
  }
  return Array(count).fill("");
}

async function generateDistractorsForItems(items = [], count = 3) {
  if (!Array.isArray(items) || items.length === 0) return {};

  const results = {};
  const limit = pLimit(MAX_CONCURRENCY);
  const batchSize = Math.max(1, DEFAULT_BATCH_SIZE);

  // handle single item
  const processSingle = async (it) => {
    const arr = await generateForSingle(it.term, it.correctDefinition, count);
    results[it.id] = arr;
  };

  const batches = [];
  for (let i = 0; i < items.length; i += batchSize) {
    batches.push(items.slice(i, i + batchSize));
  }

  for (const batch of batches) {
    // if all cached, don't call AI
    const uncached = [];
    for (const it of batch) {
      const key = cacheKeyFor(it.term, it.correctDefinition, count);

      const c = await cache.get(key);
      if (c) {
        results[it.id] = c;
      } else {
        uncached.push(it);
      }
    }

    if (uncached.length === 0) continue;

    // AI call in one batched prompt for the uncached items
    const batchPromptParts = uncached
      .map((it, idx) => {
        return `### ITEM ${idx}
id: ${it.id}
term: ${it.term}
correct: ${it.correctDefinition}
`;
      })
      .join("\n");

    const batchPrompt = `
You are given multiple items. For each item, generate exactly ${count} wrong but plausible definitions (distractors).
Return a JSON object where keys are the ids and values are arrays of strings. Example:
{"q1": ["wrong1","wrong2","wrong3"], "q2": ["w1","w2","w3"]}

Items:
${batchPromptParts}
`;

    let batchedSucceeded = false;
    try {
      const response = await openai.chat.completions.create({
        model: MODEL,
        messages: [
          {
            role: "system",
            content: "You produce JSON mapping ids to distractor arrays.",
          },
          { role: "user", content: batchPrompt },
        ],
        temperature: 0.7,
        max_tokens: Math.min(2000, 400 * uncached.length),
      });

      let text = response.choices?.[0]?.message?.content?.trim() || "";

      text = text
        .replace(/^```json/i, "")
        .replace(/^```/, "")
        .replace(/```$/, "")
        .trim();

      try {
        const parsed = JSON.parse(text);

        for (const it of uncached) {
          const arr = Array.isArray(parsed[it.id])
            ? parsed[it.id].map((s) => String(s).trim())
            : [];
          const unique = Array.from(new Set(arr))
            .filter(Boolean)
            .slice(0, count);
          while (unique.length < count) unique.push("");
          results[it.id] = unique;
          // cache
          const key = cacheKeyFor(it.term, it.correctDefinition, count);
          await cache.set(key, unique, CACHE_TTL);
        }
        batchedSucceeded = true;
      } catch (parseErr) {
        console.warn(
          "[distractorService] Batch parse failed, falling back to single-item generation:",
          parseErr
        );
      }
    } catch (err) {
      console.error(
        "[distractorService] Batch call failed:",
        err?.message || err
      );
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

export { generateDistractorsForItems, generateForSingle };
