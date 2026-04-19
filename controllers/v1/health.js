import { success } from '../../helpers/res_helper.js';

export const getHealth = (req, res) => {
  success(res, { uptime: process.uptime(), timestamp: new Date().toISOString() }, 'OK');
};

export const getStats = (req, res) => {
  const mem = process.memoryUsage();
  success(res, {
    uptime: Math.floor(process.uptime()),
    memory: {
      rss: `${(mem.rss / 1024 / 1024).toFixed(1)} MB`,
      heap: `${(mem.heapUsed / 1024 / 1024).toFixed(1)} MB`,
    },
    node: process.version,
    platform: process.platform,
    arch: process.arch,
  });
};
