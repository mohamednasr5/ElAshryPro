// ============================================================
//  El Ashry Pro - Telegram Bot v4.0
//  نظام إدارة الحالات الطبية - بوت تليجرام المتكامل
//  برمجة وتطوير بكل ❤️ حب - المهندس محمد حماد
// ============================================================

const BOT_TOKEN    = process.env.BOT_TOKEN    || "8932213518:AAFdrQGmLPCAtSbZGV069yVtEVwsXZZd31o";
const CHANNEL_ID   = process.env.CHANNEL_ID   || "-1004373481196";
const BOT_PASSWORD = process.env.BOT_PASSWORD || "521988";
const BOT_USERNAME = "@Ashryworkbot";

const FIREBASE_CONFIG = {
  apiKey:            "AIzaSyCXu2rJGT81e9BBkJXzzVyEyXWaYcrK2NM",
  authDomain:        "el-ashry.firebaseapp.com",
  databaseURL:       "https://el-ashry-default-rtdb.firebaseio.com",
  projectId:         "el-ashry",
  storageBucket:     "el-ashry.firebasestorage.app",
  messagingSenderId: "169155515034",
  appId:             "1:169155515034:web:d74c9f027efd216a228523"
};

// ===== Firebase Init =====
const { initializeApp }                                       = require("firebase/app");
const { getDatabase, ref, set, get, update, remove, push }    = require("firebase/database");
const firebaseApp = initializeApp(FIREBASE_CONFIG);
const db          = getDatabase(firebaseApp);

// ===== Constants =====
const STATUS_LABELS = {
  executed:        "✅ تم التنفيذ",
  under_review:    "⏳ تحت المراجعة",
  under_procedure: "🔄 تحت الإجراء",
  responded:       "💬 تم الرد",
  rejected:        "❌ مرفوض"
};

const SERVICE_TYPES = [
  "علاج على نفقة الدولة",
  "تكاليف العلاج",
  "عملية جراحية",
  "انتداب ممرض",
  "تحويل مستشفى",
  "أجهزة طبية",
  "خدمة أخرى"
];

const MAX_DOCS = 15;

// ===== Auth State =====
const authUsers    = new Set();
const userSessions = new Map();

async function loadAuthUsers() {
  try {
    const snap = await get(ref(db, "auth_users"));
    if (snap.val()) {
      for (const id of Object.values(snap.val())) authUsers.add(Number(id));
    }
  } catch(e) { console.error("loadAuthUsers:", e); }
}

async function persistAuthAdd(chatId) {
  authUsers.add(chatId);
  await set(ref(db, `auth_users/${chatId}`), chatId);
}

async function persistAuthRemove(chatId) {
  authUsers.delete(chatId);
  await remove(ref(db, `auth_users/${chatId}`));
}

async function loadSessions() {
  try {
    const snap = await get(ref(db, "sessions"));
    if (snap.val()) {
      for (const [id, session] of Object.entries(snap.val())) {
        userSessions.set(Number(id), session);
      }
    }
  } catch(e) { console.error("loadSessions:", e); }
}

async function persistSession(chatId, session) {
  userSessions.set(chatId, session);
  await set(ref(db, `sessions/${chatId}`), session);
}

async function deleteSession(chatId) {
  userSessions.delete(chatId);
  await remove(ref(db, `sessions/${chatId}`));
}

// ===== Telegram API =====
async function tg(method, data = {}) {
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/${method}`;
  const hasFile = data.document || data.photo;

  if (hasFile) {
    const formData = new FormData();
    for (const [k, v] of Object.entries(data)) formData.append(k, v);
    const res = await fetch(url, { method: "POST", body: formData });
    return res.json();
  }

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data)
  });
  return res.json();
}

async function sendMessage(chatId, text, extra = {}) {
  return tg("sendMessage", { chat_id: chatId, text, parse_mode: "HTML", ...extra });
}

async function sendDocument(chatId, fileId, caption = "") {
  return tg("sendDocument", { chat_id: chatId, document: fileId, caption, parse_mode: "HTML" });
}

async function editMessage(chatId, messageId, text, extra = {}) {
  return tg("editMessageText", { chat_id: chatId, message_id: messageId, text, parse_mode: "HTML", ...extra });
}

// ===== Arabic Normalizer (Smart Fuzzy Search) =====
function normalizeArabic(text) {
  if (!text) return "";
  return text
    .replace(/[أإآ]/g, "ا")
    .replace(/ؤ/g, "و")
    .replace(/ئ/g, "ي")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/[\u064B-\u065F]/g, "") // Remove diacritics (tashkeel)
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function arabicSearch(text, query) {
  return normalizeArabic(text).includes(normalizeArabic(query));
}

// ===== Phone Formatter (WhatsApp) =====
function formatPhoneForWhatsApp(phone) {
  if (!phone) return null;
  let p = phone.replace(/[\s\-().+]/g, "");
  // Egyptian numbers: start with 0 → add country code 20
  if (p.startsWith("0")) p = "20" + p.substring(1);
  // Already has 20 prefix
  if (p.startsWith("20") && p.length === 12) return p;
  // Other cases: just return cleaned
  return p;
}

function whatsAppLink(phone) {
  const formatted = formatPhoneForWhatsApp(phone);
  if (!formatted) return null;
  return `https://wa.me/${formatted}`;
}

// ===== Firebase Helpers =====
async function getAllCases() {
  const snap = await get(ref(db, "cases"));
  return snap.val() ? Object.values(snap.val()) : [];
}

async function getCaseById(id) {
  const snap = await get(ref(db, `cases/${id}`));
  return snap.val();
}

// Sequential case number using a dedicated counter in Firebase
async function getNextCaseNumber() {
  const counterRef = ref(db, "meta/caseCounter");
  const snap = await get(counterRef);
  const current = snap.val() || 0;
  const next = current + 1;
  await set(counterRef, next);
  return next;
}

async function createCase(data) {
  const newRef = push(ref(db, "cases"));
  const id     = newRef.key;
  const now    = Date.now();
  const num    = await getNextCaseNumber();
  const caseData = {
    id,
    caseNumber: String(num),
    ...data,
    createdAt: now,
    updatedAt: now
  };
  await set(newRef, caseData);
  return caseData;
}

