// ============================================================
//  El Ashry Pro - Telegram Bot
//  بوت تليجرام كامل للتحكم في نظام إدارة الحالات
//  برمجة وتطوير بكل ❤️ ينبض - المهندس محمد حماد
// ============================================================
//
//  الإعداد:
//  1. أنشئ بوت من @BotFather واحصل على التوكن
//  2. أنشئ قناة خاصة على تليجرام
//  3. اضف البوت كمشرف في القناة
//  4. اضبط المتغيرات بالأسفل
//  5. شغل: bun bot.js أو node bot.js
//
// ============================================================

const BOT_TOKEN = process.env.BOT_TOKEN || "8932213518:AAFdrQGmLPCAtSbZGV069yVtEVwsXZZd31o";
const CHANNEL_ID = process.env.CHANNEL_ID || "-1004373481196";
const BOT_USERNAME = "@Ashryworkbot";
const BOT_PASSWORD = "521988";
const FIREBASE_CONFIG = {
  apiKey: "AIzaSyCXu2rJGT81e9BBkJXzzVyEyXWaYcrK2NM",
  authDomain: "el-ashry.firebaseapp.com",
  databaseURL: "https://el-ashry-default-rtdb.firebaseio.com",
  projectId: "el-ashry",
  storageBucket: "el-ashry.firebasestorage.app",
  messagingSenderId: "169155515034",
  appId: "1:169155515034:web:d74c9f027efd216a228523"
};

// ===== Firebase Init =====
const { initializeApp } = require("firebase/app");
const { getDatabase, ref, set, get, update, remove, push, onValue } = require("firebase/database");
const firebaseApp = initializeApp(FIREBASE_CONFIG);
const db = getDatabase(firebaseApp);

