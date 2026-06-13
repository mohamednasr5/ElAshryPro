// ============================================================
//  El Ashry Pro - Telegram Bot v3.0
//  بوت تليجرام كامل للتحكم في نظام إدارة الحالات
//  برمجة وتطوير بكل ❤️ حب - المهندس محمد حماد
// ============================================================

const BOT_TOKEN   = process.env.BOT_TOKEN   || "8932213518:AAFdrQGmLPCAtSbZGV069yVtEVwsXZZd31o";
const CHANNEL_ID  = process.env.CHANNEL_ID  || "-1004373481196";
const BOT_PASSWORD= process.env.BOT_PASSWORD|| "521988";
const BOT_USERNAME= "@Ashryworkbot";

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
const { getDatabase, ref, set, get, update, remove, push } = require("firebase/database");
const firebaseApp = initializeApp(FIREBASE_CONFIG);
const db = getDatabase(firebaseApp);

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

// ===== State (Firebase-backed to survive restarts) =====
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
  return tg("sendDocument", { chat_id: chatId, document: fileId, caption });
}

async function editMessage(chatId, messageId, text, extra = {}) {
  return tg("editMessageText", { chat_id: chatId, message_id: messageId, text, parse_mode: "HTML", ...extra });
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

async function createCase(data) {
  const newRef = push(ref(db, "cases"));
  const id     = newRef.key;
  const now    = Date.now();
  const d      = new Date();
  const all    = await getAllCases();
  const num    = `EA-${d.getFullYear()}${String(d.getMonth()+1).padStart(2,"0")}-${String(all.length+1).padStart(4,"0")}`;
  const caseData = { id, caseNumber: num, ...data, createdAt: now, updatedAt: now };
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

async function searchCases(query) {
  const all = await getAllCases();
  const q   = query.toLowerCase();
  return all.filter(c =>
    c.personName.toLowerCase().includes(q) ||
    c.caseNumber.toLowerCase().includes(q) ||
    (c.nationalId   || "").includes(q) ||
    (c.personPhone  || "").includes(q)
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
function formatCase(c) {
  let text = `<b>📋 طلب #${c.caseNumber}</b>\n\n`;
  text += `👤 <b>الاسم:</b> ${c.personName}\n`;
  if (c.personPhone) {
    const wa = c.personPhone.replace(/^0/, "");
    text += `📱 <b>الهاتف:</b> <code>${c.personPhone}</code> | <a href="https://wa.me/2${wa}">واتساب</a>\n`;
  }
  if (c.nationalId)  text += `🆔 <b>الرقم القومي:</b> <code>${c.nationalId}</code>\n`;
  text += `🏥 <b>الخدمة:</b> ${c.serviceType}\n`;
  text += `📌 <b>الحالة:</b> ${STATUS_LABELS[c.status] || c.status}\n`;
  if (c.description) text += `📝 <b>الوصف:</b> ${c.description}\n`;
  if (c.status === "responded" && c.response)         text += `💬 <b>الرد:</b> ${c.response}\n`;
  if (c.status === "rejected"  && c.rejectionReason)  text += `❌ <b>سبب الرفض:</b> ${c.rejectionReason}\n`;
  if (c.documents && c.documents.length > 0)          text += `📎 <b>المستندات:</b> ${c.documents.length} ملف\n`;
  const d = new Date(c.createdAt);
  text += `\n📅 ${d.toLocaleDateString("ar-EG", { year:"numeric", month:"long", day:"numeric", hour:"2-digit", minute:"2-digit" })}`;
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
        { text: "🔍 بحث",        callback_data: "search_start" },
        { text: "📊 إحصائيات",   callback_data: "stats"        }
      ],
      [{ text: "❓ المساعدة", callback_data: "help" }]
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
        { text: "🗑 حذف الطلب", callback_data: `delete_${caseId}` },
        { text: "🔙 رجوع",      callback_data: "main_menu"        }
      ]
    ]
  };
}

