// ===================================================
//  El Ashry Pro - PM2 Ecosystem Config
// ===================================================

module.exports = {
  apps: [{
    name: "el-ashry-pro-bot",
    script: "bot.js",
    interpreter: "node",

    autorestart: true,
    watch: false,
    max_memory_restart: "200M",

    // ⚠️ لا تضع التوكن هنا - استخدم ملف .env
    env_file: ".env",

    env: {
      NODE_ENV: "production",
    },

    error_file: "./logs/error.log",
    out_file:   "./logs/output.log",
    log_date_format: "YYYY-MM-DD HH:mm:ss",

    restart_delay: 3000,
  }]
};
