import express from 'express';
import multer from 'multer';
import { handlePdfUpload, handlePptxUpload, handleDocxUpload } from '../controllers/uploadController.js';

const router = express.Router();

// Multer /tmp with original filename
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, './tmp'),
  filename: (req, file, cb) => cb(null, file.originalname)
});

const upload = multer({ storage });

// Routes
router.post('/pdf', upload.single('file'), handlePdfUpload);
router.post('/pptx', upload.single('file'), handlePptxUpload);
router.post('/docx', upload.single('file'), handleDocxUpload);

export default router;