async function updateCase(id, data) {
  await update(ref(db, `cases/${id}`), { ...data, updatedAt: Date.now() });
}

async function deleteCase(id) {
  const c = await getCaseById(id);
  if (c && c.documents) {
    for (const doc of c.documents) {
      if (doc.telegramMessageId) {
        try { await tg("deleteMessage", { chat_id: CHANNEL_ID, message_id: doc.telegramMessageId }); } catch(e) {}
      }
    }
  }
  await remove(ref(db, `cases/${id}`));
}

// Smart Arabic search
async function searchCases(query) {
  const all = await getAllCases();
  return all.filter(c =>
    arabicSearch(c.personName, query) ||
    (c.caseNumber || "").includes(query) ||
    (c.nationalId  || "").includes(query) ||
    (c.personPhone || "").includes(query) ||
    arabicSearch(c.country      || "", query) ||
    arabicSearch(c.hospitalName || "", query)
  );
}

async function saveFileToChannel(fileId, fileName) {
  const result = await tg("sendDocument", {
    chat_id: CHANNEL_ID,
    document: fileId,
    caption: `📁 ${fileName}`
  });
  if (result.ok) {
    return {
      fileId:    result.result.document.file_id,
      messageId: result.result.message_id,
      fileName
    };
  }
  return null;
}

// ===== Format Case =====
function formatDate(ts) {
  if (!ts) return "—";
  return new Date(ts).toLocaleDateString("ar-EG", {
    year: "numeric", month: "long", day: "numeric"
  });
}

function formatCase(c, includeDocLinks = false) {
  let text = `<b>📋 طلب رقم ${c.caseNumber}</b>\n\n`;
  text += `👤 <b>الاسم:</b> ${c.personName}\n`;

  if (c.personPhone) {
    const waLink = whatsAppLink(c.personPhone);
    text += `📱 <b>الهاتف:</b> <code>${c.personPhone}</code>`;
    if (waLink) text += ` | <a href="${waLink}">واتساب</a>`;
    text += "\n";
  }

  if (c.nationalId)   text += `🆔 <b>الرقم القومي:</b> <code>${c.nationalId}</code>\n`;
  if (c.country)      text += `🌍 <b>الدولة:</b> ${c.country}\n`;
  if (c.hospitalName) text += `🏥 <b>المستشفى:</b> ${c.hospitalName}\n`;
  text += `🩺 <b>الخدمة:</b> ${c.serviceType}\n`;
  text += `📌 <b>الحالة:</b> ${STATUS_LABELS[c.status] || c.status}\n`;

  if (c.submissionDate) text += `📅 <b>تاريخ تقديم الطلب:</b> ${c.submissionDate}\n`;
  if (c.responseDate)   text += `📆 <b>تاريخ الرد:</b> ${c.responseDate}\n`;

  if (c.description)                                  text += `📝 <b>الوصف:</b> ${c.description}\n`;
  if (c.status === "responded"  && c.response)         text += `💬 <b>الرد:</b> ${c.response}\n`;
  if (c.status === "rejected"   && c.rejectionReason)  text += `❌ <b>سبب الرفض:</b> ${c.rejectionReason}\n`;

  if (c.documents && c.documents.length > 0) {
    text += `📎 <b>المستندات:</b> ${c.documents.length} ملف\n`;
  }

  const d = new Date(c.createdAt);
  text += `\n🕐 ${d.toLocaleDateString("ar-EG", { year: "numeric", month: "long", day: "numeric", hour: "2-digit", minute: "2-digit" })}`;

  return text;
}

// ===== WhatsApp Share Message =====
function buildWhatsAppMessage(c) {
  let msg = `📋 *طلب رقم ${c.caseNumber}*\n\n`;
  msg += `👤 الاسم: ${c.personName}\n`;
  if (c.personPhone) msg += `📱 الهاتف: ${c.personPhone}\n`;
  if (c.country)      msg += `🌍 الدولة: ${c.country}\n`;
  if (c.hospitalName) msg += `🏥 المستشفى: ${c.hospitalName}\n`;
  msg += `🩺 الخدمة: ${c.serviceType}\n`;
  msg += `📌 الحالة: ${(STATUS_LABELS[c.status] || c.status).replace(/[✅⏳🔄💬❌]/g, "").trim()}\n`;
  if (c.submissionDate) msg += `📅 تاريخ الطلب: ${c.submissionDate}\n`;
  if (c.responseDate)   msg += `📆 تاريخ الرد: ${c.responseDate}\n`;
  if (c.description)    msg += `📝 الوصف: ${c.description}\n`;
  return msg;
}

// ===== Keyboards =====
function mainMenuKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: "📋 عرض الطلبات",   callback_data: "list_cases"    },
        { text: "➕ طلب جديد",       callback_data: "add_case"      }
      ],
      [
        { text: "🔍 بحث",            callback_data: "search_start"  },
        { text: "📊 إحصائيات",       callback_data: "stats"         }
      ],
      [
        { text: "📂 رفع مستندات",    callback_data: "docs_upload"   },
        { text: "❓ المساعدة",        callback_data: "help"          }
      ]
    ]
  };
}

function statusKeyboard(caseId) {
  return {
    inline_keyboard: [
      [
        { text: "✅ تم التنفيذ",    callback_data: `status_${caseId}_executed`        },
        { text: "⏳ تحت المراجعة", callback_data: `status_${caseId}_under_review`    }
      ],
      [
        { text: "🔄 تحت الإجراء",  callback_data: `status_${caseId}_under_procedure` },
        { text: "💬 تم الرد",      callback_data: `status_${caseId}_responded`       }
      ],
      [
        { text: "❌ مرفوض",        callback_data: `status_${caseId}_rejected`        }
      ],
      [
        { text: "🗑 حذف الطلب",    callback_data: `delete_${caseId}` },
        { text: "🔙 رجوع",         callback_data: "main_menu"        }
      ]
    ]
  };
}

