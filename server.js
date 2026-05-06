import 'dotenv/config';
import http from 'http';
import app from './app.js';
import { PORT, OLLAMA_URL } from './helpers/constants.js';
import logger from './helpers/logger.js';
import { preloadModels } from './services/ollama.js';

const server = http.createServer(app);

server.listen(PORT, () => {
  logger.info(`Server running on port ${PORT}`);
  logger.info(`Ollama: ${OLLAMA_URL}`);
  logger.info(`Health: http://localhost:${PORT}/api/health`);

  preloadModels();
});
