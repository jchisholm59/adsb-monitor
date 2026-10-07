// pm2: `pm2 start ecosystem.config.js && pm2 save`. Settings are in .env (copy .env.example).
module.exports = {
  apps: [{
    name: 'adsb-monitor',
    script: 'server.js',
    cwd: __dirname,
    max_memory_restart: '400M',
  }],
};
