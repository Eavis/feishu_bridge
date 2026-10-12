/**
 * pm2 ecosystem for the Feishu Bridge daemon on Windows / Linux.
 *
 *   npm install -g pm2 pm2-windows-startup
 *   pm2 start ecosystem.config.cjs
 *   pm2 save
 *   pm2-startup install     # (Windows only — registers a Task Scheduler entry)
 *
 * On Linux/macOS use `pm2 startup systemd|launchd` after `pm2 save`.
 *
 * Logs live alongside the bridge's own .bridge/logs/ directory so all
 * runtime artifacts are under one tree.
 */
module.exports = {
  apps: [
    {
      name: 'feishu-bridge',
      script: 'dist/daemon.mjs',
      cwd: __dirname,
      interpreter: 'node',
      env: {
        NODE_ENV: 'production',
      },
      autorestart: true,
      max_restarts: 10,
      restart_delay: 3000,
      kill_timeout: 8000,
      out_file: '.bridge/logs/pm2-out.log',
      error_file: '.bridge/logs/pm2-err.log',
      merge_logs: true,
      time: true,
    },
  ],
};
