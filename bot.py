// =====================================================
//  El Ashry Pro - Telegram Bot (Node.js)
//  يراقب Firebase ويرسل إشعارات تلغرام
// =====================================================

const https = require("https");
const http = require("http");

// ─── إعداد المتغيرات البيئية ──────────────────────────────────
const BOT_TOKEN = process.env.BOT_TOKEN || "";
const CHANNEL_ID = process.env.CHANNEL_ID || "";
const FIREBASE_URL = process.env.FIREBASE_URL || "https://el-ashry-default-rtdb.firebaseio.com";
const FIREBASE_PATH = process.env.FIREBASE_PATH || "cases";
const BOT_PASSWORD = process.env.BOT_PASSWORD || "521988";
const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL || "30000"); // 30 ثانية

// ─── ثوابت ───────────────────────────────────────────────────
const STATUS_LABELS = {
  executed: "✅ تم التنفيذ",
  under_review: "🔍 تحت المراجعة",
  under_procedure: "⚙️ تحت الإجراء",
  responded: "💬 تم الرد",
  rejected: "❌ طلب مرفوض",
};

const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

// ─── Logging ──────────────────────────────────────────────────
function log(level, msg) {
  const now = new Date().toISOString().replace("T", " ").substring(0, 19);
  console.log(`${now} [${level}] ${msg}`);
}

function info(msg) { log("INFO", msg); }
function warn(msg) { log("WARN", msg); }
function error(msg) { log("ERROR", msg); }

// ─── طلبات HTTP مساعدة ───────────────────────────────────────
function httpGet(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith("https") ? https : http;
    lib.get(url, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          resolve(data);
        }
      });
    }).on("error", reject);
  });
}

function httpPost(url, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const parsed = new URL(url);
    const options = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
      },
    };

    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          resolve(data);
        }
      });
    });

    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

// ─── إرسال رسالة تلغرام ──────────────────────────────────────
async function sendMessage(text, chatId = null, parseMode = "HTML") {
  const target = chatId || CHANNEL_ID;
  if (!target) {
    warn("لم يتم تحديد CHANNEL_ID");
    return false;
  }

  try {
    const result = await httpPost(`${TELEGRAM_API}/sendMessage`, {
      chat_id: target,
      text: text,
      parse_mode: parseMode,
    });

    if (result && result.ok) {
      info(`✅ رسالة أُرسلت إلى ${target}`);
      return true;
    } else {
      error(`❌ خطأ تلغرام: ${result && result.description ? result.description : JSON.stringify(result)}`);
      return false;
    }
  } catch (e) {
    error(`❌ خطأ في إرسال الرسالة: ${e.message}`);
    return false;
  }
}

// ─── تنسيق رسالة الطلب ───────────────────────────────────────
function formatCaseMessage(caseData, caseId, eventType = "new") {
  const status = caseData.status || "under_review";
  const statusLabel = STATUS_LABELS[status] || status;
  const caseNum = caseData.caseNumber || "?";
  const name = caseData.name || "غير معروف";
  const phone = caseData.phone || "";
  const nationalId = caseData.nationalId || "";
  const country = caseData.country || "";
  const hospital = caseData.hospital || "";
  const service = caseData.service || "";
  const desc = caseData.desc || "";
  const submissionDate = caseData.submissionDate || "";
  const responseDate = caseData.responseDate || "";
  const response = caseData.response || "";
  const rejection = caseData.rejection || "";

  let header;
  if (eventType === "new") {
    header = `🆕 <b>طلب جديد #${caseNum}</b>`;
  } else if (eventType === "update") {
    header = `🔄 <b>تحديث طلب #${caseNum}</b>`;
  } else {
    header = `📋 <b>طلب #${caseNum}</b>`;
  }

  const lines = [
    header,
    "━━━━━━━━━━━━━━━━━━━━",
    `👤 <b>الاسم:</b> ${name}`,
  ];

  if (phone) lines.push(`📱 <b>الهاتف:</b> <code>${phone}</code>`);
  if (nationalId) lines.push(`🆔 <b>الرقم القومي:</b> <code>${nationalId}</code>`);
  if (country) lines.push(`🏠 <b>البلد:</b> ${country}`);
  if (hospital) lines.push(`🏥 <b>المستشفى:</b> ${hospital}`);
  if (service) lines.push(`📝 <b>الخدمة:</b> ${service}`);

  lines.push(`📊 <b>الحالة:</b> ${statusLabel}`);

  if (submissionDate) lines.push(`📅 <b>تاريخ الطلب:</b> ${submissionDate}`);
  if (responseDate) lines.push(`📆 <b>تاريخ الرد:</b> ${responseDate}`);
  if (desc) {
    const shortDesc = desc.length > 200 ? desc.substring(0, 200) + "..." : desc;
    lines.push(`📄 <b>الوصف:</b> ${shortDesc}`);
  }
  if (status === "responded" && response) {
    const shortResp = response.length > 200 ? response.substring(0, 200) + "..." : response;
    lines.push(`✅ <b>الرد:</b> ${shortResp}`);
  }
  if (status === "rejected" && rejection) {
    lines.push(`❌ <b>سبب الرفض:</b> ${rejection}`);
  }

  lines.push("━━━━━━━━━━━━━━━━━━━━");
  lines.push("🏢 <i>مكتب الحاج أحمد الحديدي</i>");

  const now = new Date().toLocaleString("ar-EG");
  lines.push(`🕐 <i>${now}</i>`);

  return lines.join("\n");
}

