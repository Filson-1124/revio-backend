import { generateTermDistractorsForItems } from "../utils/termDistractorService.js";

export async function postTermDistractors(req, res) {
  try {
    const body = req.body || {};
    const items = body.items;
   
    const count = Math.min(Math.max(parseInt(body.count || 3, 10) || 3, 1), 6);

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({
        error: "Missing items array. Expected [{ id, term }]",
      });
    }

    const safeItems = items.map((it) => ({
      id: String(it.id || "").trim(),
      term: String(it.term || "").trim(),
    }));

    const distractorsMap = await generateTermDistractorsForItems(safeItems, count);

    return res.json({ distractors: distractorsMap });
  } catch (err) {
    console.error("postTermDistractors error:", err);
    return res.status(500).json({ error: "Failed to generate term distractors" });
  }
}