function casesListKeyboard(cases, page = 0) {
  const pageSize = 8;
  const start    = page * pageSize;
  const slice    = cases.slice(start, start + pageSize);

  const buttons = slice.map(c => [{
    text: `#${c.caseNumber} - ${c.personName} (${(STATUS_LABELS[c.status] || "").replace(/[✅⏳🔄💬❌]/g, "").trim()})`,
    callback_data: `view_${c.id}`
  }]);

  const nav = [];
  if (page > 0)                              nav.push({ text: "◀️ السابق", callback_data: `page_${page-1}` });
  if (start + pageSize < cases.length)       nav.push({ text: "التالي ▶️", callback_data: `page_${page+1}` });
  if (nav.length) buttons.push(nav);

  buttons.push([{ text: "🔙 القائمة الرئيسية", callback_data: "main_menu" }]);
  return { inline_keyboard: buttons };
}

function confirmDeleteKeyboard(caseId) {
  return {
    inline_keyboard: [[
      { text: "✅ نعم، احذف", callback_data: `confirm_delete_${caseId}` },
      { text: "❌ إلغاء",     callback_data: `view_${caseId}`           }
    ]]
  };
}

// ===== Persistent Reply Keyboard (الأزرار الثابتة في الأسفل) =====
function mainReplyKeyboard() {
  return {
    keyboard: [
      [
        { text: "📋 الطلبات" },
        { text: "➕ طلب جديد" },
        { text: "🔍 بحث" }
      ],
      [
        { text: "📂 مستندات" },
        { text: "📊 إحصائيات" },
        { text: "❓ مساعدة" }
      ]
    ],
    resize_keyboard:   true,   // تصغير الكيبورد تلقائياً
    persistent:        true,   // يبقى ثابتاً في الأسفل دائماً
    input_field_placeholder: "اكتب أمراً أو اختر من القائمة..."
  };
}

// ===== Set Bot Menu Button =====
async function setBotMenuButton() {
  try {
    // Set slash commands list
    await tg("setMyCommands", {
      commands: [
        { command: "menu",      description: "📋 القائمة الرئيسية" },
        { command: "add",       description: "➕ إضافة طلب جديد" },
        { command: "search",    description: "🔍 بحث عن طلب" },
        { command: "documents", description: "📂 رفع مستندات" },
        { command: "cases",     description: "📋 عرض كل الطلبات" },
        { command: "stats",     description: "📊 الإحصائيات" },
        { command: "help",      description: "❓ المساعدة" },
        { command: "logout",    description: "🔒 تسجيل الخروج" }
      ]
    });

    // Set menu button type to commands
    await tg("setChatMenuButton", {
      menu_button: { type: "commands" }
    });

    console.log("✅ تم ضبط أزرار القائمة الدائمة والأوامر");
  } catch(e) {
    console.error("setBotMenuButton:", e);
  }
}

// ===== Send With Persistent Keyboard =====
async function sendWithMenu(chatId, text, extra = {}) {
  return sendMessage(chatId, text, {
    reply_markup: mainReplyKeyboard(),
    ...extra
  });
}

// ===== Handle Update =====
async function handleUpdate(update) {
  try {
    if (update.callback_query) { await handleCallback(update.callback_query); return; }

    const msg    = update.message;
    if (!msg) return;

    const chatId = msg.chat.id;
    const text   = msg.text || "";

    // ---- Auth ----
    if (!authUsers.has(chatId)) {
      if (text.trim() === BOT_PASSWORD || text.startsWith("/start " + BOT_PASSWORD)) {
        await persistAuthAdd(chatId);\n        await sendMessage(chatId,
          `✅ <b>تم تسجيل الدخول بنجاح!</b>\n\n` +
          `مرحباً بك في نظام <b>El Ashry Pro</b> 🏥\n` +
          `مكتب الحاج أحمد الحديدي - عضو مجلس النواب\n\n` +
          `يمكنك التحكم الكامل في جميع الحالات من هنا\n\n` +
          `<i>📌 ستظهر لك قائمة الأزرار الثابتة في الأسفل تلقائياً</i>`,
          { reply_markup: mainReplyKeyboard() }
        );
      } else if (text.startsWith("/start")) {
        await sendMessage(chatId,
          `🏥 <b>El Ashry Pro - بوت إدارة الحالات</b>\n\nللدخول، أرسل كلمة المرور:`
        );
      } else {
        await sendMessage(chatId, "🔒 أرسل كلمة المرور للدخول:");
      }
      return;
    }

    // ---- Session ----
    const session = userSessions.get(chatId);
    if (session) { await handleSession(chatId, msg, session); return; }

    // ---- Standalone File Upload ----
    if (msg.document || msg.photo) { await handleFileUpload(chatId, msg); return; }

    // ---- Reply Keyboard Buttons (الأزرار الثابتة) ----
    const replyMap = {
      "📋 الطلبات":   () => showCasesList(chatId),
      "➕ طلب جديد":  () => startAddCase(chatId),
      "🔍 بحث":       () => startSearchFlow(chatId),
      "📂 مستندات":   () => startDocsUpload(chatId),
      "📊 إحصائيات": () => showStats(chatId),
      "❓ مساعدة":    () => showHelp(chatId),
    };
    if (replyMap[text]) { await replyMap[text](); return; }

    // ---- Commands ----
    if (text.startsWith("/start") || text.startsWith("/menu")) {
      await sendMessage(chatId, "📋 <b>القائمة الرئيسية</b>", { reply_markup: mainReplyKeyboard() });
      return;
    }
    if (text.startsWith("/help"))   { await showHelp(chatId); return; }
    if (text.startsWith("/logout")) {
      await persistAuthRemove(chatId);
      await deleteSession(chatId);
      await tg("sendMessage", {
        chat_id: chatId, text: "👋 تم تسجيل الخروج بنجاح",
        reply_markup: { remove_keyboard: true }
      });
      return;
    }
    if (text.startsWith("/cases"))   { await showCasesList(chatId); return; }
    if (text.startsWith("/add"))     { await startAddCase(chatId); return; }
    if (text.startsWith("/stats"))   { await showStats(chatId); return; }

    if (text.startsWith("/search")) {
      const query = text.replace("/search", "").trim();
      if (!query) { await sendMessage(chatId, "🔍 مثال: <code>/search أحمد</code>"); return; }
      await doSearch(chatId, query);
      return;
    }

    if (text.startsWith("/attach")) {
      const caseNumber = text.replace("/attach", "").trim();
      await startAttachFile(chatId, caseNumber);
      return;
    }

    if (text.startsWith("/documents") || text.startsWith("/docs")) {
      const arg = text.replace(/\/(documents|docs)/, "").trim();
      if (arg) {
        const allCases = await getAllCases();
        const c = allCases.find(x =>
          x.caseNumber === arg ||
          x.id === arg ||
          arabicSearch(x.personName, arg)
        );
        if (c) { await showCaseDocuments(chatId, c.id); return; }
        await sendMessage(chatId, `❌ لم يتم العثور على الحالة: ${arg}`);
      } else {
        await startDocsUpload(chatId);
      }
      return;
    }

    await sendMessage(chatId, "🤔 أمر غير معروف. اختر من القائمة أدناه 👇", {
      reply_markup: mainReplyKeyboard()
    });

  } catch (err) {
    console.error("handleUpdate error:", err);
  }
}

