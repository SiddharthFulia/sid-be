import express from 'express';
import cors from 'cors';
import path from 'path';
import routes from './routes/index.js';
import { NODE_ENV, FRONTEND_URL } from './helpers/constants.js';

const app = express();

// CORS
const corsOptions = NODE_ENV === 'production'
  ? { origin: [FRONTEND_URL, 'https://www.siddharthfulia.com', 'http://localhost:3000'], methods: ['GET', 'POST'] }
  : { origin: true };
app.use(cors(corsOptions));

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
