// ===================================================
//  El Ashry Pro - PM2 Ecosystem Config
//  إعداد PM2 لإعادة التشغيل التلقائي
// ===================================================

module.exports = {
  apps: [{
    name: "el-ashry-pro-bot",
    script: "bot.js",
    interpreter: "node",

    // إعادة التشغيل التلقائي عند الإغلاق
    autorestart: true,
    watch: false,
    max_memory_restart: "200M",

    // المتغيرات البيئية
    env: {
      NODE_ENV: "production",
      BOT_TOKEN: "8932213518:AAFdrQGmLPCAtSbZGV069yVtEVwsXZZd31o",
      CHANNEL_ID: "-1004373481196"
    },

    // سجل الأخطاء والمخرجات
    error_file: "./logs/error.log",
    out_file: "./logs/output.log",
    log_date_format: "YYYY-MM-DD HH:mm:ss",

    // الانتظار 3 ثوانٍ قبل إعادة التشغيل
    restart_delay: 3000,
  }]
};
