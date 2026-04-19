const logger = {
  info: (msg, meta) => console.log(`[${new Date().toISOString()}] INFO: ${msg}`, meta || ''),
  error: (msg, meta) => console.error(`[${new Date().toISOString()}] ERROR: ${msg}`, meta || ''),
  warn: (msg, meta) => console.warn(`[${new Date().toISOString()}] WARN: ${msg}`, meta || ''),
};

export default logger;