// ─── مراقبة Firebase ─────────────────────────────────────────
const knownCases = {};
let monitorInitialized = false;

async function loadExistingCases() {
  try {
    const url = `${FIREBASE_URL}/${FIREBASE_PATH}.json`;
    const data = await httpGet(url);
    if (data && typeof data === "object") {
      Object.assign(knownCases, data);
      info(`📦 تم تحميل ${Object.keys(data).length} طلب موجود`);
    } else {
      info("📦 لا توجد طلبات موجودة");
    }
    monitorInitialized = true;
  } catch (e) {
    error(`❌ خطأ في تحميل الطلبات: ${e.message}`);
    monitorInitialized = true;
  }
}

async function checkForChanges() {
  try {
    const url = `${FIREBASE_URL}/${FIREBASE_PATH}.json`;
    const currentData = await httpGet(url);

    if (!currentData || typeof currentData !== "object") {
      return;
    }

    const newCases = [];
    const updatedCases = [];

    for (const [caseId, caseData] of Object.entries(currentData)) {
      if (!knownCases[caseId]) {
        // طلب جديد
        newCases.push([caseId, caseData]);
      } else {
        // تحقق من التحديث
        const oldUpdated = knownCases[caseId].updatedAt || "";
        const newUpdated = caseData.updatedAt || "";
        if (newUpdated && newUpdated !== oldUpdated) {
          updatedCases.push([caseId, caseData]);
        }
      }
    }

    // تحديث الحالة المعروفة
    Object.keys(knownCases).forEach((k) => delete knownCases[k]);
    Object.assign(knownCases, currentData);

    // إرسال الإشعارات
    for (const [caseId, caseData] of newCases) {
      const msg = formatCaseMessage(caseData, caseId, "new");
      await sendMessage(msg);
      await new Promise((r) => setTimeout(r, 500));
    }

    for (const [caseId, caseData] of updatedCases) {
      const msg = formatCaseMessage(caseData, caseId, "update");
      await sendMessage(msg);
      await new Promise((r) => setTimeout(r, 500));
    }

  } catch (e) {
    error(`❌ خطأ في قراءة Firebase: ${e.message}`);
  }
}

// ─── بوت تلغرام (Polling) ─────────────────────────────────────
let pollingOffset = 0;

async function getUpdates() {
  try {
    const url = `${TELEGRAM_API}/getUpdates?offset=${pollingOffset}&timeout=30`;
    const data = await httpGet(url);
    if (data && data.ok) {
      return data.result || [];
    }
    return [];
  } catch (e) {
    error(`❌ خطأ في getUpdates: ${e.message}`);
    return [];
  }
}

async function getStats() {
  try {
    const url = `${FIREBASE_URL}/${FIREBASE_PATH}.json`;
    const data = await httpGet(url);
    if (!data || typeof data !== "object") return null;

    const total = Object.keys(data).length;
    const stats = {};
    for (const caseData of Object.values(data)) {
      const s = caseData.status || "unknown";
      stats[s] = (stats[s] || 0) + 1;
    }

    return { total, stats };
  } catch (e) {
    return null;
  }
}

