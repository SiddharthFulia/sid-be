// PM2 apps declaration for sid-be + its standalone consumers.
//
// Deploy runs `pm2 startOrRestart ecosystem.config.js` — which starts new
// entries and restarts existing ones without touching processes that AREN'T
// listed (face-service is managed independently, no risk of it getting
// killed by a redeploy).
//
// Adding a new consumer: append an entry under `apps`, push. Deploy picks
// it up automatically on the next run.

module.exports = {
  apps: [
    // Main API + cron scheduler
    {
      name:              'sid-be',
      script:            'server.js',
      cwd:               '/home/ubuntu/sid-be',
      exec_mode:         'fork',
      instances:         1,
      autorestart:       true,
      watch:             false,
      max_memory_restart: '1G',
      env: {
        NODE_ENV: 'production',
      },
    },

    // Standalone RabbitMQ consumer. One process handles every BE-owned
    // queue (currently just `keep_alive`) — see consumer.js for how to
    // add more. Isolated from the API so a hung handler can't slow HTTP
    // requests.
    {
      name:              'sid-be-consumer',
      script:            'consumer.js',
      cwd:               '/home/ubuntu/sid-be',
      exec_mode:         'fork',
      instances:         1,
      autorestart:       true,
      watch:             false,
      max_memory_restart: '256M',
      // Backs off restarts so a flapping broker doesn't spin us at 100% CPU.
      min_uptime:        '10s',
      max_restarts:      10,
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