// ===== Constants =====
const STATUS_LABELS = {
  executed: "✅ تم التنفيذ",
  under_review: "⏳ تحت المراجعة",
  under_procedure: "🔄 تحت الإجراء",
  responded: "💬 تم الرد",
  rejected: "❌ مرفوض"
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
const authUsers = new Set();
const userSessions = new Map(); // chatId -> session state

// ===== Helper: Telegram API =====
async function tg(method, data = {}) {
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/${method}`;
  const hasFile = data.document || data.photo;
  
  if (hasFile) {
    // Use FormData for file uploads
    const formData = new FormData();
    for (const [key, val] of Object.entries(data)) {
      formData.append(key, val);
    }
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
  return tg("sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    ...extra
  });
}

async function sendDocument(chatId, fileId, caption = "") {
  return tg("sendDocument", {
    chat_id: chatId,
    document: fileId,
    caption
  });
}

// ===== Helper: Firebase =====
async function getAllCases() {
  const snapshot = await get(ref(db, "cases"));
  return snapshot.val() ? Object.values(snapshot.val()) : [];
}

async function getCaseById(id) {
  const snapshot = await get(ref(db, `cases/${id}`));
  return snapshot.val();
}

async function createCase(data) {
  const newRef = push(ref(db, "cases"));
  const id = newRef.key;
  const now = Date.now();
  const d = new Date();
  const caseNumber = `EA-${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}-${String((await getAllCases()).length + 1).padStart(4, "0")}`;
  
  const caseData = { id, caseNumber, ...data, createdAt: now, updatedAt: now };
  await set(newRef, caseData);
  return caseData;
}

async function updateCase(id, data) {
  await update(ref(db, `cases/${id}`), { ...data, updatedAt: Date.now() });
}

async function deleteCase(id) {
  // Delete associated files from Telegram channel
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

async function searchCases(query) {
  const all = await getAllCases();
  const q = query.toLowerCase();
  return all.filter(c =>
    c.personName.toLowerCase().includes(q) ||
    c.caseNumber.toLowerCase().includes(q) ||
    (c.nationalId || "").includes(q) ||
    (c.personPhone || "").includes(q)
  );
}

// ===== Upload file to channel =====
async function uploadToChannel(fileId, fileName) {
  // Forward/copy the file to the private channel
  const result = await tg("copyMessage", {
    chat_id: CHANNEL_ID,
    from_chat_id: CHANNEL_ID, // We'll use sendDocument instead
  });
  return result;
}

async function saveFileToChannel(chatId, fileId, fileName) {
  // Send the file to the channel and get the message_id
  const result = await tg("sendDocument", {
    chat_id: CHANNEL_ID,
    document: fileId,
    caption: `📁 ${fileName}`
  });
  
  if (result.ok) {
    return {
      fileId: result.result.document.file_id,
      messageId: result.result.message_id,
      fileName: fileName
    };
  }
  return null;
}

// ===== Format Case =====
function formatCase(c) {
  let text = `<b>📋 طلب #${c.caseNumber}</b>\n\n`;
  text += `👤 <b>الاسم:</b> ${c.personName}\n`;
  if (c.personPhone) text += `📱 <b>الهاتف:</b> <code>${c.personPhone}</code>`;
  if (c.personPhone) text += ` | <a href="https://wa.me/2${c.personPhone.replace(/^0/, '')}">واتساب</a>\n`;
  if (c.nationalId) text += `🆔 <b>الرقم القومي:</b> <code>${c.nationalId}</code>\n`;
  text += `🏥 <b>الخدمة:</b> ${c.serviceType}\n`;
  text += `📌 <b>الحالة:</b> ${STATUS_LABELS[c.status] || c.status}\n`;
  if (c.description) text += `📝 <b>الوصف:</b> ${c.description}\n`;
  if (c.status === "responded" && c.response) text += `💬 <b>الرد:</b> ${c.response}\n`;
  if (c.status === "rejected" && c.rejectionReason) text += `❌ <b>سبب الرفض:</b> ${c.rejectionReason}\n`;
  if (c.documents && c.documents.length > 0) text += `📎 <b>المستندات:</b> ${c.documents.length} ملف\n`;
  
  const d = new Date(c.createdAt);
  text += `\n📅 ${d.toLocaleDateString("ar-EG", { year: "numeric", month: "long", day: "numeric", hour: "2-digit", minute: "2-digit" })}`;
  
  return text;
}

// ===== Inline Keyboards =====
function mainMenuKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: "📋 عرض الطلبات", callback_data: "list_cases" },
        { text: "➕ طلب جديد", callback_data: "add_case" }
      ],
      [
        { text: "🔍 بحث", callback_data: "search_start" },
        { text: "📊 إحصائيات", callback_data: "stats" }
      ],
      [{ text: "❓ المساعدة", callback_data: "help" }]
    ]
  };
}

function statusKeyboard(caseId) {
  return {
    inline_keyboard: [
      [
        { text: "✅ تم التنفيذ", callback_data: `status_${caseId}_executed` },
        { text: "⏳ تحت المراجعة", callback_data: `status_${caseId}_under_review` }
      ],
      [
        { text: "🔄 تحت الإجراء", callback_data: `status_${caseId}_under_procedure` },
        { text: "💬 تم الرد", callback_data: `status_${caseId}_responded` }
      ],
      [
        { text: "❌ مرفوض", callback_data: `status_${caseId}_rejected` }
      ],
      [
        { text: "🗑 حذف الطلب", callback_data: `delete_${caseId}` },
        { text: "🔙 رجوع", callback_data: "main_menu" }
      ]
    ]
  };
}

function casesListKeyboard(cases) {
  const buttons = cases.slice(0, 10).map(c => [{
    text: `#${c.caseNumber} - ${c.personName} (${STATUS_LABELS[c.status]?.replace(/[✅⏳🔄💬❌]/g, "").trim() || c.status})`,
    callback_data: `view_${c.id}`
  }]);
  
  buttons.push([{ text: "🔙 القائمة الرئيسية", callback_data: "main_menu" }]);
  return { inline_keyboard: buttons };
}

