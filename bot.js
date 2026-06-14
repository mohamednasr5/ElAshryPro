// ============================================================
//  El Ashry Pro - Telegram Bot v4.0
//  بوت تليجرام كامل للتحكم في نظام إدارة الحالات
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
const { initializeApp } = require("firebase/app");
const { getDatabase, ref, set, get, update, remove, push, onValue } = require("firebase/database");

const firebaseApp = initializeApp(FIREBASE_CONFIG);
const db          = getDatabase(firebaseApp);

// ===== Firebase Connection Monitor =====
let firebaseConnected = true;
const connRef = ref(db, ".info/connected");
onValue(connRef, (snap) => {
  firebaseConnected = snap.val() === true;
  if (firebaseConnected) {
    console.log("✅ Firebase: متصل");
  } else {
    console.warn("⚠️ Firebase: غير متصل - جاري إعادة المحاولة...");
  }
});

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

// ===== State =====
const authUsers    = new Set();
const userSessions = new Map();

// ===== منع تكرار معالجة نفس التحديث =====
const processedUpdates = new Set();
const MAX_PROCESSED    = 500;  // حد أقصى للذاكرة

function isUpdateProcessed(updateId) {
  if (processedUpdates.has(updateId)) return true;
  processedUpdates.add(updateId);
  // حذف الأقدم لو تجاوزنا الحد
  if (processedUpdates.size > MAX_PROCESSED) {
    const arr = [...processedUpdates];
    arr.splice(0, arr.length - MAX_PROCESSED).forEach(id => processedUpdates.delete(id));
  }
  return false;
}

// ===== Telegram API =====
async function tg(method, data = {}) {
  try {
    const url     = `https://api.telegram.org/bot${BOT_TOKEN}/${method}`;
    const hasFile = data.document || data.photo;

    if (hasFile) {
      const formData = new FormData();
      for (const [k, v] of Object.entries(data)) formData.append(k, v);
      const res = await fetch(url, { method: "POST", body: formData });
      return res.json();
    }

    const res = await fetch(url, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify(data)
    });
    return res.json();
  } catch (error) {
    console.error(`❌ Telegram API Error (${method}):`, error.message);
    return { ok: false, error: error.message };
  }
}

async function sendMessage(chatId, text, extra = {}) {
  try {
    if (!chatId || !text) {
      console.error("❌ sendMessage: chatId or text is missing", { chatId, text: text?.slice(0, 50) });
      return null;
    }
    return tg("sendMessage", { chat_id: chatId, text, parse_mode: "HTML", ...extra });
  } catch (error) {
    console.error("❌ Error sending message:", error.message);
    return null;
  }
}

async function sendDocument(chatId, fileId, caption = "") {
  return tg("sendDocument", { chat_id: chatId, document: fileId, caption, parse_mode: "HTML" });
}

// ===== Set Bot Commands (Menu Button) =====
async function setBotCommands() {
  await tg("setMyCommands", {
    commands: [
      { command: "menu",   description: "📋 القائمة الرئيسية" },
      { command: "add",    description: "➕ إضافة طلب جديد"  },
      { command: "cases",  description: "📋 عرض كل الطلبات"  },
      { command: "search", description: "🔍 بحث عن طلب"      },
      { command: "stats",  description: "📊 الإحصائيات"      },
      { command: "attach", description: "📎 إرفاق ملف بطلب"  },
      { command: "help",   description: "❓ المساعدة"         },
      { command: "logout", description: "🚪 تسجيل الخروج"    }
    ]
  });

  await tg("setChatMenuButton", {
    menu_button: { type: "commands" }
  });

  console.log("✅ تم ضبط أوامر البوت وزر القائمة");
}

// ===== Firebase Helpers =====
// ===== Firebase Retry Helper =====
async function firebaseRetry(fn, retries = 3, delay = 2000) {
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (err) {
      console.error(`❌ Firebase attempt ${i + 1}/${retries} failed:`, err.message);
      if (i < retries - 1) {
        await new Promise(r => setTimeout(r, delay * (i + 1)));
      } else {
        throw err;
      }
    }
  }
}

async function getAllCases() {
  return firebaseRetry(async () => {
    const snap = await get(ref(db, "cases"));
    const data = snap.val() || {};
    // ✅ استخدام Object.entries للحصول على مفتاح Firebase كـ id
    // ✅ لا نحمّل documents في قائمة الطلبات (صور base64 كبيرة = بطء)
    return Object.entries(data)
      .filter(([id, val]) => val !== null && typeof val === 'object')
      .map(([id, val]) => {
        const { documents, ...valWithoutDocs } = val;
        const docCount = documents ? Object.keys(documents).length : 0;
        return normalizeCaseData({ id, ...valWithoutDocs, _docCount: docCount });
      });
  });
}

async function getCaseById(id) {
  return firebaseRetry(async () => {
    const snap = await get(ref(db, `cases/${id}`));
    const data = snap.val();
    // ✅ إضافة id للبيانات لأن Firebase لا تخزنه داخل الكائن
    return data ? normalizeCaseData({ id, ...data }) : null;
  });
}