// ===== Handle Callback =====
async function handleCallback(cb) {
  const chatId = cb.message.chat.id;
  const data   = cb.data;

  if (!authUsers.has(chatId)) {
    await tg("answerCallbackQuery", { callback_query_id: cb.id, text: "يجب تسجيل الدخول أولاً" });
    return;
  }

  await tg("answerCallbackQuery", { callback_query_id: cb.id });

  try {
    if (data === "main_menu") {
      await sendMessage(chatId, "📋 <b>القائمة الرئيسية</b>", { reply_markup: mainReplyKeyboard() });
    }
    else if (data === "list_cases")   { await showCasesList(chatId); }
    else if (data === "add_case")     { await startAddCase(chatId); }
    else if (data === "stats")        { await showStats(chatId); }
    else if (data === "help")         { await showHelp(chatId); }
    else if (data === "docs_upload")  { await startDocsUpload(chatId); }

    else if (data === "search_start") {
      await persistSession(chatId, { state: "search_awaiting_query" });
      await sendMessage(chatId, "🔍 أرسل اسم الشخص أو رقم الطلب للبحث:\n\n<i>البحث يدعم اللغة العربية بصورة ذكية ويتجاهل الفرق في الهمزات والتشكيل</i>");
    }

    else if (data.startsWith("page_")) {
      const page  = parseInt(data.replace("page_", ""));
      const cases = (await getAllCases()).sort((a,b) => b.createdAt - a.createdAt);
      await sendMessage(chatId, `📋 <b>الطلبات</b> (${cases.length})`, { reply_markup: casesListKeyboard(cases, page) });
    }
    else if (data.startsWith("view_")) {
      const id = data.replace("view_", "");
      await showCaseDetail(chatId, id);
    }
    else if (data.startsWith("status_")) {
      const withoutPrefix  = data.replace("status_", "");
      const lastUnderscore = withoutPrefix.lastIndexOf("_");
      const caseId    = withoutPrefix.substring(0, lastUnderscore);
      const newStatus = withoutPrefix.substring(lastUnderscore + 1);
      await updateCase(caseId, { status: newStatus });
      const c = await getCaseById(caseId);
      await sendMessage(chatId, `✅ تم تحديث الطلب #${c.caseNumber} إلى: ${STATUS_LABELS[newStatus]}`);
      await showCaseDetail(chatId, caseId);
    }
    else if (data.startsWith("delete_")) {
      const id = data.replace("delete_", "");
      const c  = await getCaseById(id);
      await sendMessage(chatId,
        `⚠️ <b>تأكيد الحذف</b>\n\nهل أنت متأكد من حذف الطلب #${c.caseNumber} - ${c.personName}؟`,
        { reply_markup: confirmDeleteKeyboard(id) }
      );
    }
    else if (data.startsWith("confirm_delete_")) {
      const id = data.replace("confirm_delete_", "");
      const c  = await getCaseById(id);
      await deleteCase(id);
      await sendMessage(chatId,
        `🗑 تم حذف الطلب #${c?.caseNumber || id} بنجاح`,
        { reply_markup: mainReplyKeyboard() }
      );
    }
    else if (data.startsWith("respond_")) {
      const id = data.replace("respond_", "");
      await persistSession(chatId, { state: "respond_awaiting", caseId: id });
      await sendMessage(chatId, "💬 اكتب الرد:");
    }
    else if (data.startsWith("reject_")) {
      const id = data.replace("reject_", "");
      await persistSession(chatId, { state: "reject_awaiting", caseId: id });
      await sendMessage(chatId, "❌ اكتب سبب الرفض:");
    }
    else if (data.startsWith("docs_")) {
      const id = data.replace("docs_", "");
      await showCaseDocuments(chatId, id);
    }
    else if (data.startsWith("attach_")) {
      const id = data.replace("attach_", "");
      const c  = await getCaseById(id);
      if (!c) { await sendMessage(chatId, "❌ الطلب غير موجود"); return; }
      if ((c.documents || []).length >= MAX_DOCS) {
        await sendMessage(chatId, `⚠️ هذا الطلب وصل للحد الأقصى (${MAX_DOCS} ملفات)`);
        return;
      }
      await persistSession(chatId, {
        state: "attach_awaiting_file",
        caseId: c.id,
        caseNumber: c.caseNumber,
        documents: c.documents || []
      });
      const remaining = MAX_DOCS - (c.documents || []).length;
      await sendMessage(chatId,
        `📤 <b>إرفاق مستندات بطلب #${c.caseNumber}</b>\n\nأرسل ملف أو أكثر، ثم اكتب <code>تم</code>\nيمكنك رفع ${remaining} ملف بعد`
      );
    }
    else if (data.startsWith("wa_share_")) {
      const id = data.replace("wa_share_", "");
      const c  = await getCaseById(id);
      if (!c) { await sendMessage(chatId, "❌ الطلب غير موجود"); return; }
      const msg  = buildWhatsAppMessage(c);
      const link = `https://wa.me/?text=${encodeURIComponent(msg)}`;
      await sendMessage(chatId,
        `📤 <b>مشاركة الطلب عبر واتساب</b>\n\n<a href="${link}">اضغط هنا للفتح في واتساب</a>`,
        { disable_web_page_preview: false }
      );
    }
    else if (data.startsWith("svc_")) {
      const session = userSessions.get(chatId);
      if (session && session.state === "add_service") {
        const svcIndex = parseInt(data.replace("svc_", ""));
        await handleServiceSelection(chatId, svcIndex, session);
      }
    }

  } catch (err) {
    console.error("handleCallback error:", err);
    await sendMessage(chatId, "❌ حدث خطأ، حاول مرة أخرى");
  }
}

