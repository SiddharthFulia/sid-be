import 'dotenv/config';
import http from 'http';
import app from './app.js';
import { PORT, OLLAMA_URL } from './helpers/constants.js';
import logger from './helpers/logger.js';
import { preloadModels } from './services/ollama.js';
import { startCrons } from './master_cron_server.js';
import { disconnect as disconnectRabbit } from './services/aiVideo/messageQueue.js';

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
  // Keep-alive consumer lives in its own PM2 process now — see
  // consumers/index.js + ecosystem.config.cjs. Nothing to start here.
});

// ── Graceful shutdown ──────────────────────────────────────────
// Order matters:
//   1. server.close(): stop accepting new HTTP requests (in-flight ones
//      keep running to completion).
//   2. disconnectRabbit(): close the AMQP channel + connection cleanly
//      so CloudAMQP doesn't count us against its 40-connection cap for
//      the next 30s heartbeat window.
//   3. process.exit(0).
//
// PM2 sends SIGINT by default; systemd sends SIGTERM. Force-exit after
// 8 seconds if HTTP requests hang — CloudAMQP's TCP timeout is the only
// backstop after that.
let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`${signal} received — closing HTTP + RabbitMQ`);
  const forceExitTimer = setTimeout(() => {
    logger.warn('graceful shutdown timed out after 8s — forcing exit');
    process.exit(1);
  }, 8000);
  forceExitTimer.unref();

  try {
    await new Promise((resolve) => server.close((err) => {
      if (err) logger.warn(`HTTP server close error (ignoring): ${err.message}`);
      resolve();
    }));
    logger.info('HTTP server closed');
    await disconnectRabbit();
    process.exit(0);
  } catch (err) {
    logger.error(`shutdown error: ${err.message}`);
    process.exit(1);
  }
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
