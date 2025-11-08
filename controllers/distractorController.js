import { generateDistractorsForItems } from "../utils/distractorService.js";

export async function postDistractors(req, res) {
  try {
    const body = req.body || {};
    const items = body.items;
    const count = Math.min(Math.max(parseInt(body.count || 3, 10) || 3, 1), 6);

    if (!Array.isArray(items) || items.length === 0) {
      return res
        .status(400)
        .json({
          error:
            "Missing items array. Expected [{ id, term, correctDefinition }]",
        });
    }

    // Basic validation
    const safeItems = items.map((it) => {
      return {
        id: String(it.id || "").trim(),
        term: String(it.term || "").trim(),
        correctDefinition: String(it.correctDefinition || "").trim(),
      };
    });

    const distractorsMap = await generateDistractorsForItems(safeItems, count);

    return res.json({ distractors: distractorsMap });
  } catch (err) {
    console.error("postDistractors error:", err);
    return res.status(500).json({ error: "Failed to generate distractors" });
  }
}
