import express from 'express';
import cors from 'cors';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import uploadRoutes from './routes/upload.js';
import featureRoutes from './routes/feature.js';
import distractorsRouter from "./routes/distractors.js";
import dotenv from 'dotenv';
dotenv.config();


const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);


// Ensure tmp folder exists
if (!fs.existsSync('./tmp')) {
  fs.mkdirSync('./tmp');
}

const app = express();
const PORT = process.env.PORT || 5000;

const allowedOrigins = [
  process.env.VITE_API_URL, 'https://revio-web-ebon.vercel.app',  
  'http://localhost:5173', 'http://192.168.254.110:5173', 'capacitor://localhost', 
  'http://localhost'
];

// Middleware
const corsOptions = {
  origin: function (origin, callback) {
    if (!origin) return callback(null, true);
    if (allowedOrigins.indexOf(origin) !== -1) {
      callback(null, true);
    } else {
      callback(new Error('CORS policy: This origin is not allowed.'));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
};


app.use(cors(corsOptions));


app.use(express.json());



//Added part 09-23
// Quick health/root route (useful for Render + curl checks)
app.get('/', (req, res) => {
  res.send('Reviewer Backend is running');
});
app.get('/health', (req, res) => res.sendStatus(200));


// Routes
app.use('/upload', uploadRoutes);
app.use('/feature', featureRoutes);

// New route for term distractor
app.set("trust proxy", 1);
app.use("/api/distractors", distractorsRouter);

app.use((req, res, next) => {
  res.status(404).json({ error: 'Route not found' });
});


// Server Start
// app.listen(PORT, () => {
//   console.log(`Server running on port ${PORT}`);
// });


app.listen(PORT, '0.0.0.0', () => console.log(`Server running on port ${PORT}`));


// Log errors on deploy issues fast
process.on('unhandledRejection', (reason, p) => {
  console.error('Unhandled Rejection at Promise', p, 'reason:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
});