async function handleUpdate(update) {
  const msg = update.message || {};
  if (!msg.text) return;

  const chatId = String(msg.chat?.id || "");
  const text = msg.text.trim();
  const user = msg.from || {};
  const username = user.username || user.first_name || "مستخدم";

  info(`📩 رسالة من ${username}: ${text}`);

  if (text === "/start") {
    const reply =
      "👋 <b>مرحباً بك في بوت El Ashry Pro</b>\n\n" +
      "📋 هذا البوت يرسل إشعارات تلقائية عند:\n" +
      "• إضافة طلب جديد\n" +
      "• تحديث حالة طلب موجود\n\n" +
      "🔧 الأوامر المتاحة:\n" +
      "/start - بدء البوت\n" +
      "/stats - إحصائيات الطلبات\n" +
      "/help - المساعدة";
    await sendMessage(reply, chatId);

  } else if (text === "/stats") {
    const statsData = await getStats();
    if (!statsData) {
      await sendMessage("❌ تعذر جلب الإحصائيات", chatId);
      return;
    }

    const lines = [
      "📊 <b>إحصائيات الطلبات</b>",
      "━━━━━━━━━━━━━━━━━━━━",
      `📦 <b>إجمالي الطلبات:</b> ${statsData.total}`,
    ];

    for (const [status, label] of Object.entries(STATUS_LABELS)) {
      const count = statsData.stats[status] || 0;
      if (count) lines.push(`${label}: ${count}`);
    }

    lines.push("━━━━━━━━━━━━━━━━━━━━");
    lines.push(`🕐 ${new Date().toLocaleString("ar-EG")}`);
    await sendMessage(lines.join("\n"), chatId);

  } else if (text === "/help") {
    const reply =
      "ℹ️ <b>مساعدة - El Ashry Pro Bot</b>\n\n" +
      "/start - بدء البوت\n" +
      "/stats - إحصائيات الطلبات الحالية\n" +
      "/help - عرض هذه المساعدة\n\n" +
      "📲 يرسل البوت إشعارًا تلقائيًا عند كل إضافة أو تحديث.";
    await sendMessage(reply, chatId);

  } else {
    await sendMessage("❓ أمر غير معروف. اكتب /help للمساعدة.", chatId);
  }
}

async function runPolling() {
  info("🤖 بدء تشغيل polling...");
  while (true) {
    try {
      const updates = await getUpdates();
      for (const update of updates) {
        pollingOffset = update.update_id + 1;
        await handleUpdate(update);
      }
    } catch (e) {
      error(`❌ خطأ في polling: ${e.message}`);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

// ─── نقطة الدخول الرئيسية ─────────────────────────────────────
async function main() {
  info("=".repeat(50));
  info("🚀 El Ashry Pro - Telegram Bot (Node.js) بدء التشغيل");
  info("=".repeat(50));

  if (!BOT_TOKEN) {
    error("❌ BOT_TOKEN غير محدد في المتغيرات البيئية!");
    process.exit(1);
  }

  if (!CHANNEL_ID) {
    warn("⚠️ CHANNEL_ID غير محدد - لن يتم إرسال الإشعارات للقناة");
  }

  // إرسال رسالة تشغيل
  const startMsg =
    "🚀 <b>El Ashry Pro Bot - تم التشغيل</b>\n" +
    `🕐 ${new Date().toLocaleString("ar-EG")}\n` +
    `🔗 Firebase URL: ${FIREBASE_URL ? "✅ محدد" : "❌ غير محدد"}\n` +
    "👀 المراقبة نشطة...";

  await sendMessage(startMsg);

  // تحميل الطلبات الموجودة
  await loadExistingCases();

  // بدء مراقبة Firebase
  const runMonitoring = async () => {
    while (true) {
      try {
        await checkForChanges();
      } catch (e) {
        error(`❌ خطأ في المراقبة: ${e.message}`);
      }
      await new Promise((r) => setTimeout(r, POLL_INTERVAL));
    }
  };

  // تشغيل المراقبة والـ polling معاً
  await Promise.all([runMonitoring(), runPolling()]);
}

// معالجة الأخطاء غير المتوقعة
process.on("uncaughtException", (e) => {
  error(`💥 خطأ غير متوقع: ${e.message}`);
});

process.on("unhandledRejection", (reason) => {
  error(`💥 Promise مرفوض: ${reason}`);
});

process.on("SIGINT", () => {
  info("🛑 تم إيقاف البوت");
  process.exit(0);
});

main().catch((e) => {
  error(`💥 خطأ في التشغيل: ${e.message}`);
  process.exit(1);
});
