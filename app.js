import express from 'express';
import cors from 'cors';
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

// Routes
app.use('/api', routes);

export default app;