// ===== Session Handler =====
async function handleSession(chatId, msg, session) {
  const text = msg.text || "";

  switch (session.state) {

    case "add_name":
      if (!text.trim()) { await sendMessage(chatId, "⚠️ أرسل الاسم:"); return; }
      session.personName = text.trim();
      session.state = "add_phone";
      await persistSession(chatId, session);
      await sendMessage(chatId, `📱 أرسل رقم الهاتف:\n(أو أرسل <code>تخطي</code>)`);
      break;

    case "add_phone":
      session.personPhone = text.trim() === "تخطي" ? "" : text.trim();
      session.state = "add_nationalid";
      await persistSession(chatId, session);
      await sendMessage(chatId, `🆔 أرسل الرقم القومي:\n(أو أرسل <code>تخطي</code>)`);
      break;

    case "add_nationalid":
      session.nationalId = text.trim() === "تخطي" ? "" : text.trim();
      session.state = "add_country";
      await persistSession(chatId, session);
      await sendMessage(chatId, `🌍 أرسل الدولة:\n(مثال: مصر - ليبيا - السعودية)\n(أو أرسل <code>تخطي</code>)`);
      break;

    case "add_country":
      session.country = text.trim() === "تخطي" ? "" : text.trim();
      session.state = "add_hospital";
      await persistSession(chatId, session);
      await sendMessage(chatId, `🏥 أرسل اسم المستشفى:\n(أو أرسل <code>تخطي</code>)`);
      break;

    case "add_hospital":
      session.hospitalName = text.trim() === "تخطي" ? "" : text.trim();
      session.state = "add_submission_date";
      await persistSession(chatId, session);
      const today = new Date().toLocaleDateString("ar-EG", { year: "numeric", month: "2-digit", day: "2-digit" });
      await sendMessage(chatId, `📅 تاريخ تقديم الطلب:\n(اليوم: ${today})\n(أرسل التاريخ أو <code>اليوم</code> أو <code>تخطي</code>)`);
      break;

    case "add_submission_date": {
      const val = text.trim();
      if (val === "تخطي") {
        session.submissionDate = "";
      } else if (val === "اليوم") {
        session.submissionDate = new Date().toLocaleDateString("ar-EG");
      } else {
        session.submissionDate = val;
      }
      session.state = "add_response_date";
      await persistSession(chatId, session);
      await sendMessage(chatId, `📆 تاريخ الرد (اختياري):\n(أو أرسل <code>تخطي</code>)`);
      break;
    }

    case "add_response_date":
      session.responseDate = text.trim() === "تخطي" ? "" : text.trim();
      session.state = "add_service";
      await persistSession(chatId, session);
      const buttons = SERVICE_TYPES.map((s, i) => [{ text: s, callback_data: `svc_${i}` }]);
      buttons.push([{ text: "❌ إلغاء", callback_data: "main_menu" }]);
      await sendMessage(chatId, "🏥 اختر نوع الخدمة:", { reply_markup: { inline_keyboard: buttons } });
      break;

    case "add_description":
      session.description = text.trim() === "تخطي" ? "" : text.trim();
      session.state = "add_files";
      session.documents = [];
      await persistSession(chatId, session);
      await sendMessage(chatId,
        `📎 أرسل المستندات الآن (صور/PDF/ملفات):\n\n` +
        `أرسل ملف أو أكثر (حتى ${MAX_DOCS} ملفات)، ثم أرسل <code>تم</code>\n` +
        `(أو أرسل <code>تخطي</code> بدون مستندات)`
      );
      break;

    case "add_files":
      if (text.trim() === "تم" || text.trim() === "تخطي") {
        const caseData = {
          personName:      session.personName,
          personPhone:     session.personPhone     || "",
          nationalId:      session.nationalId      || "",
          country:         session.country         || "",
          hospitalName:    session.hospitalName    || "",
          submissionDate:  session.submissionDate  || "",
          responseDate:    session.responseDate    || "",
          serviceType:     session.serviceType,
          description:     session.description    || "",
          status:          "under_review",
          response:        "",
          rejectionReason: "",
          documents:       session.documents || []
        };
        const newCase = await createCase(caseData);
        await deleteSession(chatId);
        await sendMessage(chatId,
          `✅ <b>تم إنشاء الطلب بنجاح!</b>\n\n${formatCase(newCase)}`,
          { reply_markup: mainReplyKeyboard() }
        );
      } else if (msg.document || msg.photo) {
        if ((session.documents || []).length >= MAX_DOCS) {
          await sendMessage(chatId, `⚠️ وصلت للحد الأقصى (${MAX_DOCS} ملفات). أرسل <code>تم</code> لإنهاء`);
          return;
        }
        const fileId   = msg.document?.file_id || msg.photo?.[msg.photo.length-1]?.file_id;
        const fileName = msg.document?.file_name || `صورة_${(session.documents||[]).length+1}.jpg`;
        if (!session.documents) session.documents = [];
        const result = await saveFileToChannel(fileId, fileName);
        session.documents.push({
          name:              fileName,
          telegramFileId:    result ? result.fileId    : fileId,
          telegramMessageId: result ? result.messageId : null,
          type:              msg.document ? "document" : "image",
          size:              msg.document?.file_size || 0,
          uploadedAt:        Date.now()
        });
        await persistSession(chatId, session);
        const remaining = MAX_DOCS - session.documents.length;
        await sendMessage(chatId,
          `✅ تم رفع: ${fileName}\n📎 إجمالي: ${session.documents.length}/${MAX_DOCS}\n\n` +
          (remaining > 0 ? `أرسل المزيد أو اكتب <code>تم</code>` : `وصلت للحد الأقصى. أرسل <code>تم</code>`)
        );
      } else {
        await sendMessage(chatId, "📎 أرسل ملفات أو اكتب <code>تم</code> لإنهاء");
      }
      break;

    case "search_awaiting_query":
      await doSearch(chatId, text.trim());
      await deleteSession(chatId);
      break;

    case "respond_awaiting":
      await updateCase(session.caseId, { status: "responded", response: text.trim() });
      await deleteSession(chatId);
      await sendMessage(chatId, "✅ تم حفظ الرد بنجاح");
      await showCaseDetail(chatId, session.caseId);
      break;

    case "reject_awaiting":
      await updateCase(session.caseId, { status: "rejected", rejectionReason: text.trim() });
      await deleteSession(chatId);
      await sendMessage(chatId, "✅ تم حفظ سبب الرفض");
      await showCaseDetail(chatId, session.caseId);
      break;

    case "attach_awaiting_file":
      await handleAttachFile(chatId, msg, session);
      break;

    // Documents upload flow
    case "docs_find_case":
      await handleDocsFindCase(chatId, text.trim(), session);
      break;

    case "docs_awaiting_file":
      await handleDocsFile(chatId, msg, session);
      break;
  }
}

