// PM2 apps declaration. .cjs extension because package.json has
// "type": "module" and PM2 requires CommonJS for its config files.
//
// Deploy runs `pm2 startOrRestart ecosystem.config.cjs` — starts new
// entries, restarts existing ones. Processes NOT listed here (face-service)
// stay untouched.

module.exports = {
  apps: [
    // Main API + cron scheduler + producer
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

    // Standalone RabbitMQ consumer. One PM2 process handles every BE-owned
    // queue — see consumers/index.js for how to register a new handler.
    // Isolated from the API so a hung handler can't slow HTTP requests.
    {
      name:              'sid-be-consumer',
      script:            'consumers/index.js',
      cwd:               '/home/ubuntu/sid-be',
      exec_mode:         'fork',
      instances:         1,
      autorestart:       true,
      watch:             false,
      max_memory_restart: '256M',
      min_uptime:        '10s',
      max_restarts:      10,
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