// ✅ دالة لتحويل البيانات القديمة إلى الصيغة الجديدة (Backward Compatible)
function normalizeCaseData(c) {
  // ✅ تحويل caseNumber لصيغة موحدة (رقم أو نص)
  const rawNum = c.caseNumber;
  const caseNumber = rawNum != null
    ? (typeof rawNum === 'number' ? `EA-${rawNum}` : String(rawNum))
    : null;

  // ✅ الحقول القديمة أولاً (من Firebase) ثم القيم المحسوبة تستبدلها
  return {
    // أولاً: الحقول الخام من Firebase (للتوافق مع الحقول غير المعالجة)
    ...c,
    
    // ثانياً: القيم المحسوبة - تستبدل أي قيمة من ...c
    // البيانات الأساسية
    id: c.id || null,
    caseNumber: caseNumber || `#${c.id?.slice(0, 8) || "N/A"}`,
    createdAt: c.createdAt ? new Date(c.createdAt).getTime() : Date.now(),
    updatedAt: c.updatedAt ? new Date(c.updatedAt).getTime() : Date.now(),
    
    // البيانات الشخصية (دعم الصيغة القديمة والجديدة)
    // ✅ استخدام || للتحقق من القيمة الفعلية (ليس فقط null/undefined)
    personName:  (c.personName && c.personName.trim()) || (c.name && c.name.trim()) || "بدون اسم",
    personPhone: (c.personPhone && c.personPhone.trim()) || (c.phone && c.phone.trim()) || "",
    nationalId:  c.nationalId  || "",
    
    // بيانات الطلب
    serviceType: (c.serviceType && c.serviceType.trim()) || (c.service && c.service.trim()) || "غير محدد",
    description: (c.description && c.description.trim()) || (c.desc && c.desc.trim()) || "",
    
    // البيانات الإضافية (دعم الحقول القديمة)
    status:          c.status          || "under_review",
    // ✅ تحويل documents من object (Firebase) إلى array
    documents: (() => {
      const docs = c.documents;
      if (!docs) return [];
      if (Array.isArray(docs)) return docs;
      // object من Firebase → تحويل لـ array
      return Object.values(docs);
    })(),
    response:        c.response        ?? "",
    rejectionReason: c.rejectionReason ?? "",
    country:         c.country         ?? "",
    hospital:        c.hospital        ?? "",
    submissionDate:  c.submissionDate  ?? "",
    responseDate:    c.responseDate    ?? ""
  };
}

async function createCase(data) {
  return firebaseRetry(async () => {
    const newRef = push(ref(db, "cases"));
    const id     = newRef.key;
    const now    = Date.now();
    const d      = new Date();
    const all    = await getAllCases();
    const num    = `EA-${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}-${String(all.length + 1).padStart(4, "0")}`;
    const caseData = {
      id,
      caseNumber: num,
      personName:  data.personName  || data.name     || "",
      personPhone: data.personPhone || data.phone    || "",
      nationalId:  data.nationalId  || "",
      serviceType: data.serviceType || data.service  || "",
      description: data.description || data.desc     || "",
      country:      data.country      || "",
      hospital:     data.hospital     || "",
      submissionDate: data.submissionDate || new Date().toISOString().split('T')[0],
      status:          data.status          || "under_review",
      response:        data.response        || "",
      rejectionReason: data.rejectionReason || "",
      documents:       data.documents       || [],
      createdAt: now,
      updatedAt: now
    };
    await set(newRef, caseData);
    return caseData;
  });
}

async function updateCase(id, data) {
  return firebaseRetry(async () => {
    await update(ref(db, `cases/${id}`), { ...data, updatedAt: Date.now() });
  });
}

async function deleteCase(id) {
  return firebaseRetry(async () => {
    const c = await getCaseById(id);
    if (c && c.documents) {
      for (const doc of c.documents) {
        if (doc.telegramMessageId) {
          try {
            await tg("deleteMessage", { chat_id: CHANNEL_ID, message_id: doc.telegramMessageId });
          } catch (e) {}
        }
      }
    }
    await remove(ref(db, `cases/${id}`));
  });
}

// ===== بحث ذكي: يفصل الكلمات ويبحث بأي كلمة =====
function smartMatch(text, query) {
  if (!text || !query) return false;
  const t = text.toLowerCase().replace(/[\u064B-\u065F]/g, ""); // إزالة التشكيل
  const q = query.toLowerCase().replace(/[\u064B-\u065F]/g, "");
  // بحث مباشر
  if (t.includes(q)) return true;
  // فصل كلمات البحث
  const words = q.split(/\s+/).filter(w => w.length > 0);
  if (words.length <= 1) return false;
  // أي كلمة من البحث موجودة في النص
  return words.some(word => t.includes(word));
}

async function searchCases(query) {
  const all = await getAllCases();
  const q   = query.toLowerCase().trim();
  if (!q) return [];
  
  // فصل كلمات البحث
  const queryWords = q.split(/\s+/).filter(w => w.length > 0);
  
  // ترتيب النتائج حسب مدى التطابق
  const scored = all.map(c => {
    let score = 0;
    try {
      const name     = (c.personName || c.name || "").toLowerCase();
      const phone    = (c.personPhone || c.phone || "").toLowerCase();
      const num      = (c.caseNumber || "").toString().toLowerCase();
      const natId    = (c.nationalId || "").toLowerCase();
      const country  = (c.country || "").toLowerCase();
      const hospital = (c.hospital || "").toLowerCase();
      const svc      = (c.serviceType || c.service || "").toLowerCase();
      const desc     = (c.description || c.desc || "").toLowerCase();
      
      // تجميع كل الحقول القابلة للبحث
      const allFields = [name, phone, num, natId, country, hospital, svc, desc];
      
      for (const field of allFields) {
        // تطابق كامل للنص = أعلى نقاط
        if (field === q) { score += 10; continue; }
        // تطابق كامل من البداية = نقاط عالية
        if (field.startsWith(q)) { score += 7; continue; }
        // النص يحتوي على البحث بالكامل = نقاط جيدة
        if (field.includes(q)) { score += 5; continue; }
        // كل كلمة من البحث موجودة في الحقل
        if (queryWords.length > 1) {
          const allWordsMatch = queryWords.every(w => field.includes(w));
          if (allWordsMatch) { score += 4; continue; }
          // أي كلمة من البحث موجودة
          const someWordsMatch = queryWords.some(w => field.includes(w));
          if (someWordsMatch) { score += 2; continue; }
        }
        // بحث ذكي: كل كلمة في الحقل تحتوي على كلمة البحث أو العكس
        const fieldWords = field.split(/\s+/);
        for (const fw of fieldWords) {
          for (const qw of queryWords) {
            if (fw.includes(qw) || qw.includes(fw)) { score += 1; break; }
          }
        }
      }
    } catch (e) {
      console.error("❌ خطأ في البحث:", e.message, c);
    }
    return { case: c, score };
  }).filter(item => item.score > 0);
  
  // ترتيب حسب النقاط (الأعلى أولاً)
  scored.sort((a, b) => b.score - a.score);
  return scored.map(item => item.case);
}