// ===== Service Selection =====
async function handleServiceSelection(chatId, serviceIndex, session) {
  session.serviceType = SERVICE_TYPES[serviceIndex];
  session.state       = "add_description";
  await persistSession(chatId, session);
  await sendMessage(chatId, `📝 اكتب وصف الحالة:\n(أو أرسل <code>تخطي</code>)`);
}

// ===== Search Flow Start =====
async function startSearchFlow(chatId) {
  await persistSession(chatId, { state: "search_awaiting_query" });
  await sendMessage(chatId, "🔍 أرسل اسم الشخص أو رقم الطلب للبحث:\n\n<i>البحث يدعم اللغة العربية بصورة ذكية ويتجاهل الفرق في الهمزات والتشكيل</i>");
}

// ===== Add Case =====
async function startAddCase(chatId) {
  await persistSession(chatId, { state: "add_name" });
  await sendMessage(chatId, "➕ <b>إضافة طلب جديد</b>\n\n👤 أرسل اسم الشخص:");
}

// ===== Cases List =====
async function showCasesList(chatId) {
  const cases = await getAllCases();
  if (cases.length === 0) {
    await sendMessage(chatId, "📋 لا توجد طلبات بعد\nاستخدم /add لإضافة طلب جديد", {
      reply_markup: mainReplyKeyboard()
    });
    return;
  }
  const sorted = cases.sort((a,b) => b.createdAt - a.createdAt);
  await sendMessage(chatId, `📋 <b>الطلبات</b> (${sorted.length})`, { reply_markup: casesListKeyboard(sorted, 0) });
}

// ===== Case Detail =====
async function showCaseDetail(chatId, id) {
  const c = await getCaseById(id);
  if (!c) { await sendMessage(chatId, "❌ الطلب غير موجود"); return; }

  const extraButtons = [];
  if (c.status !== "responded") extraButtons.push([{ text: "💬 إضافة رد",    callback_data: `respond_${id}` }]);
  if (c.status !== "rejected")  extraButtons.push([{ text: "❌ رفض الطلب",  callback_data: `reject_${id}`  }]);

  extraButtons.push([{ text: "📤 مشاركة واتساب", callback_data: `wa_share_${id}` }]);

  if (c.documents && c.documents.length > 0) {
    extraButtons.push([
      { text: `📎 عرض المستندات (${c.documents.length})`, callback_data: `docs_${id}` },
      { text: "📤 إرفاق مستند", callback_data: `attach_${id}` }
    ]);
  } else {
    extraButtons.push([{ text: "📤 إرفاق مستند", callback_data: `attach_${id}` }]);
  }

  const keyboard = statusKeyboard(id);
  keyboard.inline_keyboard = [...extraButtons, ...keyboard.inline_keyboard];

  await sendMessage(chatId, formatCase(c), { reply_markup: keyboard });
}

// ===== Case Documents =====
async function showCaseDocuments(chatId, id) {
  const c = await getCaseById(id);
  if (!c || !c.documents || c.documents.length === 0) {
    await sendMessage(chatId, "📎 لا توجد مستندات لهذا الطلب\n\nاستخدم /attach لرفع مستندات");
    return;
  }
  await sendMessage(chatId, `📎 <b>مستندات الطلب #${c.caseNumber} - ${c.personName}</b> (${c.documents.length} ملف)`);
  for (const doc of c.documents) {
    if (doc.telegramFileId) {
      const uploadedDate = doc.uploadedAt
        ? new Date(doc.uploadedAt).toLocaleDateString("ar-EG")
        : "—";
      const sizeStr = doc.size ? `\n📦 الحجم: ${(doc.size/1024).toFixed(0)} KB` : "";
      await sendDocument(chatId, doc.telegramFileId, `📎 ${doc.name}\n📅 ${uploadedDate}${sizeStr}`);
    }
  }
  await sendMessage(chatId, "─────────────────", {
    reply_markup: { inline_keyboard: [[
      { text: "📤 إرفاق مزيد", callback_data: `attach_${id}` },
      { text: "🔙 رجوع",       callback_data: `view_${id}` }
    ]]}
  });
}

// ===== Documents Upload Flow (/documents command) =====
async function startDocsUpload(chatId) {
  await persistSession(chatId, { state: "docs_find_case" });
  await sendMessage(chatId,
    `📂 <b>رفع مستندات لطلب</b>\n\nأرسل رقم الطلب أو اسم الشخص:`
  );
}

async function handleDocsFindCase(chatId, query, session) {
  const allCases = await getAllCases();
  const found = allCases.filter(x =>
    x.caseNumber === query ||
    x.id === query ||
    arabicSearch(x.personName, query)
  );

  if (found.length === 0) {
    await sendMessage(chatId, `❌ لم يتم العثور على طلب بـ: "${query}"\nأرسل رقم الطلب أو الاسم مجدداً:`);
    return;
  }

  if (found.length === 1) {
    const c = found[0];
    if ((c.documents || []).length >= MAX_DOCS) {
      await sendMessage(chatId, `⚠️ الطلب #${c.caseNumber} وصل للحد الأقصى (${MAX_DOCS} ملفات)`);
      await deleteSession(chatId);
      return;
    }
    session.caseId     = c.id;
    session.caseNumber = c.caseNumber;
    session.documents  = c.documents || [];
    session.state      = "docs_awaiting_file";
    await persistSession(chatId, session);
    const remaining = MAX_DOCS - session.documents.length;
    await sendMessage(chatId,
      `✅ تم العثور على الطلب: <b>#${c.caseNumber} - ${c.personName}</b>\n\n` +
      `📤 أرسل المستندات الآن (حتى ${remaining} ملف)\n` +
      `ثم أرسل <code>تم</code> للحفظ\n\n` +
      `يُقبل: PDF, JPG, PNG, DOCX وغيرها`
    );
    return;
  }

  // Multiple results
  const buttons = found.slice(0, 8).map(c => [{
    text: `#${c.caseNumber} - ${c.personName}`,
    callback_data: `attach_${c.id}`
  }]);
  buttons.push([{ text: "❌ إلغاء", callback_data: "main_menu" }]);
  await deleteSession(chatId);
  await sendMessage(chatId,
    `🔍 تم العثور على ${found.length} طلبات. اختر الطلب:`,
    { reply_markup: { inline_keyboard: buttons } }
  );
}