function confirmDeleteKeyboard(caseId) {
  return {
    inline_keyboard: [
      [
        { text: "✅ نعم، احذف", callback_data: `confirm_delete_${caseId}` },
        { text: "❌ إلغاء", callback_data: `view_${caseId}` }
      ]
    ]
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
    const text = msg.text || "";

    // Check if user is authenticated
    if (!authUsers.has(chatId)) {
      if (text.trim() === BOT_PASSWORD || text.startsWith("/start " + BOT_PASSWORD)) {
        authUsers.add(chatId);
        await sendMessage(chatId,
          `✅ <b>تم تسجيل الدخول بنجاح!</b>\n\n` +
          `مرحباً بك في نظام <b>El Ashry Pro</b> 🏥\n` +
          `مكتب الحاج أحمد الحديدي - عضو مجلس النواب\n\n` +
          `يمكنك التحكم الكامل في جميع الحالات من هنا`,
          { reply_markup: mainMenuKeyboard() }
        );
      } else if (text.startsWith("/start")) {
        await sendMessage(chatId,
          `🏥 <b>El Ashry Pro - بوت إدارة الحالات</b>\n\n` +
          `للدخول، أرسل كلمة المرور:`
        );
      } else {
        await sendMessage(chatId, "🔒 أرسل كلمة المرور للدخول:");
      }
      return;
    }

    // Handle session states
    const session = userSessions.get(chatId);
    if (session) {
      await handleSession(chatId, msg, session);
      return;
    }

    // Handle file uploads (when not in a session, just save to channel)
    if (msg.document || msg.photo) {
      await handleFileUpload(chatId, msg);
      return;
    }

    // Commands
    if (text.startsWith("/start") || text.startsWith("/menu")) {
      await sendMessage(chatId, "📋 <b>القائمة الرئيسية</b>", { reply_markup: mainMenuKeyboard() });
      return;
    }

    if (text.startsWith("/help") || text === "❓ المساعدة") {
      await sendMessage(chatId,
        `📋 <b>أوامر البوت:</b>\n\n` +
        `/menu - القائمة الرئيسية\n` +
        `/cases - عرض جميع الطلبات\n` +
        `/add - إضافة طلب جديد\n` +
        `/search اسم - البحث عن طلب\n` +
        `/stats - الإحصائيات\n` +
        `/logout - تسجيل الخروج\n\n` +
        `📎 <b>رفع مستندات:</b>\n` +
        `أرسل أي ملف مباشرة وسيتم حفظه في القناة\n\n` +
        `💡 <b>إضافة مستند لطلب:</b>\n` +
        `/attach رقم_الحالة - ثم أرسل الملف`
      );
      return;
    }

    if (text.startsWith("/logout")) {
      authUsers.delete(chatId);
      userSessions.delete(chatId);
      await sendMessage(chatId, "👋 تم تسجيل الخروج");
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

    if (text.startsWith("/search")) {
      const query = text.replace("/search", "").trim();
      if (!query) {
        await sendMessage(chatId, "🔍 أرسل كلمة البحث:\nمثال: <code>/search أحمد</code>");
        return;
      }
      await doSearch(chatId, query);
      return;
    }

    if (text.startsWith("/stats")) {
      await showStats(chatId);
      return;
    }

    if (text.startsWith("/attach")) {
      const caseNumber = text.replace("/attach", "").trim();
      await startAttachFile(chatId, caseNumber);
      return;
    }

    // Default
    await sendMessage(chatId, "🤔 أمر غير معروف. اضغط /menu للقائمة الرئيسية");

  } catch (err) {
    console.error("Handle update error:", err);
  }
}

// ===== Handle Callback Query =====
async function handleCallback(cb) {
  const chatId = cb.message.chat.id;
  const data = cb.data;

  if (!authUsers.has(chatId)) {
    await tg("answerCallbackQuery", { callback_query_id: cb.id, text: "يجب تسجيل الدخول أولاً" });
    return;
  }

  await tg("answerCallbackQuery", { callback_query_id: cb.id });

  try {
    if (data === "main_menu") {
      await sendMessage(chatId, "📋 <b>القائمة الرئيسية</b>", { reply_markup: mainMenuKeyboard() });
    }
    else if (data === "list_cases") {
      await showCasesList(chatId);
    }
    else if (data === "add_case") {
      await startAddCase(chatId);
    }
    else if (data === "search_start") {
      userSessions.set(chatId, { state: "search_awaiting_query" });
      await sendMessage(chatId, "🔍 أرسل اسم الشخص أو رقم الحالة للبحث:");
    }
    else if (data === "stats") {
      await showStats(chatId);
    }
    else if (data === "help") {
      await sendMessage(chatId,
        `📋 <b>أوامر البوت:</b>\n\n` +
        `/menu - القائمة الرئيسية\n` +
        `/cases - عرض جميع الطلبات\n` +
        `/add - إضافة طلب جديد\n` +
        `/search اسم - البحث\n` +
        `/stats - الإحصائيات\n\n` +
        `📎 أرسل أي ملف مباشرة وسيتم حفظه\n` +
        `💡 /attach رقم_الحالة - لإضافة مستند لطلب`
      );
    }
    else if (data.startsWith("view_")) {
      const id = data.replace("view_", "");
      await showCaseDetail(chatId, id);
    }
    else if (data.startsWith("status_")) {
      const parts = data.replace("status_", "").split("_");
      const caseId = parts[0];
      const newStatus = parts[1];
      await updateCase(caseId, { status: newStatus });
      const c = await getCaseById(caseId);
      await sendMessage(chatId, `✅ تم تحديث حالة الطلب #${c.caseNumber} إلى: ${STATUS_LABELS[newStatus]}`);
      await showCaseDetail(chatId, caseId);
    }
    else if (data.startsWith("delete_")) {
      const id = data.replace("delete_", "");
      const c = await getCaseById(id);
      await sendMessage(chatId,
        `⚠️ <b>تأكيد الحذف</b>\n\nهل أنت متأكد من حذف الطلب #${c.caseNumber} - ${c.personName}؟`,
        { reply_markup: confirmDeleteKeyboard(id) }
      );
    }
    else if (data.startsWith("confirm_delete_")) {
      const id = data.replace("confirm_delete_", "");
      const c = await getCaseById(id);
      await deleteCase(id);
      await sendMessage(chatId, `🗑 تم حذف الطلب #${c?.caseNumber || id} بنجاح`, { reply_markup: mainMenuKeyboard() });
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
  } catch (err) {
    console.error("Callback error:", err);
    await sendMessage(chatId, "❌ حدث خطأ، حاول مرة أخرى");
  }
}

// ===== Session Handler =====
async function handleSession(chatId, msg, session) {
  const text = msg.text || "";

  switch (session.state) {
    case "add_name":
      session.personName = text.trim();
      session.state = "add_phone";
      await sendMessage(chatId, `📱 أرسل رقم الهاتف:\n(أو أرسل <code>تخطي</code>)`);
      break;

    case "add_phone":
      session.personPhone = text.trim() === "تخطي" ? "" : text.trim();
      session.state = "add_nationalid";
      await sendMessage(chatId, `🆔 أرسل الرقم القومي:\n(أو أرسل <code>تخطي</code>)`);
      break;

    case "add_nationalid":
      session.nationalId = text.trim() === "تخطي" ? "" : text.trim();
      session.state = "add_service";
      const buttons = SERVICE_TYPES.map((s, i) => [{ text: s, callback_data: `svc_${i}` }]);
      buttons.push([{ text: "❌ إلغاء", callback_data: "main_menu" }]);
      await sendMessage(chatId, "🏥 اختر نوع الخدمة:", { reply_markup: { inline_keyboard: buttons } });
      break;

    case "add_description":
      session.description = text.trim() === "تخطي" ? "" : text.trim();
      session.state = "add_files";
      await sendMessage(chatId,
        `📎 أرسل المستندات الآن (صور/PDF/ملفات):\n\n` +
        `أرسل ملف أو أكتر، وبعدين أرسل <code>تم</code> لما تخلص\n` +
        `(أو أرسل <code>تخطي</code> بدون مستندات)`
      );
      break;

    case "add_files":
      if (text.trim() === "تم" || text.trim() === "تخطي") {
        // Save the case
        const caseData = {
          personName: session.personName,
          personPhone: session.personPhone || "",
          nationalId: session.nationalId || "",
          serviceType: session.serviceType,
          description: session.description || "",
          status: "under_review",
          response: "",
          rejectionReason: "",
          documents: session.documents || []
        };
        const newCase = await createCase(caseData);
        userSessions.delete(chatId);
        await sendMessage(chatId,
          `✅ <b>تم إنشاء الطلب بنجاح!</b>\n\n${formatCase(newCase)}`,
          { reply_markup: mainMenuKeyboard() }
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
      await sendMessage(chatId, "✅ تم حفظ الرد");
      await showCaseDetail(chatId, session.caseId);
      break;

    case "reject_awaiting":
      await updateCase(session.caseId, { status: "rejected", rejectionReason: text.trim() });
      userSessions.delete(chatId);
      await sendMessage(chatId, "✅ تم حفظ سبب الرفض");
      await showCaseDetail(chatId, session.caseId);
      break;

    case "attach_awaiting_file":
      // Handle file for attachment
      await handleAttachFile(chatId, msg, session);
      break;
  }
}

// ===== Handle service selection callback for add =====
async function handleServiceSelection(chatId, serviceIndex, session) {
  session.serviceType = SERVICE_TYPES[serviceIndex];
  session.state = "add_description";
  session.documents = [];
  await sendMessage(chatId,
    `📝 اكتب وصف الحالة:\n(أو أرسل <code>تخطي</code>)`
  );
}

// ===== Start Add Case =====
async function startAddCase(chatId) {
  userSessions.set(chatId, { state: "add_name" });
  await sendMessage(chatId, "➕ <b>إضافة طلب جديد</b>\n\n👤 أرسل اسم الشخص:");
}

// ===== Show Cases List =====
async function showCasesList(chatId) {
  const cases = await getAllCases();
  if (cases.length === 0) {
    await sendMessage(chatId, "📋 لا توجد طلبات بعد\nاستخدم /add لإضافة طلب جديد", { reply_markup: mainMenuKeyboard() });
    return;
  }
  const sorted = cases.sort((a, b) => b.createdAt - a.createdAt).slice(0, 10);
  await sendMessage(chatId, `📋 <b>الطلبات</b> (${cases.length})`, { reply_markup: casesListKeyboard(sorted) });
}

// ===== Show Case Detail =====
async function showCaseDetail(chatId, id) {
  const c = await getCaseById(id);
  if (!c) {
    await sendMessage(chatId, "❌ الطلب غير موجود");
    return;
  }

  let keyboard = statusKeyboard(id);
  
  // Add respond/reject buttons if needed
  const extraButtons = [];
  if (c.status !== "responded") {
    extraButtons.push([{ text: "💬 إضافة رد", callback_data: `respond_${id}` }]);
  }
  if (c.status !== "rejected") {
    extraButtons.push([{ text: "❌ رفض الطلب", callback_data: `reject_${id}` }]);
  }
  if (c.documents && c.documents.length > 0) {
    extraButtons.push([{ text: `📎 عرض المستندات (${c.documents.length})`, callback_data: `docs_${id}` }]);
  }

  keyboard.inline_keyboard = [...extraButtons, ...keyboard.inline_keyboard];

  await sendMessage(chatId, formatCase(c), { reply_markup: keyboard });
}

// ===== Show Case Documents =====
async function showCaseDocuments(chatId, id) {
  const c = await getCaseById(id);
  if (!c || !c.documents || c.documents.length === 0) {
    await sendMessage(chatId, "📎 لا توجد مستندات لهذا الطلب");
    return;
  }

  await sendMessage(chatId, `📎 <b>مستندات الطلب #${c.caseNumber}</b> (${c.documents.length} ملف)`);

  for (const doc of c.documents) {
    if (doc.telegramFileId) {
      await sendDocument(chatId, doc.telegramFileId, `📎 ${doc.name}`);
    } else if (doc.url) {
      await sendMessage(chatId, `📄 <a href="${doc.url}">${doc.name}</a>`);
    }
  }
}

// ===== Search =====
async function doSearch(chatId, query) {
  const results = await searchCases(query);
  if (results.length === 0) {
    await sendMessage(chatId, `🔍 لا توجد نتائج لـ: "${query}"`, { reply_markup: mainMenuKeyboard() });
    return;
  }
  await sendMessage(chatId, `🔍 <b>نتائج البحث</b> (${results.length})`, { reply_markup: casesListKeyboard(results) });
}

// ===== Stats =====
async function showStats(chatId) {
  const cases = await getAllCases();
  const total = cases.length;
  const counts = { executed: 0, under_review: 0, under_procedure: 0, responded: 0, rejected: 0 };
  let totalDocs = 0;
  cases.forEach(c => {
    if (counts[c.status] !== undefined) counts[c.status]++;
    if (c.documents) totalDocs += c.documents.length;
  });

  let text = `📊 <b>إحصائيات El Ashry Pro</b>\n\n`;
  text += `📋 إجمالي الطلبات: <b>${total}</b>\n`;
  for (const [key, label] of Object.entries(STATUS_LABELS)) {
    text += `${label}: <b>${counts[key]}</b>\n`;
  }
  text += `\n📎 المستندات: <b>${totalDocs}</b>`;

  await sendMessage(chatId, text, { reply_markup: mainMenuKeyboard() });
}

// ===== Handle File Upload (standalone - not attached to case) =====
async function handleFileUpload(chatId, msg) {
  const fileId = msg.document?.file_id || msg.photo?.[msg.photo.length - 1]?.file_id;
  const fileName = msg.document?.file_name || "صورة";

  if (!fileId) return;

  // Save file to the private channel
  const result = await saveFileToChannel(chatId, fileId, fileName);

  if (result) {
    await sendMessage(chatId,
      `✅ <b>تم حفظ المستند في القناة</b>\n\n` +
      `📄 ${fileName}\n` +
      `🆔 Message ID: ${result.messageId}\n\n` +
      `💡 لإرفاقه بطلب، استخدم:\n<code>/attach رقم_الحالة</code>`
    );
  } else {
    await sendMessage(chatId, `✅ تم استلام: ${fileName}\n⚠️ لم يتم حفظه في القناة`);
  }
}

// ===== Start Attach File to Case =====
async function startAttachFile(chatId, caseNumber) {
  if (!caseNumber) {
    await sendMessage(chatId, "📝 أرسل رقم الحالة:\nمثال: <code>/attach EA-202606-0001</code>");
    return;
  }

  const allCases = await getAllCases();
  const c = allCases.find(x => x.caseNumber === caseNumber || x.id === caseNumber);

  if (!c) {
    await sendMessage(chatId, `❌ لم يتم العثور على الحالة: ${caseNumber}`);
    return;
  }

  userSessions.set(chatId, { state: "attach_awaiting_file", caseId: c.id, caseNumber: c.caseNumber, documents: c.documents || [] });
  await sendMessage(chatId, `📎 أرسل المستندات لطلب #${c.caseNumber}:\n(أرسل ملف أو أكتر، ثم أرسل <code>تم</code>)`);
}

// ===== Handle File Attachment =====
async function handleAttachFile(chatId, msg, session) {
  const text = msg.text;

  if (text && text.trim() === "تم") {
    // Save updated documents
    await updateCase(session.caseId, { documents: session.documents });
    userSessions.delete(chatId);
    await sendMessage(chatId, `✅ تم حفظ المستندات لطلب #${session.caseNumber}`, { reply_markup: mainMenuKeyboard() });
    return;
  }

  const fileId = msg.document?.file_id || msg.photo?.[msg.photo.length - 1]?.file_id;
  const fileName = msg.document?.file_name || `صورة_${session.documents.length + 1}.jpg`;

  if (!fileId) {
    await sendMessage(chatId, "📎 أرسل ملف أو اكتب <code>تم</code> لإنهاء");
    return;
  }

  // Save to channel
  const result = await saveFileToChannel(chatId, fileId, fileName);

  session.documents.push({
    name: fileName,
    url: result ? `https://api.telegram.org/file/bot${BOT_TOKEN}/${result.fileId}` : "",
    telegramFileId: result ? result.fileId : fileId,
    telegramMessageId: result ? result.messageId : null,
    type: msg.document ? "document" : "image",
    size: msg.document?.file_size || 0
  });

  await sendMessage(chatId, `✅ تم رفع: ${fileName}\n📎 إجمالي المستندات: ${session.documents.length}\n\nأرسل المزيد أو اكتب <code>تم</code>`);
}

// ===== Polling (works without webhook setup) =====
let lastUpdateId = 0;
const RESTART_INTERVAL_HOURS = 5;
const RESTART_INTERVAL_MS = RESTART_INTERVAL_HOURS * 60 * 60 * 1000;

// ===== Auto-Restart Every 5 Hours =====
function scheduleAutoRestart() {
  const nextRestart = new Date(Date.now() + RESTART_INTERVAL_MS);
  console.log(`⏰ إعادة التشغيل التلقائية القادمة: ${nextRestart.toLocaleString("ar-EG")}`);

  setTimeout(async () => {
    console.log("🔄 جاري إعادة تشغيل البوت تلقائياً (كل 5 ساعات)...");

    // Notify all authenticated users
    for (const chatId of authUsers) {
      try {
        await sendMessage(chatId,
          `🔄 <b>إعادة تشغيل تلقائية</b>\n\n` +
          `⏱ البوت يعيد تشغيل نفسه الآن (كل ${RESTART_INTERVAL_HOURS} ساعات)\n` +
          `⏰ الوقت: ${new Date().toLocaleString("ar-EG")}\n\n` +
          `✅ سيعود البوت خلال ثوانٍ...`
        );
      } catch (e) {}
    }

    // Wait 2 seconds then exit (process manager like PM2 will restart it)
    await new Promise(r => setTimeout(r, 2000));
    console.log("🛑 إيقاف البوت لإعادة التشغيل...");
    process.exit(0);
  }, RESTART_INTERVAL_MS);
}

async function startPolling() {
  const startTime = new Date();
  console.log("🤖 El Ashry Pro Bot - جاري التشغيل...");
  console.log(`👤 اسم البوت: ${BOT_USERNAME}`);
  console.log(`📌 Bot Token: ✅ ${BOT_TOKEN.slice(0, 10)}...`);
  console.log(`📌 Channel ID: ✅ ${CHANNEL_ID}`);
  console.log(`🔑 كلمة المرور: ${BOT_PASSWORD}`);
  console.log(`🕐 وقت التشغيل: ${startTime.toLocaleString("ar-EG")}`);
  console.log(`⏰ إعادة التشغيل كل: ${RESTART_INTERVAL_HOURS} ساعات`);
  console.log("─────────────────────────────────");
  console.log("برمجة وتطوير بكل ❤️ ينبض - المهندس محمد حماد");
  console.log("─────────────────────────────────");

  // Schedule auto-restart every 5 hours
  scheduleAutoRestart();

  while (true) {
    try {
      const res = await tg("getUpdates", {
        offset: lastUpdateId + 1,
        timeout: 30,
        allowed_updates: ["message", "callback_query"]
      });

      if (res.ok && res.result) {
        for (const update of res.result) {
          lastUpdateId = update.update_id;

          // Handle service selection in add flow
          if (update.callback_query) {
            const data = update.callback_query.data;
            if (data && data.startsWith("svc_")) {
              const chatId = update.callback_query.message.chat.id;
              const session = userSessions.get(chatId);
              if (session && session.state === "add_nationalid") {
                const svcIndex = parseInt(data.replace("svc_", ""));
                await tg("answerCallbackQuery", { callback_query_id: update.callback_query.id });
                await handleServiceSelection(chatId, svcIndex, session);
                continue;
              }
            }
          }

          await handleUpdate(update);
        }
      }
    } catch (err) {
      console.error("Polling error:", err.message);
      await new Promise(r => setTimeout(r, 3000));
    }
  }
}

// ===== Start =====
startPolling();
