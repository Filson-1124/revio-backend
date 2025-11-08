import express from "express";
import rateLimit from "express-rate-limit";
import verifyFirebaseToken from "../middleware/verifyFirebaseToken.js";
import { postDistractors } from "../controllers/distractorController.js";

const router = express.Router();

const limiter = rateLimit({
  windowMs: 60 * 1000, 
  max: 15, // 15 requests per minute per IP
  message: { error: "Too many requests, slow down." },
});

router.post("/", limiter, verifyFirebaseToken, postDistractors);

export default router;