function casesListKeyboard(cases, page = 0) {
  const pageSize = 8;
  const start    = page * pageSize;
  const slice    = cases.slice(start, start + pageSize);

  const buttons = slice.map(c => [{
    text: `#${c.caseNumber} - ${c.personName} (${STATUS_LABELS[c.status]?.replace(/[✅⏳🔄💬❌]/g,"").trim() || c.status})`,
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
        await persistAuthAdd(chatId);
        await sendMessage(chatId,
          `✅ <b>تم تسجيل الدخول بنجاح!</b>\n\n` +
          `مرحباً بك في نظام <b>El Ashry Pro</b> 🏥\n` +
          `مكتب الحاج أحمد الحديدي - عضو مجلس النواب\n\n` +
          `يمكنك التحكم الكامل في جميع الحالات من هنا`,
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

    // ---- Session (must come before file upload check) ----
    const session = userSessions.get(chatId);
    if (session) { await handleSession(chatId, msg, session); return; }

    // ---- Standalone File Upload (no active session) ----
    if (msg.document || msg.photo) { await handleFileUpload(chatId, msg); return; }

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
      await persistAuthRemove(chatId);
      await deleteSession(chatId);
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
    if (text.startsWith("/search")) {
      const query = text.replace("/search", "").trim();
      if (!query) { await sendMessage(chatId, "🔍 مثال: <code>/search أحمد</code>"); return; }
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
    if (text.startsWith("/docs")) {
      const caseNumber = text.replace("/docs", "").trim();
      if (!caseNumber) { await sendMessage(chatId, "📎 مثال: <code>/docs EA-202606-0001</code>"); return; }
      const allCases = await getAllCases();
      const c = allCases.find(x => x.caseNumber === caseNumber || x.id === caseNumber);
      if (!c) { await sendMessage(chatId, `❌ لم يتم العثور على الحالة: ${caseNumber}`); return; }
      await showCaseDocuments(chatId, c.id);
      return;
    }

    await sendMessage(chatId, "🤔 أمر غير معروف. اضغط /menu للقائمة الرئيسية");

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
      await sendMessage(chatId, "📋 <b>القائمة الرئيسية</b>", { reply_markup: mainMenuKeyboard() });
    }
    else if (data === "list_cases") {
      await showCasesList(chatId);
    }
    else if (data === "add_case") {
      await startAddCase(chatId);
    }
    else if (data === "search_start") {
      await persistSession(chatId, { state: "search_awaiting_query" });
      await sendMessage(chatId, "🔍 أرسل اسم الشخص أو رقم الحالة للبحث:");
    }
    else if (data === "stats") {
      await showStats(chatId);
    }
    else if (data === "help") {
      await showHelp(chatId);
    }
    else if (data.startsWith("page_")) {
      const page = parseInt(data.replace("page_", ""));
      const cases = (await getAllCases()).sort((a,b) => b.createdAt - a.createdAt);
      await sendMessage(chatId, `📋 <b>الطلبات</b> (${cases.length})`, { reply_markup: casesListKeyboard(cases, page) });
    }
    else if (data.startsWith("view_")) {
      const id = data.replace("view_", "");
      await showCaseDetail(chatId, id);
    }
    else if (data.startsWith("status_")) {
      // format: status_CASEID_STATUS  — but CASEID may contain underscores so split from end
      const withoutPrefix = data.replace("status_", "");
      const lastUnderscore = withoutPrefix.lastIndexOf("_");
      const caseId   = withoutPrefix.substring(0, lastUnderscore);
      const newStatus= withoutPrefix.substring(lastUnderscore + 1);
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
      await persistSession(chatId, {
        state: "attach_awaiting_file",
        caseId: c.id,
        caseNumber: c.caseNumber,
        documents: c.documents || []
      });
      await sendMessage(chatId,
        `📤 <b>إرفاق مستندات بطلب #${c.caseNumber}</b>\n\nأرسل ملف أو أكثر، ثم اكتب <code>تم</code>`
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
        await deleteSession(chatId);
        await sendMessage(chatId,
          `✅ <b>تم إنشاء الطلب بنجاح!</b>\n\n${formatCase(newCase)}`,
          { reply_markup: mainMenuKeyboard() }
        );
      } else if (msg.document || msg.photo) {
        const fileId   = msg.document?.file_id || msg.photo?.[msg.photo.length-1]?.file_id;
        const fileName = msg.document?.file_name || `صورة_${(session.documents||[]).length+1}.jpg`;
        if (!session.documents) session.documents = [];
        const result = await saveFileToChannel(fileId, fileName);
        session.documents.push({
          name:              fileName,
          telegramFileId:    result ? result.fileId   : fileId,
          telegramMessageId: result ? result.messageId: null,
          type:              msg.document ? "document" : "image",
          size:              msg.document?.file_size || 0
        });
        await persistSession(chatId, session);
        await sendMessage(chatId,
          `✅ تم رفع: ${fileName}\n📎 إجمالي المستندات: ${session.documents.length}\n\nأرسل المزيد أو اكتب <code>تم</code>`
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
  }
}

// ===== Service Selection =====
async function handleServiceSelection(chatId, serviceIndex, session) {
  session.serviceType = SERVICE_TYPES[serviceIndex];
  session.state       = "add_description";
  await persistSession(chatId, session);
  await sendMessage(chatId, `📝 اكتب وصف الحالة:\n(أو أرسل <code>تخطي</code>)`);
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
    await sendMessage(chatId, "📋 لا توجد طلبات بعد\nاستخدم /add لإضافة طلب جديد", { reply_markup: mainMenuKeyboard() });
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
  if (c.status !== "responded") extraButtons.push([{ text: "💬 إضافة رد",   callback_data: `respond_${id}` }]);
  if (c.status !== "rejected")  extraButtons.push([{ text: "❌ رفض الطلب", callback_data: `reject_${id}`  }]);
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
    await sendMessage(chatId, "📎 لا توجد مستندات لهذا الطلب");
    return;
  }
  await sendMessage(chatId, `📎 <b>مستندات الطلب #${c.caseNumber}</b> (${c.documents.length} ملف)`);
  for (const doc of c.documents) {
    if (doc.telegramFileId) {
      await sendDocument(chatId, doc.telegramFileId, `📎 ${doc.name}`);
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
  await sendMessage(chatId, `🔍 <b>نتائج البحث</b> (${results.length})`, { reply_markup: casesListKeyboard(results, 0) });
}

// ===== Stats =====
async function showStats(chatId) {
  const cases  = await getAllCases();
  const total  = cases.length;
  const counts = { executed:0, under_review:0, under_procedure:0, responded:0, rejected:0 };
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
    `<b>الأوامر:</b>\n` +
    `/menu - القائمة الرئيسية بأزرار\n` +
    `/add - إضافة طلب جديد (خطوة بخطوة)\n` +
    `/cases - عرض كل الطلبات\n` +
    `/search أحمد - بحث بالاسم أو الرقم القومي أو الهاتف\n` +
    `/stats - الإحصائيات\n` +
    `/attach EA-202606-0001 - إرفاق ملفات بطلب\n` +
    `/logout - تسجيل الخروج\n\n` +
    `<b>الأزرار:</b>\n` +
    `✅⏳🔄💬❌ - تغيير حالة الطلب مباشرة\n` +
    `🗑 حذف الطلب - يحذف الملفات من القناة أيضاً\n\n` +
    `<b>رفع الملفات:</b>\n` +
    `📎 أرسل أي ملف مباشرة → يُحفظ في القناة تلقائياً`,
    { reply_markup: mainMenuKeyboard() }
  );
}

// ===== File Upload (standalone) =====
async function handleFileUpload(chatId, msg) {
  const fileId   = msg.document?.file_id || msg.photo?.[msg.photo.length-1]?.file_id;
  const fileName = msg.document?.file_name || "صورة";
  if (!fileId) return;

  const result = await saveFileToChannel(fileId, fileName);
  if (result) {
    await sendMessage(chatId,
      `✅ <b>تم حفظ المستند في القناة</b>\n\n` +
      `📄 ${fileName}\n` +
      `🆔 Message ID: ${result.messageId}\n\n` +
      `💡 لإرفاقه بطلب:\n<code>/attach رقم_الحالة</code>`
    );
  } else {
    await sendMessage(chatId, `✅ تم استلام: ${fileName}\n⚠️ لم يتم حفظه في القناة`);
  }
}

// ===== Attach File to Case =====
async function startAttachFile(chatId, caseNumber) {
  if (!caseNumber) {
    await sendMessage(chatId, "📝 مثال: <code>/attach EA-202606-0001</code>");
    return;
  }
  const allCases = await getAllCases();
  const c = allCases.find(x => x.caseNumber === caseNumber || x.id === caseNumber);
  if (!c) { await sendMessage(chatId, `❌ لم يتم العثور على الحالة: ${caseNumber}`); return; }
  await persistSession(chatId, { state: "attach_awaiting_file", caseId: c.id, caseNumber: c.caseNumber, documents: c.documents || [] });
  await sendMessage(chatId, `📎 أرسل المستندات لطلب #${c.caseNumber}:\n(أرسل ملف أو أكثر، ثم أرسل <code>تم</code>)`);
}

async function handleAttachFile(chatId, msg, session) {
  const text = msg.text;
  if (text && text.trim() === "تم") {
    await updateCase(session.caseId, { documents: session.documents });
    await deleteSession(chatId);
    await sendMessage(chatId, `✅ تم حفظ ${session.documents.length} مستند لطلب #${session.caseNumber}`, { reply_markup: mainMenuKeyboard() });
    return;
  }

  const fileId   = msg.document?.file_id || msg.photo?.[msg.photo.length-1]?.file_id;
  const fileName = msg.document?.file_name || `صورة_${session.documents.length+1}.jpg`;
  if (!fileId) { await sendMessage(chatId, "📎 أرسل ملف أو اكتب <code>تم</code> لإنهاء"); return; }

  const result = await saveFileToChannel(fileId, fileName);
  session.documents.push({
    name:              fileName,
    telegramFileId:    result ? result.fileId    : fileId,
    telegramMessageId: result ? result.messageId : null,
    type:              msg.document ? "document" : "image",
    size:              msg.document?.file_size || 0
  });
  await persistSession(chatId, session);

  await sendMessage(chatId,
    `✅ تم رفع: ${fileName}\n📎 إجمالي المستندات: ${session.documents.length}\n\nأرسل المزيد أو اكتب <code>تم</code>`
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
          `⏱ البوت يعيد تشغيل نفسه (كل ${RESTART_HOURS} ساعات)\n` +
          `⏰ ${new Date().toLocaleString("ar-EG")}\n\n` +
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
  console.log("🤖 El Ashry Pro Bot v3.0 - جاري التشغيل...");
  console.log(`👤 ${BOT_USERNAME}`);
  console.log(`📌 Token:   ✅ ${BOT_TOKEN.slice(0,10)}...`);
  console.log(`📌 Channel: ✅ ${CHANNEL_ID}`);
  console.log(`🔑 Password: ${BOT_PASSWORD}`);
  console.log(`⏰ إعادة التشغيل كل ${RESTART_HOURS} ساعات`);
  console.log(`🕐 ${new Date().toLocaleString("ar-EG")}`);
  console.log("─────────────────────────────────────────");

  // Load persistent state from Firebase
  await loadAuthUsers();
  await loadSessions();
  console.log(`✅ تم تحميل ${authUsers.size} مستخدم مسجل و ${userSessions.size} جلسة نشطة`);

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
