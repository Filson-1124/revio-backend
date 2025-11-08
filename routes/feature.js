import express from 'express';
import multer from 'multer';
import verifyFirebaseToken from '../middleware/verifyFirebaseToken.js';
import {
  summarizeFeature,
  explainFeature,
  termsFeature,
  acronymFeature
} from '../controllers/featureController.js';

const router = express.Router();
const upload = multer({ dest: 'tmp/' });

router.post('/summarize', verifyFirebaseToken, upload.single('file'), summarizeFeature);
router.post('/explain', verifyFirebaseToken, upload.single('file'), explainFeature);
router.post('/terms', verifyFirebaseToken, upload.single('file'), termsFeature);
router.post('/acronyms', verifyFirebaseToken, upload.single('file'), acronymFeature);

export default router;
