module.exports = {
  apps: [
    {
      name: 'nadinmotion-bot',
      script: 'c:\\Users\\avelin\\Downloads\\RUN\\runninghub-telegram-bot\\dist\\index.js',
      instances: 1,
      exec_mode: 'fork',
      cwd: 'c:\\Users\\avelin\\Downloads\\RUN\\runninghub-telegram-bot',
      env: {
        NODE_ENV: 'production'
      },
      max_memory_restart: '500M',
      kill_timeout: 5000,
      error_file: './logs/error.log',
      out_file: './logs/out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z'
    }
  ]
};
