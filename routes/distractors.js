import express from "express";
import rateLimit from "express-rate-limit";
import verifyFirebaseToken from "../middleware/verifyFirebaseToken.js";
import { postDistractors } from "../controllers/distractorController.js";
import { postTermDistractors } from "../controllers/termDistractorController.js";

const router = express.Router();

const limiter = rateLimit({
  windowMs: 60 * 1000, 
  max: 15, 
  message: { error: "Too many requests, slow down." },
});

router.post("/", limiter, verifyFirebaseToken, postDistractors);
router.post("/term", limiter, verifyFirebaseToken, postTermDistractors);

export default router;
