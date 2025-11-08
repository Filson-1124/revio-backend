import { handlePdfUpload } from '../controllers/uploadController.js';
import { handlePptxUpload } from '../controllers/uploadController.js';
import { handleDocxUpload } from '../controllers/uploadController.js';

export async function simulateRes(filePath, mimeType) {
  const req = { file: { path: filePath, mimetype: mimeType } };

  const res = {
    _markdown: '',
    status: (code) => ({ json: (data) => console.error(`Error ${code}:`, data) }),
    json: (data) => console.error('Error:', data),
  };

// This commented out is for debugging sa terminal, to show what type of file (docx, pptx, pdf)
//  console.log('[simulateRes] mimeType received:', mimeType);

  const next = () => resolve(res._markdown); // move inside Promise kineme, comment it out na.

  return new Promise((resolve, reject) => {
    // Set up 'next' here so we can 'resolve()' when called chuchu
    const next = () => {
      resolve(res._markdown);
    };

    // Choose correct handler
    if (mimeType === 'application/pdf') {
      handlePdfUpload(req, res, next);
    } else if (mimeType === 'application/vnd.openxmlformats-officedocument.presentationml.presentation') {
      handlePptxUpload(req, res, next);
    } else if (mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
      handleDocxUpload(req, res, next);
    } else {
      reject(new Error('Unsupported file type'));
    }
  });
}

//Lagi nalang kitang kinakalimutan. Basically, what you do is catching the extracted text instead of sending it back to the browser/client.
//