// ===== Save file to Telegram channel =====
async function saveFileToChannel(fileId, fileName, caseNumber = "") {
  const caption = caseNumber
    ? `📁 <b>${fileName}</b>\n🔗 طلب: #${caseNumber}`
    : `📁 <b>${fileName}</b>`;

  const result = await tg("sendDocument", {
    chat_id:    CHANNEL_ID,
    document:   fileId,
    caption,
    parse_mode: "HTML"
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
function formatCase(c) {
  // ✅ Safe values: إذا كانت undefined، استخدم قيمة افتراضية
  const caseNum = c.caseNumber || `#${c.id?.slice(0, 8) || "N/A"}`;
  const personName = c.personName || c.name || "بدون اسم";
  const serviceType = c.serviceType || c.service || "غير محدد";
  const statusLabel = STATUS_LABELS[c.status] || c.status || "غير محدد";
  
  let text = `<b>📋 طلب ${caseNum}</b>\n\n`;
  text += `👤 <b>الاسم:</b> ${personName}\n`;
  if (c.personPhone || c.phone) {
    const phone = c.personPhone || c.phone;
    const wa = phone.replace(/^0/, "");
    text += `📱 <b>الهاتف:</b> <code>${phone}</code> | <a href="https://wa.me/2${wa}">واتساب</a>\n`;
  }
  if (c.nationalId)  text += `🆔 <b>الرقم القومي:</b> <code>${c.nationalId}</code>\n`;
  if (c.country)     text += `🏠 <b>القرية/المنطقة:</b> ${c.country}\n`;
  if (c.hospital)    text += `🏥 <b>المستشفى:</b> ${c.hospital}\n`;
  text += `🏥 <b>الخدمة:</b> ${serviceType}\n`;
  text += `📌 <b>الحالة:</b> ${statusLabel}\n`;
  if (c.description || c.desc) text += `📝 <b>الوصف:</b> ${c.description || c.desc}\n`;
  if (c.submissionDate) text += `📅 <b>تاريخ التقديم:</b> ${c.submissionDate}\n`;
  if (c.status === "responded" && c.response)        text += `💬 <b>الرد:</b> ${c.response}\n`;
  if (c.status === "rejected"  && c.rejectionReason) text += `❌ <b>سبب الرفض:</b> ${c.rejectionReason}\n`;
  if (c.documents && c.documents.length > 0)         text += `📎 <b>المستندات:</b> ${c.documents.length} ملف\n`;
  const d = new Date(c.createdAt || Date.now());
  text += `\n📅 ${d.toLocaleDateString("ar-EG", { year: "numeric", month: "long", day: "numeric", hour: "2-digit", minute: "2-digit" })}`;
  return text;
}

// ===== Keyboards =====
function mainMenuKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: "📋 عرض الطلبات", callback_data: "list_cases" },
        { text: "➕ طلب جديد",    callback_data: "add_case"   }
      ],
      [
        { text: "🔍 بحث",      callback_data: "search_start" },
        { text: "📊 إحصائيات", callback_data: "stats"        }
      ],
      [{ text: "❓ المساعدة", callback_data: "help" }]
    ]
  };
}

function caseDetailKeyboard(c) {
  const id           = c.id;
  const extraButtons = [];

  // ✅ حماية: لو id غير موجود، رجع القائمة الرئيسية فقط
  if (!id) {
    console.error("❌ caseDetailKeyboard: id is missing for case:", c.caseNumber);
    return {
      inline_keyboard: [
        [{ text: "🔙 القائمة الرئيسية", callback_data: "main_menu" }]
      ]
    };
  }

  extraButtons.push([{ text: "📎 إضافة مستند", callback_data: `add_doc_${id}` }]);

  if (c.documents && c.documents.length > 0) {
    extraButtons.push([{ text: `📂 عرض المستندات (${c.documents.length})`, callback_data: `docs_${id}` }]);
  }

  if (c.status !== "responded") extraButtons.push([{ text: "💬 إضافة رد",   callback_data: `respond_${id}` }]);
  if (c.status !== "rejected")  extraButtons.push([{ text: "❌ رفض الطلب", callback_data: `reject_${id}`  }]);

  return {
    inline_keyboard: [
      ...extraButtons,
      [
        { text: "✅ تم التنفيذ",    callback_data: `status_${id}_executed`        },
        { text: "⏳ تحت المراجعة", callback_data: `status_${id}_under_review`    }
      ],
      [
        { text: "🔄 تحت الإجراء", callback_data: `status_${id}_under_procedure` },
        { text: "💬 تم الرد",     callback_data: `status_${id}_responded`       }
      ],
      [{ text: "❌ مرفوض", callback_data: `status_${id}_rejected` }],
      [
        { text: "🗑 حذف الطلب", callback_data: `delete_${id}` },
        { text: "🔙 رجوع",      callback_data: "main_menu"    }
      ]
    ]
  };
}

