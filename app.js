import express from 'express';
import cors from 'cors';
import compression from 'compression';
import path from 'path';
import routes from './routes/index.js';
import { NODE_ENV, FRONTEND_URL } from './helpers/constants.js';
import { apiMetricsMiddleware } from './services/metrics/apiMetrics.js';

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
// JSON endpoints (city graphs at 6 MB, api-catalog with 321 entries, osint
// tools manifest, video lists, queue snapshots) shrink ~70-85% on the wire.
// Tiny responses (<1 KB) stay uncompressed — compression overhead dominates.
//
// The `NO_COMPRESSION_PATHS` list opts out endpoint families that either:
//   • stream (SSE — Content-Encoding: gzip would buffer until close, killing
//     the whole point of server-sent events)
//   • are pre-encoded (city-graphs binary blob route — we set the header
//     manually and stream the raw gzipped SQLite BLOB)
//   • poll at sub-second cadence where the CPU cost isn't worth the shrink
//     (job-logs is polled at 500 ms, health/stats are trivially small)
//   • return base64 payloads that don't compress well (qr-saves png_data_url)
const NO_COMPRESSION_PATHS = [
  /^\/api\/events\//,                              // SSE — server-sent events
  /^\/api\/agents\/[^/]+\/stream$/,                // SSE — agent output stream
  /^\/api\/city-graphs\/[^/]+\/graph\.json\.gz$/,  // pre-gzipped BLOB (manual header)
  /^\/api\/qr-saves\/[^/]+$/,                      // base64 png_data_url — poor ratio
  /^\/api\/job-logs\//,                            // polled at 500 ms — keep raw
  /^\/api\/[^/]+\/status\//,                       // small poll payloads
  /^\/api\/health$/,                               // tiny, poll-heavy
  /^\/api\/stats$/,                                // tiny, poll-heavy
];

app.use(compression({
  threshold: 1024,   // 1 KB minimum — smaller responses cost more CPU than they save
  level: 6,          // balanced CPU vs ratio (compression's default)
  filter: (req, res) => {
    // Don't recompress pre-encoded responses (city-graphs blob route sets
    // Content-Encoding: gzip manually before res.end()).
    if (res.getHeader('Content-Encoding')) return false;
    // SSE streams — never buffer or compress; kills real-time delivery.
    const ct = res.getHeader('Content-Type')?.toString() || '';
    if (ct.includes('text/event-stream')) return false;
    // Don't compress mp4/image streams — Cloudinary/ffmpeg already serve
    // those pre-compressed and re-compressing hurts more than it helps.
    if (/^(video|image)\//.test(ct)) return false;
    // Path-based opt-outs — streaming/polling/pre-encoded endpoint families.
    for (const rx of NO_COMPRESSION_PATHS) if (rx.test(req.path)) return false;
    // Fall through to the library's default filter (respects x-no-compression
    // header, checks the mime-db table for compressible content types).
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

// Per-endpoint API usage metrics — sits AFTER body parsers (so parse
// latency is included in the measurement) and BEFORE the route mount so
// every /api/* response fires the finish listener. Recording failures
// are swallowed inside the middleware; the request path is untouched.
app.use(apiMetricsMiddleware);

// Routes
app.use('/api', routes);

export default app;