async function handleDocsFile(chatId, msg, session) {
  const text = msg.text || "";

  if (text.trim() === "تم") {
    await updateCase(session.caseId, { documents: session.documents });
    await deleteSession(chatId);
    await sendMessage(chatId,
      `✅ تم حفظ ${session.documents.length} مستند لطلب #${session.caseNumber}`,
      { reply_markup: mainReplyKeyboard() }
    );
    return;
  }

  if (msg.document || msg.photo) {
    if (session.documents.length >= MAX_DOCS) {
      await sendMessage(chatId, `⚠️ وصلت للحد الأقصى (${MAX_DOCS} ملفات). أرسل <code>تم</code> لإنهاء`);
      return;
    }
    const fileId   = msg.document?.file_id || msg.photo?.[msg.photo.length-1]?.file_id;
    const fileName = msg.document?.file_name || `صورة_${session.documents.length+1}.jpg`;
    const result   = await saveFileToChannel(fileId, fileName);
    session.documents.push({
      name:              fileName,
      telegramFileId:    result ? result.fileId    : fileId,
      telegramMessageId: result ? result.messageId : null,
      type:              msg.document ? "document" : "image",
      size:              msg.document?.file_size || 0,
      uploadedAt:        Date.now()
    });
    await persistSession(chatId, session);
    const remaining = MAX_DOCS - session.documents.length;
    await sendMessage(chatId,
      `✅ تم رفع: ${fileName}\n📎 إجمالي: ${session.documents.length}/${MAX_DOCS}\n\n` +
      (remaining > 0 ? `أرسل المزيد أو اكتب <code>تم</code>` : `وصلت للحد الأقصى. أرسل <code>تم</code>`)
    );
  } else {
    await sendMessage(chatId, "📎 أرسل ملف أو اكتب <code>تم</code> لإنهاء");
  }
}

// ===== Search =====
async function doSearch(chatId, query) {
  const results = await searchCases(query);
  if (results.length === 0) {
    await sendMessage(chatId, `🔍 لا توجد نتائج لـ: "${query}"`, { reply_markup: mainReplyKeyboard() });
    return;
  }
  const sorted = results.sort((a,b) => b.createdAt - a.createdAt);
  await sendMessage(chatId, `🔍 <b>نتائج البحث عن "${query}"</b> (${sorted.length} نتيجة)`, {
    reply_markup: casesListKeyboard(sorted, 0)
  });
}

// ===== Stats =====
async function showStats(chatId) {
  const cases   = await getAllCases();
  const total   = cases.length;
  const counts  = { executed:0, under_review:0, under_procedure:0, responded:0, rejected:0 };
  let totalDocs = 0;
  const countryMap  = {};
  const hospitalMap = {};

  cases.forEach(c => {
    if (counts[c.status] !== undefined) counts[c.status]++;
    if (c.documents) totalDocs += c.documents.length;
    if (c.country)      countryMap[c.country]       = (countryMap[c.country]       || 0) + 1;
    if (c.hospitalName) hospitalMap[c.hospitalName]  = (hospitalMap[c.hospitalName] || 0) + 1;
  });

  let text = `📊 <b>إحصائيات El Ashry Pro</b>\n\n`;
  text += `📋 إجمالي الطلبات: <b>${total}</b>\n\n`;
  for (const [key, label] of Object.entries(STATUS_LABELS)) {
    text += `${label}: <b>${counts[key]}</b>\n`;
  }
  text += `\n📎 إجمالي المستندات: <b>${totalDocs}</b>`;

  const topCountries = Object.entries(countryMap).sort((a,b) => b[1]-a[1]).slice(0,3);
  if (topCountries.length > 0) {
    text += `\n\n🌍 <b>أكثر الدول:</b>\n`;
    topCountries.forEach(([c,n]) => { text += `  • ${c}: ${n}\n`; });
  }

  await sendMessage(chatId, text, { reply_markup: mainReplyKeyboard() });
}

// ===== Help =====
async function showHelp(chatId) {
  await sendMessage(chatId,
    `📋 <b>دليل الاستخدام - El Ashry Pro v4</b>\n\n` +
    `<b>القائمة الثابتة في الأسفل:</b>\n` +
    `📋 الطلبات - عرض جميع الطلبات\n` +
    `➕ طلب جديد - إضافة طلب جديد\n` +
    `🔍 بحث - البحث الذكي\n` +
    `📂 مستندات - رفع مستندات\n` +
    `📊 إحصائيات - الإحصائيات\n\n` +
    `<b>الأوامر النصية:</b>\n` +
    `/add - إضافة طلب جديد\n` +
    `/cases - عرض كل الطلبات\n` +
    `/search أحمد - بحث بالاسم أو الرقم\n` +
    `/documents - رفع مستندات لطلب\n` +
    `/attach 5 - إرفاق ملف بطلب رقم 5\n` +
    `/stats - الإحصائيات\n` +
    `/logout - تسجيل الخروج\n\n` +
    `<b>رفع المستندات على التلجرام:</b>\n` +
    `📎 يمكنك رفع أي ملف (PDF/صورة/وثيقة) مباشرة في المحادثة وسيُحفظ في القناة وربطه بالطلب\n\n` +
    `<b>ميزات النظام:</b>\n` +
    `🌍 دعم البلد والمستشفى\n` +
    `📅 تواريخ تقديم ورد\n` +
    `🔍 بحث عربي ذكي\n` +
    `📤 مشاركة واتساب\n` +
    `📎 حتى ${MAX_DOCS} مستندات لكل طلب`,
    { reply_markup: mainReplyKeyboard() }
  );
}

