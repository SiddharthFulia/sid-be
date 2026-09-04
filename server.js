import 'dotenv/config';
import http from 'http';
import app from './app.js';
import { PORT, OLLAMA_URL } from './helpers/constants.js';
import logger from './helpers/logger.js';
import { preloadModels } from './services/ollama.js';
import { startCrons } from './master_cron_server.js';
import { startKeepAliveConsumer } from './services/keepAlive/index.js';

const server = http.createServer(app);

server.listen(PORT, () => {
  logger.info(`Server running on port ${PORT}`);
  logger.info(`Ollama: ${OLLAMA_URL}`);
  logger.info(`Health: http://localhost:${PORT}/api/health`);

  preloadModels();
  // Fire-and-forget cron registration — runs after listen() so any
  // startup logs from individual jobs land after the "Server running"
  // line, keeping the boot log readable.
  startCrons().catch(err => logger.error(`cron boot failed: ${err.message}`));
  // Keep-alive consumer — one message per night from crons/keepAlive.js.
  // Also picks up manual triggers from POST /api/admin/keep-alive/trigger.
  startKeepAliveConsumer().catch(err => logger.error(`keep-alive consumer boot failed: ${err.message}`));
});
