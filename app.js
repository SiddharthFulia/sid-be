import express from 'express';
import cors from 'cors';
import compression from 'compression';
import path from 'path';
import routes from './routes/index.js';
import { NODE_ENV, FRONTEND_URL } from './helpers/constants.js';

const app = express();

// CORS — PATCH is required for the chat conversation rename / tune /
// image-gen toggle endpoints. Without it the browser preflight on PATCH
// returns 'Failed to fetch' and the FE never even reaches the BE.
const corsOptions = NODE_ENV === 'production'
  ? { origin: [FRONTEND_URL, 'https://www.siddharthfulia.com', 'http://localhost:3000'],
      methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'] }
  : { origin: true };
app.use(cors(corsOptions));

// Gzip / deflate response compression. Browsers send `Accept-Encoding: gzip,
// deflate, br` automatically and the middleware picks the best one. Heavy
// JSON endpoints (job logs with 80 entries, video lists, queue snapshots)
// shrink ~70-85% on the wire — saves bandwidth on the 1.5s status poll and
// makes the FE feel snappier. Tiny responses (<1 KB) stay uncompressed
// (compression overhead would dominate). Set threshold=1024 to skip them.
app.use(compression({
  threshold: 1024,
  filter: (req, res) => {
    // Don't compress mp4/image streams — Cloudinary already serves those
    // pre-compressed and re-compressing hurts more than it helps.
    if (res.getHeader('Content-Type')?.toString().match(/^(video|image)\//)) return false;
    return compression.filter(req, res);
  },
}));

// Body parsing
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Static — generated AI videos (supports byte-range for <video> tag)
app.use('/generated-videos', express.static(path.join(process.cwd(), 'public', 'generated-videos'), {
  setHeaders: (res) => {
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.setHeader('Access-Control-Allow-Origin', '*');
  },
}));

// Routes
app.use('/api', routes);

export default app;