// ===== Standalone File Upload =====
async function handleFileUpload(chatId, msg) {
  const fileId   = msg.document?.file_id || msg.photo?.[msg.photo.length-1]?.file_id;
  const fileName = msg.document?.file_name || "صورة";
  if (!fileId) return;

  const result = await saveFileToChannel(fileId, fileName);
  if (result) {
    await sendMessage(chatId,
      `✅ <b>تم حفظ المستند في القناة</b>\n\n` +
      `📄 ${fileName}\n\n` +
      `💡 لإرفاقه بطلب:\n<code>/documents</code>`
    );
  } else {
    await sendMessage(chatId, `✅ تم استلام: ${fileName}\n⚠️ لم يتم حفظه في القناة`);
  }
}

// ===== Attach File to Case =====
async function startAttachFile(chatId, caseNumber) {
  if (!caseNumber) {
    await sendMessage(chatId, "📝 مثال: <code>/attach 5</code> أو <code>/attach أحمد محمد</code>");
    return;
  }
  const allCases = await getAllCases();
  const c = allCases.find(x =>
    x.caseNumber === caseNumber ||
    x.id === caseNumber ||
    arabicSearch(x.personName, caseNumber)
  );
  if (!c) { await sendMessage(chatId, `❌ لم يتم العثور على الحالة: ${caseNumber}`); return; }

  if ((c.documents || []).length >= MAX_DOCS) {
    await sendMessage(chatId, `⚠️ الطلب #${c.caseNumber} وصل للحد الأقصى (${MAX_DOCS} ملفات)`);
    return;
  }

  await persistSession(chatId, {
    state: "attach_awaiting_file",
    caseId: c.id,
    caseNumber: c.caseNumber,
    documents: c.documents || []
  });
  const remaining = MAX_DOCS - (c.documents || []).length;
  await sendMessage(chatId,
    `📎 أرسل المستندات لطلب #${c.caseNumber} - ${c.personName}:\n` +
    `(أرسل ملف أو أكثر، حتى ${remaining} ملف، ثم أرسل <code>تم</code>)`
  );
}

async function handleAttachFile(chatId, msg, session) {
  const text = msg.text;
  if (text && text.trim() === "تم") {
    await updateCase(session.caseId, { documents: session.documents });
    await deleteSession(chatId);
    await sendMessage(chatId,
      `✅ تم حفظ ${session.documents.length} مستند لطلب #${session.caseNumber}`,
      { reply_markup: mainReplyKeyboard() }
    );
    return;
  }

  const fileId   = msg.document?.file_id || msg.photo?.[msg.photo.length-1]?.file_id;
  const fileName = msg.document?.file_name || `صورة_${session.documents.length+1}.jpg`;
  if (!fileId) { await sendMessage(chatId, "📎 أرسل ملف أو اكتب <code>تم</code> لإنهاء"); return; }

  if (session.documents.length >= MAX_DOCS) {
    await sendMessage(chatId, `⚠️ وصلت للحد الأقصى. أرسل <code>تم</code>`);
    return;
  }

  const result = await saveFileToChannel(fileId, fileName);
  session.documents.push({
    name:              fileName,
    telegramFileId:    result ? result.fileId    : fileId,
    telegramMessageId: result ? result.messageId : null,
    type:              msg.document ? "document" : "image",
    size:              msg.document?.file_size || 0,
    uploadedAt:        Date.now()
  });
  await persistSession(chatId, session);

  const remaining = MAX_DOCS - session.documents.length;
  await sendMessage(chatId,
    `✅ تم رفع: ${fileName}\n📎 إجمالي: ${session.documents.length}/${MAX_DOCS}\n\n` +
    (remaining > 0 ? `أرسل المزيد أو اكتب <code>تم</code>` : `وصلت للحد الأقصى. أرسل <code>تم</code>`)
  );
}

// ===== Auto-Restart Every 5 Hours =====
const RESTART_HOURS = 5;
const RESTART_MS    = RESTART_HOURS * 60 * 60 * 1000;

function scheduleAutoRestart() {
  const next = new Date(Date.now() + RESTART_MS);
  console.log(`⏰ إعادة التشغيل التلقائية القادمة: ${next.toLocaleString("ar-EG")}`);

  setTimeout(async () => {
    console.log("🔄 إعادة تشغيل تلقائية...");
    for (const chatId of authUsers) {
      try {
        await sendMessage(chatId,
          `🔄 <b>إعادة تشغيل تلقائية</b>\n\n` +
          `⏱ البوت يعيد تشغيل نفسه كل ${RESTART_HOURS} ساعات\n` +
          `✅ سيعود خلال ثوانٍ...`
        );
      } catch(e) {}
    }
    await new Promise(r => setTimeout(r, 2000));
    process.exit(0);
  }, RESTART_MS);
}

// ===== Polling =====
let lastUpdateId = 0;

async function startPolling() {
  console.log("🤖 El Ashry Pro Bot v4.0 - جاري التشغيل...");
  console.log(`👤 ${BOT_USERNAME}`);
  console.log(`📌 Token:   ✅ ${BOT_TOKEN.slice(0,10)}...`);
  console.log(`📌 Channel: ✅ ${CHANNEL_ID}`);
  console.log(`🔑 Password: ${BOT_PASSWORD}`);
  console.log(`📎 الحد الأقصى للمستندات: ${MAX_DOCS} ملف`);
  console.log("─────────────────────────────────────────");

  await loadAuthUsers();
  await loadSessions();
  console.log(`✅ تم تحميل ${authUsers.size} مستخدم و ${userSessions.size} جلسة`);

  await setBotMenuButton();

  scheduleAutoRestart();

  while (true) {
    try {
      const res = await tg("getUpdates", {
        offset:          lastUpdateId + 1,
        timeout:         30,
        allowed_updates: ["message", "callback_query"]
      });

      if (res.ok && res.result) {
        for (const update of res.result) {
          lastUpdateId = update.update_id;
          await handleUpdate(update);
        }
      }
    } catch (err) {
      console.error("Polling error:", err.message);
      await new Promise(r => setTimeout(r, 3000));
    }
  }
}

startPolling();