function casesListKeyboard(cases, page = 0) {
  const pageSize = 8;
  const start    = page * pageSize;
  const slice    = cases.slice(start, start + pageSize);

  const buttons = slice.map(c => {
    // ✅ Safe display: إذا كانت undefined، استخدم قيمة افتراضية
    const caseNum = c.caseNumber || `#${c.id?.slice(0, 8) || "N/A"}`;
    const personName = c.personName || c.name || "بدون اسم";
    const statusLabel = STATUS_LABELS[c.status]?.replace(/[✅⏳🔄💬❌]/g, "").trim() || c.status || "غير محدد";
    
    // ✅ التحقق من أن callback_data لا تتجاوز 64 بايت
    const callbackId = c.id || "unknown";
    
    return [{
      text: `${caseNum} - ${personName} (${statusLabel})`,
      callback_data: `view_${callbackId}`
    }];
  });

  const nav = [];
  if (page > 0)                        nav.push({ text: "◀️ السابق", callback_data: `page_${page - 1}` });
  if (start + pageSize < cases.length) nav.push({ text: "التالي ▶️", callback_data: `page_${page + 1}` });
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

// ===== Handle Update =====
async function handleUpdate(update) {
  try {
    if (update.callback_query) {
      await handleCallback(update.callback_query);
      return;
    }

    const msg = update.message;
    if (!msg) return;

    const chatId = msg.chat.id;
    const text   = msg.text || "";

    // ---- Auth ----
    if (!authUsers.has(chatId)) {
      if (text.trim() === BOT_PASSWORD || text.startsWith("/start " + BOT_PASSWORD)) {
        authUsers.add(chatId);
        await sendMessage(chatId,
          `✅ <b>تم تسجيل الدخول بنجاح!</b>\n\n` +
          `مرحباً بك في نظام <b>El Ashry Pro</b> 🏥\n` +
          `مكتب الحاج أحمد الحديدي - عضو مجلس النواب\n\n` +
          `اضغط زر <b>Menu</b> أسفل الشاشة للقائمة`,
          { reply_markup: mainMenuKeyboard() }
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
    if (session) {
      await handleSession(chatId, msg, session);
      return;
    }

    // ---- File Upload (standalone) ----
    if (msg.document || msg.photo) {
      await handleFileUpload(chatId, msg);
      return;
    }

    // ---- Commands ----
    if (text.startsWith("/start") || text.startsWith("/menu")) {
      await sendMessage(chatId, "📋 <b>القائمة الرئيسية</b>", { reply_markup: mainMenuKeyboard() });
      return;
    }
    if (text.startsWith("/help")) {
      await showHelp(chatId);
      return;
    }
    if (text.startsWith("/logout")) {
      authUsers.delete(chatId);
      userSessions.delete(chatId);
      await sendMessage(chatId, "👋 تم تسجيل الخروج بنجاح");
      return;
    }
    if (text.startsWith("/cases")) {
      await showCasesList(chatId);
      return;
    }
    if (text.startsWith("/add")) {
      await startAddCase(chatId);
      return;
    }
    if (text.startsWith("/stats")) {
      await showStats(chatId);
      return;
    }
    if (text.startsWith("/search")) {
      const query = text.replace("/search", "").trim();
      if (!query) {
        await sendMessage(chatId, "🔍 مثال: <code>/search أحمد</code>");
        return;
      }
      await doSearch(chatId, query);
      return;
    }
    if (text.startsWith("/attach")) {
      await startAttachFile(chatId);
      return;
    }

    await sendMessage(chatId, "🤔 أمر غير معروف\nاضغط /menu أو زر <b>Menu</b> للقائمة");

  } catch (err) {
    console.error("❌ handleUpdate error:", {
      message: err.message,
      stack: err.stack,
      update: update.update_id
    });
    // حاول إرسال رسالة خطأ للمستخدم إذا كان متاحًا
    const chatId = update.message?.chat?.id || update.callback_query?.message?.chat?.id;
    if (chatId) {
      try {
        await sendMessage(chatId, "⚠️ حدث خطأ في معالجة طلبك، حاول مرة أخرى");
      } catch (e) {
        // تجاهل الخطأ إذا فشل الإرسال
      }
    }
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
      await sendMessage(chatId, "📋 <b>القائمة الرئيسية</b>", { reply_markup: mainMenuKeyboard() });
    }
    else if (data === "list_cases")   { await showCasesList(chatId); }
    else if (data === "add_case")     { await startAddCase(chatId);  }
    else if (data === "stats")        { await showStats(chatId);     }
    else if (data === "help")         { await showHelp(chatId);      }
    else if (data === "search_start") {
      userSessions.set(chatId, { state: "search_awaiting_query" });
      await sendMessage(chatId, "🔍 أرسل اسم الشخص أو رقم الحالة أو الرقم القومي أو الهاتف:");
    }
    else if (data.startsWith("page_")) {
      const page  = parseInt(data.replace("page_", ""));
      const cases = (await getAllCases()).sort((a, b) => b.createdAt - a.createdAt);
      await sendMessage(chatId, `📋 <b>الطلبات</b> (${cases.length})`, { reply_markup: casesListKeyboard(cases, page) });
    }
    else if (data.startsWith("view_")) {
      const id = data.replace("view_", "");
      await showCaseDetail(chatId, id);
    }
    else if (data.startsWith("status_")) {
      const withoutPrefix  = data.replace("status_", "");
      const lastUnderscore = withoutPrefix.lastIndexOf("_");
      const caseId         = withoutPrefix.substring(0, lastUnderscore);
      const newStatus      = withoutPrefix.substring(lastUnderscore + 1);
      await updateCase(caseId, { status: newStatus });
      const c = await getCaseById(caseId);
      await sendMessage(chatId, `✅ تم تحديث حالة الطلب #${c.caseNumber} إلى: ${STATUS_LABELS[newStatus]}`);
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
        `🗑 تم حذف الطلب #${c?.caseNumber || id} بنجاح\n✅ تم حذف ملفاته من القناة أيضاً`,
        { reply_markup: mainMenuKeyboard() }
      );
    }
    else if (data.startsWith("respond_")) {
      const id = data.replace("respond_", "");
      userSessions.set(chatId, { state: "respond_awaiting", caseId: id });
      await sendMessage(chatId, "💬 اكتب الرد:");
    }
    else if (data.startsWith("reject_")) {
      const id = data.replace("reject_", "");
      userSessions.set(chatId, { state: "reject_awaiting", caseId: id });
      await sendMessage(chatId, "❌ اكتب سبب الرفض:");
    }
    else if (data.startsWith("docs_")) {
      const id = data.replace("docs_", "");
      await showCaseDocuments(chatId, id);
    }
    else if (data.startsWith("add_doc_")) {
      const id = data.replace("add_doc_", "");
      const c  = await getCaseById(id);
      if (!c) { await sendMessage(chatId, "❌ الطلب غير موجود"); return; }
      userSessions.set(chatId, {
        state:      "add_doc_awaiting_file",
        caseId:     id,
        caseNumber: c.caseNumber,
        documents:  c.documents || []
      });
      await sendMessage(chatId,
        `📎 <b>إضافة مستند للطلب #${c.caseNumber}</b>\n\n` +
        `أرسل الملف أو الصورة الآن\n` +
        `(يمكنك إرسال أكثر من ملف، ثم اكتب <code>تم</code>)`
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
      session.state      = "add_phone";
      await sendMessage(chatId, `📱 أرسل رقم الهاتف:\n(أو أرسل <code>تخطي</code>)`);
      break;

    case "add_phone":
      session.personPhone = text.trim() === "تخطي" ? "" : text.trim();
      session.state       = "add_nationalid";
      await sendMessage(chatId, `🆔 أرسل الرقم القومي:\n(أو أرسل <code>تخطي</code>)`);
      break;

    case "add_nationalid":
      session.nationalId = text.trim() === "تخطي" ? "" : text.trim();
      session.state      = "add_service";
      const btns = SERVICE_TYPES.map((s, i) => [{ text: s, callback_data: `svc_${i}` }]);
      btns.push([{ text: "❌ إلغاء", callback_data: "main_menu" }]);
      await sendMessage(chatId, "🏥 اختر نوع الخدمة:", { reply_markup: { inline_keyboard: btns } });
      break;

    case "add_description":
      session.description = text.trim() === "تخطي" ? "" : text.trim();
      session.state       = "add_files";
      session.documents   = [];
      await sendMessage(chatId,
        `📎 أرسل المستندات الآن (صور/PDF/ملفات):\n\n` +
        `أرسل ملف أو أكثر، ثم أرسل <code>تم</code> لما تخلص\n` +
        `(أو أرسل <code>تخطي</code> بدون مستندات)`
      );
      break;

    case "add_files":
      if (text.trim() === "تم" || text.trim() === "تخطي") {
        const caseData = {
          personName:      session.personName,
          personPhone:     session.personPhone || "",
          nationalId:      session.nationalId  || "",
          serviceType:     session.serviceType,
          description:     session.description || "",
          status:          "under_review",
          response:        "",
          rejectionReason: "",
          documents:       session.documents || []
        };
        const newCase = await createCase(caseData);
        userSessions.delete(chatId);
        await sendMessage(chatId,
          `✅ <b>تم إنشاء الطلب بنجاح!</b>\n\n${formatCase(newCase)}`,
          { reply_markup: mainMenuKeyboard() }
        );
      } else if (msg.document || msg.photo) {
        const fileId   = msg.document?.file_id || msg.photo?.[msg.photo.length - 1]?.file_id;
        const fileName = msg.document?.file_name || `صورة_${(session.documents || []).length + 1}.jpg`;
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
        await sendMessage(chatId,
          `✅ تم رفع: <b>${fileName}</b>\n📎 إجمالي المستندات: ${session.documents.length}\n\nأرسل المزيد أو اكتب <code>تم</code>`
        );
      } else {
        await sendMessage(chatId, "📎 أرسل ملفات أو اكتب <code>تم</code> لإنهاء");
      }
      break;

    case "search_awaiting_query":
      await doSearch(chatId, text.trim());
      userSessions.delete(chatId);
      break;

    case "respond_awaiting":
      await updateCase(session.caseId, { status: "responded", response: text.trim() });
      userSessions.delete(chatId);
      await sendMessage(chatId, "✅ تم حفظ الرد بنجاح");
      await showCaseDetail(chatId, session.caseId);
      break;

    case "reject_awaiting":
      await updateCase(session.caseId, { status: "rejected", rejectionReason: text.trim() });
      userSessions.delete(chatId);
      await sendMessage(chatId, "✅ تم حفظ سبب الرفض");
      await showCaseDetail(chatId, session.caseId);
      break;

    case "attach_awaiting_case_info":
      {
        const query = text.trim().toLowerCase();
        if (!query) {
          await sendMessage(chatId, "⚠️ أدخل رقم الطلب أو اسم الشخص:");
          return;
        }
        
        // ✅ البحث عن الطلب بالرقم أو الاسم (محسّن)
        const allCases = await getAllCases();
        const c = allCases.find(x => {
          const caseNum = String(x.caseNumber || "").toLowerCase();
          const personName = (x.personName || "").toLowerCase();
          const id = (x.id || "").toLowerCase();
          
          return (
            // ✅ البحث برقم كامل (EA-202606-0001)
            caseNum.includes(query) ||
            // ✅ البحث برقم قصير (1، 2، 0001، إلخ)
            caseNum.endsWith(query) ||
            // ✅ البحث باسم الشخص أو جزء منه
            personName.includes(query) ||
            // ✅ البحث بـ ID الداخلي
            id === query
          );
        });
        
        if (!c) {
          await sendMessage(chatId, 
            `❌ لم يتم العثور على طلب لـ: <b>${query}</b>\n\n` +
            `جرب:\n` +
            `• رقم الطلب الكامل (EA-202606-0001)\n` +
            `• رقم مختصر (1 أو 2)\n` +
            `• اسم الشخص (أحمد)`
          );
          return;
        }
        
        // ✅ عرض الطلب بالكامل
        await sendMessage(chatId, formatCase(c));
        
        // ✅ الانتقال لحالة رفع الملفات
        userSessions.set(chatId, {
          state:      "attach_awaiting_files",
          caseId:     c.id,
          caseNumber: c.caseNumber || `#${c.id?.slice(0, 8)}`,
          personName: c.personName || "بدون اسم",
          documents:  c.documents || []
        });
        
        await sendMessage(chatId,
          `📎 <b>إضافة مستندات للطلب</b>\n\n` +
          `من فضلك ارفع الملفات (صور أو مستندات)\n\n` +
          `ارسل ملف أو أكثر، ثم اكتب <code>تم</code> لإنهاء`
        );
      }
      break;

    case "attach_awaiting_file":
      await handleAttachFile(chatId, msg, session);
      break;

    case "add_doc_awaiting_file":
      if (text.trim() === "تم") {
        await updateCase(session.caseId, { documents: session.documents });
        userSessions.delete(chatId);
        await sendMessage(chatId,
          `✅ تم حفظ ${session.documents.length} مستند للطلب #${session.caseNumber}\n📂 يمكن استدعاؤها في أي وقت من تفاصيل الطلب`,
          { reply_markup: mainMenuKeyboard() }
        );
        await showCaseDetail(chatId, session.caseId);
      } else if (msg.document || msg.photo) {
        const fileId   = msg.document?.file_id || msg.photo?.[msg.photo.length - 1]?.file_id;
        const fileName = msg.document?.file_name || `صورة_${session.documents.length + 1}.jpg`;
        const result   = await saveFileToChannel(fileId, fileName, session.caseNumber);
        session.documents.push({
          name:              fileName,
          telegramFileId:    result ? result.fileId    : fileId,
          telegramMessageId: result ? result.messageId : null,
          type:              msg.document ? "document" : "image",
          size:              msg.document?.file_size || 0,
          uploadedAt:        Date.now()
        });
        await sendMessage(chatId,
          `✅ تم رفع: <b>${fileName}</b> على القناة\n` +
          `📎 إجمالي مستندات الطلب: ${session.documents.length}\n\n` +
          `أرسل المزيد أو اكتب <code>تم</code>`
        );
      } else {
        await sendMessage(chatId, "📎 أرسل ملف أو صورة، أو اكتب <code>تم</code> لإنهاء");
      }
      break;

    case "attach_awaiting_files":
      if (text.trim() === "تم") {
        // ✅ حفظ الملفات المضافة
        await updateCase(session.caseId, { documents: session.documents });
        const addedCount = session.documents.length;
        userSessions.delete(chatId);
        
        await sendMessage(chatId,
          `✅ <b>تم إضافة الملفات بنجاح!</b>\n\n` +
          `📎 عدد الملفات: ${addedCount}\n` +
          `📋 الطلب: ${session.caseNumber}\n` +
          `👤 صاحب الطلب: ${session.personName}`,
          { reply_markup: mainMenuKeyboard() }
        );
      } else if (msg.document || msg.photo) {
        const fileId   = msg.document?.file_id || msg.photo?.[msg.photo.length - 1]?.file_id;
        const fileName = msg.document?.file_name || `صورة_${session.documents.length + 1}.jpg`;
        const result   = await saveFileToChannel(fileId, fileName, session.caseNumber);
        session.documents.push({
          name:              fileName,
          telegramFileId:    result ? result.fileId    : fileId,
          telegramMessageId: result ? result.messageId : null,
          type:              msg.document ? "document" : "image",
          size:              msg.document?.file_size || 0,
          uploadedAt:        Date.now()
        });
        await sendMessage(chatId,
          `✅ تم رفع: <b>${fileName}</b>\n` +
          `📎 إجمالي الملفات المضافة: ${session.documents.length}\n\n` +
          `أرسل المزيد أو اكتب <code>تم</code> لإنهاء`
        );
      } else {
        await sendMessage(chatId, "📎 أرسل ملف أو صورة، أو اكتب <code>تم</code> لإنهاء");
      }
      break;

    default:
      await sendMessage(chatId, "🤔 حالة غير معروفة، اضغط /menu");
      userSessions.delete(chatId);
      break;
  }
}

// ===== Service Selection =====
async function handleServiceSelection(chatId, serviceIndex, session) {
  session.serviceType = SERVICE_TYPES[serviceIndex];
  session.state       = "add_description";
  await sendMessage(chatId, `📝 اكتب وصف الحالة:\n(أو أرسل <code>تخطي</code>)`);
}

// ===== Add Case =====
async function startAddCase(chatId) {
  userSessions.set(chatId, { state: "add_name" });
  await sendMessage(chatId, "➕ <b>إضافة طلب جديد</b>\n\n👤 أرسل اسم الشخص:");
}

// ===== Cases List =====
async function showCasesList(chatId) {
  const cases = await getAllCases();
  if (cases.length === 0) {
    await sendMessage(chatId, "📋 لا توجد طلبات بعد\nاستخدم /add لإضافة طلب جديد", { reply_markup: mainMenuKeyboard() });
    return;
  }
  const sorted = cases.sort((a, b) => b.createdAt - a.createdAt);
  await sendMessage(chatId, `📋 <b>الطلبات</b> (${sorted.length})`, { reply_markup: casesListKeyboard(sorted, 0) });
}

// ===== Case Detail =====
async function showCaseDetail(chatId, id) {
  try {
    const c = await getCaseById(id);
    if (!c) {
      console.error(`❌ الطلب غير موجود في Firebase: ${id}`);
      await sendMessage(chatId, "❌ الطلب غير موجود\n💡 جرب عرض الطلبات من القائمة", { reply_markup: mainMenuKeyboard() });
      return;
    }
    await sendMessage(chatId, formatCase(c), { reply_markup: caseDetailKeyboard(c) });
  } catch (err) {
    console.error(`❌ خطأ في عرض تفاصيل الطلب ${id}:`, err.message);
    await sendMessage(chatId, "❌ حدث خطأ في عرض الطلب، حاول مرة أخرى", { reply_markup: mainMenuKeyboard() });
  }
}

// ===== Case Documents =====
async function showCaseDocuments(chatId, id) {
  const c = await getCaseById(id);
  if (!c || !c.documents || c.documents.length === 0) {
    await sendMessage(chatId, "📎 لا توجد مستندات لهذا الطلب");
    return;
  }

  // ✅ Safe values
  const caseNum = c.caseNumber || `#${c.id?.slice(0, 8) || "N/A"}`;
  const personName = c.personName || c.name || "بدون اسم";

  await sendMessage(chatId,
    `📂 <b>مستندات الطلب ${caseNum}</b>\n` +
    `👤 ${personName}\n` +
    `📎 العدد: ${c.documents.length} ملف\n\n` +
    `جاري إرسال الملفات...`
  );

  for (const doc of c.documents) {
    if (doc.telegramFileId) {
      const date = doc.uploadedAt
        ? new Date(doc.uploadedAt).toLocaleDateString("ar-EG", { day: "numeric", month: "long", year: "numeric" })
        : "";
      await sendDocument(chatId, doc.telegramFileId,
        `📎 <b>${doc.name}</b>${date ? `\n📅 ${date}` : ""}`
      );
    }
  }

  await sendMessage(chatId,
    `✅ تم إرسال جميع المستندات (${c.documents.length})`,
    {
      reply_markup: {
        inline_keyboard: [[
          { text: "📎 إضافة مستند جديد", callback_data: `add_doc_${id}` },
          { text: "🔙 رجوع للطلب",       callback_data: `view_${id}`    }
        ]]
      }
    }
  );
}

// ===== Search =====
async function doSearch(chatId, query) {
  const results = await searchCases(query);
  if (results.length === 0) {
    await sendMessage(chatId, `🔍 لا توجد نتائج لـ: "${query}"`, { reply_markup: mainMenuKeyboard() });
    return;
  }
  await sendMessage(chatId, `🔍 <b>نتائج البحث</b> (${results.length})`, { reply_markup: casesListKeyboard(results, 0) });
}

// ===== Stats =====
async function showStats(chatId) {
  const cases  = await getAllCases();
  const total  = cases.length;
  const counts = { executed: 0, under_review: 0, under_procedure: 0, responded: 0, rejected: 0 };
  let totalDocs = 0;

  cases.forEach(c => {
    if (counts[c.status] !== undefined) counts[c.status]++;
    if (c.documents) totalDocs += c.documents.length;
  });

  let text = `📊 <b>إحصائيات El Ashry Pro</b>\n\n`;
  text += `📋 إجمالي الطلبات: <b>${total}</b>\n\n`;
  for (const [key, label] of Object.entries(STATUS_LABELS)) {
    text += `${label}: <b>${counts[key]}</b>\n`;
  }
  text += `\n📎 إجمالي المستندات: <b>${totalDocs}</b>`;
  await sendMessage(chatId, text, { reply_markup: mainMenuKeyboard() });
}

// ===== Help =====
async function showHelp(chatId) {
  await sendMessage(chatId,
    `📋 <b>دليل الاستخدام - El Ashry Pro</b>\n\n` +
    `<b>🔑 تسجيل الدخول:</b>\n` +
    `أرسل كلمة المرور للدخول\n\n` +
    `<b>📌 الأوامر:</b>\n` +
    `/menu - القائمة الرئيسية\n` +
    `/add - إضافة طلب جديد\n` +
    `/cases - عرض كل الطلبات\n` +
    `/search أحمد - بحث\n` +
    `/stats - الإحصائيات\n` +
    `/attach EA-202606-0001 - إرفاق ملف\n` +
    `/logout - تسجيل الخروج\n\n` +
    `<b>📎 المستندات:</b>\n` +
    `• أرسل أي ملف مباشرة → يُحفظ في القناة\n` +
    `• من داخل الطلب → زر "📎 إضافة مستند"\n` +
    `• لاستدعاء المستندات → زر "📂 عرض المستندات"\n\n` +
    `<b>🔄 تغيير الحالة:</b>\n` +
    `✅⏳🔄💬❌ مباشرة من أزرار الطلب\n\n` +
    `<b>🗑 حذف الطلب:</b>\n` +
    `يحذف الطلب وملفاته من القناة تلقائياً`,
    { reply_markup: mainMenuKeyboard() }
  );
}

// ===== File Upload (standalone) =====
async function handleFileUpload(chatId, msg) {
  const fileId   = msg.document?.file_id || msg.photo?.[msg.photo.length - 1]?.file_id;
  const fileName = msg.document?.file_name || "صورة";
  if (!fileId) return;

  const result = await saveFileToChannel(fileId, fileName);
  if (result) {
    await sendMessage(chatId,
      `✅ <b>تم حفظ المستند في القناة</b>\n\n` +
      `📄 <b>${fileName}</b>\n` +
      `🆔 Message ID: <code>${result.messageId}</code>\n\n` +
      `💡 لإرفاقه بطلب معين:\n<code>/attach رقم_الحالة</code>`,
      {
        reply_markup: {
          inline_keyboard: [[
            { text: "📋 عرض الطلبات", callback_data: "list_cases" },
            { text: "🔙 القائمة",     callback_data: "main_menu"  }
          ]]
        }
      }
    );
  } else {
    await sendMessage(chatId, `⚠️ تم استلام: ${fileName} لكن لم يُحفظ في القناة`);
  }
}

// ===== Attach File to Case (via command) =====
async function startAttachFile(chatId) {
  userSessions.set(chatId, { state: "attach_awaiting_case_info" });
  await sendMessage(chatId,
    `📎 <b>إضافة مستندات لطلب</b>\n\n` +
    `أدخل <b>رقم الطلب</b> (مثل: EA-202606-0001)\n` +
    `أو <b>اسم صاحب الطلب</b>`
  );
}

async function handleAttachFile(chatId, msg, session) {
  const text = msg.text || "";
  if (text.trim() === "تم") {
    await updateCase(session.caseId, { documents: session.documents });
    userSessions.delete(chatId);
    await sendMessage(chatId,
      `✅ تم حفظ ${session.documents.length} مستند للطلب #${session.caseNumber}`,
      { reply_markup: mainMenuKeyboard() }
    );
    return;
  }

  const fileId   = msg.document?.file_id || msg.photo?.[msg.photo.length - 1]?.file_id;
  const fileName = msg.document?.file_name || `صورة_${session.documents.length + 1}.jpg`;
  if (!fileId) {
    await sendMessage(chatId, "📎 أرسل ملف أو اكتب <code>تم</code> لإنهاء");
    return;
  }

  const result = await saveFileToChannel(fileId, fileName, session.caseNumber);
  session.documents.push({
    name:              fileName,
    telegramFileId:    result ? result.fileId    : fileId,
    telegramMessageId: result ? result.messageId : null,
    type:              msg.document ? "document" : "image",
    size:              msg.document?.file_size || 0,
    uploadedAt:        Date.now()
  });

  await sendMessage(chatId,
    `✅ تم رفع: <b>${fileName}</b>\n📎 إجمالي المستندات: ${session.documents.length}\n\nأرسل المزيد أو اكتب <code>تم</code>`
  );
}

// ===== Auto-Restart Every 5 Hours =====
const RESTART_HOURS = 5;
const RESTART_MS    = RESTART_HOURS * 60 * 60 * 1000;

function scheduleAutoRestart() {
  const next = new Date(Date.now() + RESTART_MS);
  console.log(`⏰ إعادة التشغيل التلقائية: ${next.toLocaleString("ar-EG")}`);
  setTimeout(async () => {
    console.log("🔄 إعادة تشغيل تلقائية...");
    for (const chatId of authUsers) {
      try {
        await sendMessage(chatId,
          `🔄 <b>إعادة تشغيل تلقائية</b>\n⏱ كل ${RESTART_HOURS} ساعات\n✅ سيعود خلال ثوانٍ...`
        );
      } catch (e) {}
    }
    await new Promise(r => setTimeout(r, 2000));
    process.exit(0);
  }, RESTART_MS);
}

// ===== Polling =====
let lastUpdateId = 0;

async function startPolling() {
  console.log("🤖 El Ashry Pro Bot v4.0");
  console.log(`👤 ${BOT_USERNAME}`);
  console.log(`📌 Token:   ✅ ${BOT_TOKEN.slice(0, 10)}...`);
  console.log(`📌 Channel: ✅ ${CHANNEL_ID}`);
  console.log(`🔑 Password: ${BOT_PASSWORD}`);
  console.log(`⏰ إعادة التشغيل كل ${RESTART_HOURS} ساعات`);
  console.log(`🕐 ${new Date().toLocaleString("ar-EG")}`);
  console.log("─────────────────────────────────────────");

  // ✅ التأكد من عدم وجود webhook نشط (يمنع التكرار)
  const webhookInfo = await tg("getWebhookInfo");
  if (webhookInfo.ok && webhookInfo.result && webhookInfo.result.url) {
    console.log("⚠️ يوجد webhook نشط، جاري الحذف...");
    await tg("deleteWebhook", { drop_pending_updates: false });
  }

  // ✅ استرجاع آخر update_id لعدم معالجة تحديثات قديمة
  try {
    const initialRes = await tg("getUpdates", { offset: -1, timeout: 0 });
    if (initialRes.ok && initialRes.result && initialRes.result.length > 0) {
      lastUpdateId = initialRes.result[0].update_id;
      console.log(`✅ آخر تحديث معروف: ${lastUpdateId}`);
    }
  } catch (e) {
    console.warn("⚠️ لم يتم استرجاع آخر تحديث:", e.message);
  }

  await setBotCommands();
  scheduleAutoRestart();

  let pollingErrors = 0;
  while (true) {
    try {
      const res = await tg("getUpdates", {
        offset:          lastUpdateId + 1,
        timeout:         30,
        allowed_updates: ["message", "callback_query"]
      });

      if (res.ok && res.result) {
        pollingErrors = 0;
        for (const update of res.result) {
          lastUpdateId = update.update_id;
          // ✅ منع تكرار معالجة نفس التحديث
          if (isUpdateProcessed(update.update_id)) {
            console.log(`⏭️ تخطي تحديث مكرر: ${update.update_id}`);
            continue;
          }
          await handleUpdate(update);
        }
      } else if (!res.ok) {
        pollingErrors++;
        console.error(`❌ Telegram API Error (${pollingErrors}):`, res.description || res.error || JSON.stringify(res));
        if (res.description && res.description.includes('Conflict')) {
          console.warn("⚠️ تحديث متعارض - قد يكون هناك بوت آخر يعمل بنفس التوكن!");
          await new Promise(r => setTimeout(r, 10000));
        } else if (res.description && res.description.includes('429')) {
          console.warn("⚠️ تجاوز حد الطلبات - انتظار 30 ثانية...");
          await new Promise(r => setTimeout(r, 30000));
        } else {
          await new Promise(r => setTimeout(r, 5000));
        }
      }
    } catch (err) {
      pollingErrors++;
      console.error(`❌ Polling error (${pollingErrors}):`, err.message);
      // Exponential backoff
      const waitTime = Math.min(3000 * Math.pow(2, Math.min(pollingErrors - 1, 5)), 60000);
      await new Promise(r => setTimeout(r, waitTime));
      // إعادة تشغيل البوت لو الأخطاء كثيرة جداً
      if (pollingErrors > 20) {
        console.error("❌ أخطاء كثيرة جداً - إعادة تشغيل البوت...");
        process.exit(1);
      }
    }
  }
}

startPolling();
