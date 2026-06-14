"""
El Ashry Pro - Telegram Bot v4.0
الأوامر: /start /menu /add /cases /search /stats /attach /help /logout /case
"""

import os, json, base64, logging, time, threading, io
from datetime import datetime

import requests
from dotenv import load_dotenv
import firebase_admin
from firebase_admin import credentials, db as firebase_db

load_dotenv()

# ─── إعداد ────────────────────────────────────────────
logging.basicConfig(level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s", datefmt="%Y-%m-%d %H:%M:%S")
logger = logging.getLogger(__name__)

BOT_TOKEN                = os.getenv("BOT_TOKEN", "")
CHANNEL_ID               = os.getenv("CHANNEL_ID", "")
FIREBASE_URL             = os.getenv("FIREBASE_URL", "https://el-ashry-default-rtdb.firebaseio.com")
FIREBASE_PATH            = os.getenv("FIREBASE_PATH", "cases")
BOT_PASSWORD             = os.getenv("BOT_PASSWORD", "521988")
FIREBASE_CREDENTIALS_JSON= os.getenv("FIREBASE_CREDENTIALS_JSON", "")
POLL_INTERVAL            = int(os.getenv("POLL_INTERVAL", "30"))

TELEGRAM_API = f"https://api.telegram.org/bot{BOT_TOKEN}"

STATUS_LABELS = {
    "executed":        "✅ تم التنفيذ",
    "under_review":    "🔍 تحت المراجعة",
    "under_procedure": "⚙️ تحت الإجراء",
    "responded":       "💬 تم الرد",
    "rejected":        "❌ طلب مرفوض",
}

# حالة المحادثات (لأوامر متعددة الخطوات)
user_sessions = {}   # chat_id -> {"state": ..., "data": ...}

# ─── Firebase ─────────────────────────────────────────
def init_firebase():
    if firebase_admin._apps:
        return True
    try:
        if FIREBASE_CREDENTIALS_JSON:
            cred = credentials.Certificate(json.loads(FIREBASE_CREDENTIALS_JSON))
        elif os.path.exists("serviceAccountKey.json"):
            cred = credentials.Certificate("serviceAccountKey.json")
        else:
            logger.warning("لا توجد بيانات اعتماد Firebase")
            return False
        firebase_admin.initialize_app(cred, {"databaseURL": FIREBASE_URL})
        logger.info("✅ Firebase متصل")
        return True
    except Exception as e:
        logger.error(f"❌ Firebase: {e}")
        return False

def fb_get(path):
    return firebase_db.reference(path).get()

def fb_set(path, data):
    firebase_db.reference(path).set(data)

def fb_update(path, data):
    firebase_db.reference(path).update(data)

def fb_delete(path):
    firebase_db.reference(path).delete()

def fb_push(path, data):
    return firebase_db.reference(path).push(data)

def fb_counter():
    ref = firebase_db.reference("counters/caseNumber")
    result = ref.transaction(lambda cur: (cur or 0) + 1)
    return result

# ─── تليجرام helpers ──────────────────────────────────
def tg(method, data=None, files=None):
    url = f"{TELEGRAM_API}/{method}"
    try:
        if files:
            r = requests.post(url, data=data, files=files, timeout=30)
        else:
            r = requests.post(url, json=data, timeout=15)
        return r.json()
    except Exception as e:
        logger.error(f"❌ tg/{method}: {e}")
        return {}

def send_msg(text, chat_id, markup=None, parse_mode="HTML"):
    p = {"chat_id": chat_id, "text": text, "parse_mode": parse_mode}
    if markup:
        p["reply_markup"] = markup
    return tg("sendMessage", p)

def edit_msg(chat_id, msg_id, text, markup=None):
    p = {"chat_id": chat_id, "message_id": msg_id, "text": text, "parse_mode": "HTML"}
    if markup:
        p["reply_markup"] = markup
    return tg("editMessageText", p)

def answer_cb(cb_id, text=""):
    tg("answerCallbackQuery", {"callback_query_id": cb_id, "text": text})

def send_doc(file_bytes, caption, chat_id, filename, mime="application/octet-stream"):
    d = {"chat_id": chat_id, "caption": caption, "parse_mode": "HTML"}
    f = {"document": (filename, io.BytesIO(file_bytes), mime)}
    return tg("sendDocument", d, f)

def send_photo(file_bytes, caption, chat_id, filename):
    d = {"chat_id": chat_id, "caption": caption, "parse_mode": "HTML"}
    f = {"photo": (filename, io.BytesIO(file_bytes), "image/jpeg")}
    return tg("sendPhoto", d, f)

def del_msg(chat_id, msg_id):
    tg("deleteMessage", {"chat_id": chat_id, "message_id": msg_id})

# ─── تسجيل قائمة الأوامر في تليجرام ─────────────────
def register_commands():
    commands = [
        {"command": "start",  "description": "بدء البوت 🚀"},
        {"command": "menu",   "description": "القائمة الرئيسية 📋"},
        {"command": "add",    "description": "إضافة طلب جديد ➕"},
        {"command": "cases",  "description": "عرض كل الطلبات 📂"},
        {"command": "search", "description": "بحث عن طلب 🔍"},
        {"command": "stats",  "description": "إحصائيات الطلبات 📊"},
        {"command": "attach", "description": "إرفاق ملف بطلب 📎"},
        {"command": "help",   "description": "المساعدة ❓"},
        {"command": "logout", "description": "تسجيل الخروج 🚪"},
        {"command": "case",   "description": "عرض طلب برقمه (مثال: /case 5)"},
    ]
    result = tg("setMyCommands", {"commands": commands})
    if result.get("ok"):
        logger.info("✅ تم تسجيل الأوامر في تليجرام")
    else:
        logger.warning(f"⚠️ فشل تسجيل الأوامر: {result}")

# ─── تنسيق رسائل الطلبات ──────────────────────────────
def fmt_case(c, event=""):
    sl  = STATUS_LABELS.get(c.get("status",""), c.get("status",""))
    num = c.get("caseNumber","?")
    hdr = {"new":"🆕 <b>طلب جديد</b>","update":"🔄 <b>تحديث طلب</b>"}.get(event, "📋 <b>طلب</b>")
    lines = [f"{hdr} — <b>#{num}</b>", "━━━━━━━━━━━━━━━━━━━━",
             f"👤 <b>الاسم:</b> {c.get('name','—')}"]
    if c.get("phone"):       lines.append(f"📱 <b>الهاتف:</b> <code>{c['phone']}</code>")
    if c.get("nationalId"):  lines.append(f"🆔 <b>الرقم القومي:</b> <code>{c['nationalId']}</code>")
    if c.get("country"):     lines.append(f"🏠 <b>البلد:</b> {c['country']}")
    if c.get("hospital"):    lines.append(f"🏥 <b>المستشفى:</b> {c['hospital']}")
    if c.get("service"):     lines.append(f"📝 <b>الخدمة:</b> {c['service']}")
    lines.append(f"📊 <b>الحالة:</b> {sl}")
    if c.get("submissionDate"): lines.append(f"📅 <b>تاريخ الطلب:</b> {c['submissionDate']}")
    if c.get("responseDate"):   lines.append(f"📆 <b>تاريخ الرد:</b> {c['responseDate']}")
    if c.get("desc"):
        d = c["desc"]; lines.append(f"📄 <b>الوصف:</b> {d[:250]+'...' if len(d)>250 else d}")
    if c.get("status") == "responded" and c.get("response"):
        r = c["response"]; lines.append(f"✅ <b>الرد:</b> {r[:250]+'...' if len(r)>250 else r}")
    if c.get("status") == "rejected" and c.get("rejection"):
        lines.append(f"❌ <b>سبب الرفض:</b> {c['rejection']}")
    docs = c.get("documents", {})
    if isinstance(docs, dict) and docs:
        lines.append(f"📎 <b>مستندات:</b> {len(docs)} ملف")
    lines += ["━━━━━━━━━━━━━━━━━━━━",
              "🏢 <i>مكتب الحاج أحمد الحديدي</i>",
              f"🕐 <i>{datetime.now().strftime('%Y-%m-%d %H:%M')}</i>"]
    return "\n".join(lines)

# ─── أزرار التحكم في الطلب ────────────────────────────
def case_kb(case_id):
    return {"inline_keyboard": [
        [{"text":"✅ تم التنفيذ",      "callback_data":f"st|{case_id}|executed"},
         {"text":"🔍 تحت المراجعة",   "callback_data":f"st|{case_id}|under_review"}],
        [{"text":"⚙️ تحت الإجراء",    "callback_data":f"st|{case_id}|under_procedure"},
         {"text":"💬 تم الرد",         "callback_data":f"st|{case_id}|responded"}],
        [{"text":"❌ رفض الطلب",       "callback_data":f"st|{case_id}|rejected"},
         {"text":"🗑️ حذف",            "callback_data":f"del|{case_id}"}],
        [{"text":"📋 تفاصيل",          "callback_data":f"dtl|{case_id}"},
         {"text":"📎 عرض المستندات",   "callback_data":f"docs|{case_id}"}],
    ]}

# ─── القائمة الرئيسية ─────────────────────────────────
MAIN_MENU_KB = {"inline_keyboard": [
    [{"text":"➕ إضافة طلب جديد",     "callback_data":"cmd|add"},
     {"text":"📂 عرض كل الطلبات",    "callback_data":"cmd|cases"}],
    [{"text":"🔍 بحث عن طلب",         "callback_data":"cmd|search"},
     {"text":"📊 الإحصائيات",          "callback_data":"cmd|stats"}],
    [{"text":"📎 إرفاق ملف بطلب",     "callback_data":"cmd|attach"},
     {"text":"❓ المساعدة",            "callback_data":"cmd|help"}],
]}

def send_main_menu(chat_id):
    send_msg(
        "📋 <b>القائمة الرئيسية — El Ashry Pro</b>\n\nاختر ما تريد:",
        chat_id, MAIN_MENU_KB
    )

# ─── إرسال إشعار الطلب مع مستنداته ───────────────────
def notify_case(cdata, case_id, event="new"):
    send_msg(fmt_case(cdata, event), CHANNEL_ID, case_kb(case_id))
    docs = cdata.get("documents")
    if not isinstance(docs, dict) or not docs:
        return
    logger.info(f"📎 رفع {len(docs)} مستند")
    cap = f"📎 مستندات طلب #{cdata.get('caseNumber')} — {cdata.get('name','')}"
    for doc in list(docs.values())[:10]:
        try:
            raw = doc.get("data", "")
            if "," not in raw:
                continue
            file_bytes = base64.b64decode(raw.split(",", 1)[1])
            fname = doc.get("name", "file")
            mime  = doc.get("type", "application/octet-stream")
            if mime.startswith("image/"):
                send_photo(file_bytes, cap, CHANNEL_ID, fname)
            else:
                send_doc(file_bytes, cap, CHANNEL_ID, fname, mime)
            time.sleep(0.5)
        except Exception as e:
            logger.error(f"❌ مستند: {e}")

# ─── معالجة الأوامر ───────────────────────────────────
def handle_message(msg):
    chat_id  = str(msg.get("chat", {}).get("id", ""))
    text     = (msg.get("text") or "").strip()
    username = msg.get("from", {}).get("username") or msg.get("from", {}).get("first_name", "مستخدم")

    if not text:
        return

    logger.info(f"📩 {username}: {text}")

    # تحقق من حالة المحادثة (wizard)
    session = user_sessions.get(chat_id, {})
    state   = session.get("state", "")

    # ─── معالجة حالات الـ wizard ──────────────────────
    if state == "wait_search_query":
        user_sessions.pop(chat_id, None)
        do_search(text, chat_id)
        return

    if state == "wait_case_num_for_attach":
        user_sessions.pop(chat_id, None)
        try:
            num = int(text)
            data = fb_get(FIREBASE_PATH) or {}
            found_id = None
            for cid, c in data.items():
                if c.get("caseNumber") == num:
                    found_id = cid
                    break
            if not found_id:
                send_msg(f"❌ لا يوجد طلب رقم <b>{num}</b>", chat_id)
                return
            user_sessions[chat_id] = {"state": "wait_file_for_attach", "case_id": found_id, "case_num": num}
            send_msg(f"📎 أرسل الملف أو الصورة لإرفاقها بالطلب رقم <b>{num}</b>:", chat_id)
        except:
            send_msg("❌ أدخل رقمًا صحيحًا.", chat_id)
        return

    if state == "wait_file_for_attach":
        # ملف وصل — معالجته في handle_file
        send_msg("⚠️ الرجاء إرسال ملف أو صورة، وليس نصًا.", chat_id)
        return

    if state.startswith("add_"):
        handle_add_wizard(chat_id, text, state, session)
        return

    # ─── الأوامر العادية ──────────────────────────────
    cmd = text.split()[0].lower().lstrip("/").split("@")[0]
    arg = text[len(cmd)+2:].strip() if len(text) > len(cmd)+1 else ""

    if cmd in ("start",):
        user_sessions.pop(chat_id, None)
        send_msg(
            "👋 <b>مرحباً بك في بوت El Ashry Pro</b>\n\n"
            "🏢 نظام إدارة الطلبات الطبية\n"
            "مكتب الحاج أحمد الحديدي\n\n"
            "اكتب /menu لعرض القائمة الرئيسية",
            chat_id
        )

    elif cmd in ("menu",):
        user_sessions.pop(chat_id, None)
        send_main_menu(chat_id)

    elif cmd in ("add",):
        user_sessions.pop(chat_id, None)
        start_add_wizard(chat_id)

    elif cmd in ("cases",):
        user_sessions.pop(chat_id, None)
        do_list_cases(chat_id)

    elif cmd in ("search",):
        if arg:
            do_search(arg, chat_id)
        else:
            user_sessions[chat_id] = {"state": "wait_search_query"}
            send_msg("🔍 أدخل كلمة البحث (اسم / هاتف / بلد / رقم قومي):", chat_id)

    elif cmd in ("stats",):
        user_sessions.pop(chat_id, None)
        do_stats(chat_id)

    elif cmd in ("attach",):
        user_sessions.pop(chat_id, None)
        user_sessions[chat_id] = {"state": "wait_case_num_for_attach"}
        send_msg("📎 أدخل رقم الطلب الذي تريد إرفاق ملف به:", chat_id)

    elif cmd in ("help",):
        user_sessions.pop(chat_id, None)
        send_msg(
            "❓ <b>المساعدة — El Ashry Pro Bot</b>\n\n"
            "/menu — القائمة الرئيسية\n"
            "/add — إضافة طلب جديد\n"
            "/cases — عرض كل الطلبات\n"
            "/search — بحث عن طلب\n"
            "/stats — إحصائيات الطلبات\n"
            "/attach — إرفاق ملف بطلب\n"
            "/case 5 — عرض طلب برقمه\n"
            "/logout — إلغاء العملية الحالية\n\n"
            "🎛️ كل طلب يأتي مع أزرار تحكم للتحديث والحذف\n"
            "📎 المستندات تُرفع تلقائيًا مع كل طلب",
            chat_id
        )

    elif cmd in ("logout",):
        user_sessions.pop(chat_id, None)
        send_msg("🚪 تم إلغاء العملية الحالية. اكتب /menu للعودة.", chat_id)

    elif cmd in ("case",):
        user_sessions.pop(chat_id, None)
        if arg:
            try:
                do_get_case(int(arg), chat_id)
            except:
                send_msg("❌ مثال صحيح: /case 5", chat_id)
        else:
            send_msg("❌ أدخل رقم الطلب. مثال: /case 5", chat_id)

    else:
        send_msg(
            f"❓ الأمر <b>/{cmd}</b> غير موجود.\n\n"
            "الأوامر المتاحة:\n"
            "/menu /add /cases /search /stats /attach /help /logout",
            chat_id
        )

# ─── معالجة الملفات المرفقة ───────────────────────────
def handle_file(msg):
    chat_id = str(msg.get("chat", {}).get("id", ""))
    session = user_sessions.get(chat_id, {})

    if session.get("state") != "wait_file_for_attach":
        send_msg("⚠️ استخدم /attach لإرفاق ملف بطلب.", chat_id)
        return

    case_id  = session.get("case_id")
    case_num = session.get("case_num")

    # استخراج الملف
    file_id, filename, mime = None, "file", "application/octet-stream"
    if msg.get("document"):
        doc = msg["document"]
        file_id  = doc["file_id"]
        filename = doc.get("file_name", "document")
        mime     = doc.get("mime_type", mime)
    elif msg.get("photo"):
        photo   = sorted(msg["photo"], key=lambda x: x["file_size"], reverse=True)[0]
        file_id  = photo["file_id"]
        filename = f"photo_{int(time.time())}.jpg"
        mime     = "image/jpeg"

    if not file_id:
        send_msg("❌ نوع الملف غير مدعوم.", chat_id)
        return

    try:
        # تنزيل الملف من تليجرام
        finfo = tg("getFile", {"file_id": file_id})
        if not finfo.get("ok"):
            send_msg("❌ فشل تنزيل الملف.", chat_id)
            return

        file_path_tg = finfo["result"]["file_path"]
        url = f"https://api.telegram.org/file/bot{BOT_TOKEN}/{file_path_tg}"
        r = requests.get(url, timeout=30)
        file_bytes = r.content

        # تحويل لـ base64 وحفظ في Firebase
        b64 = "data:" + mime + ";base64," + base64.b64encode(file_bytes).decode()
        doc_data = {
            "name": filename,
            "type": mime,
            "data": b64,
            "size": len(file_bytes),
            "addedAt": datetime.now().isoformat(),
        }
        fb_push(f"{FIREBASE_PATH}/{case_id}/documents", doc_data)
        fb_update(f"{FIREBASE_PATH}/{case_id}", {"updatedAt": datetime.now().isoformat()})

        user_sessions.pop(chat_id, None)
        send_msg(f"✅ تم إرفاق <b>{filename}</b> بالطلب رقم <b>{case_num}</b> بنجاح!", chat_id)
        logger.info(f"📎 ملف مرفق بطلب {case_num}")

    except Exception as e:
        logger.error(f"❌ رفع ملف: {e}")
        send_msg("❌ حدث خطأ أثناء رفع الملف.", chat_id)

# ─── wizard إضافة طلب جديد ────────────────────────────
ADD_STEPS = [
    ("add_name",        "👤 أدخل <b>اسم المريض</b>:"),
    ("add_phone",       "📱 أدخل <b>رقم الهاتف</b> (أو أرسل - للتخطي):"),
    ("add_nationalid",  "🆔 أدخل <b>الرقم القومي</b> (أو - للتخطي):"),
    ("add_country",     "🏠 أدخل <b>البلد</b> (أو - للتخطي):"),
    ("add_hospital",    "🏥 أدخل <b>المستشفى</b> (أو - للتخطي):"),
    ("add_service",     "📝 أدخل <b>نوع الخدمة</b>:"),
    ("add_desc",        "📄 أدخل <b>وصف الطلب</b> (أو - للتخطي):"),
    ("add_date",        "📅 أدخل <b>تاريخ الطلب</b> (مثال: 2026-06-14) أو - لليوم:"),
]
ADD_FIELDS = ["name","phone","nationalId","country","hospital","service","desc","submissionDate"]

def start_add_wizard(chat_id):
    user_sessions[chat_id] = {"state": "add_name", "data": {}}
    send_msg(ADD_STEPS[0][1], chat_id)

def handle_add_wizard(chat_id, text, state, session):
    data = session.get("data", {})
    # إيجاد الخطوة الحالية
    step_idx = next((i for i, (s,_) in enumerate(ADD_STEPS) if s == state), None)
    if step_idx is None:
        user_sessions.pop(chat_id, None)
        return

    field = ADD_FIELDS[step_idx]
    value = text if text != "-" else ""

    # تاريخ اليوم تلقائي
    if field == "submissionDate" and text == "-":
        value = datetime.now().strftime("%Y-%m-%d")

    data[field] = value
    session["data"] = data

    # الخطوة التالية
    if step_idx + 1 < len(ADD_STEPS):
        next_state, next_prompt = ADD_STEPS[step_idx + 1]
        session["state"] = next_state
        user_sessions[chat_id] = session
        send_msg(next_prompt, chat_id)
    else:
        # حفظ الطلب
        user_sessions.pop(chat_id, None)
        save_new_case(chat_id, data)

def save_new_case(chat_id, data):
    if not data.get("name"):
        send_msg("❌ الاسم مطلوب. ابدأ من جديد بـ /add", chat_id)
        return
    if not data.get("service"):
        send_msg("❌ نوع الخدمة مطلوب. ابدأ من جديد بـ /add", chat_id)
        return

    try:
        new_num = fb_counter()
        case_data = {
            **data,
            "caseNumber": new_num,
            "status": "under_review",
            "createdAt": datetime.now().isoformat(),
            "updatedAt": datetime.now().isoformat(),
        }
        new_ref = fb_push(FIREBASE_PATH, case_data)
        case_id = new_ref.key

        send_msg(
            f"✅ <b>تم حفظ الطلب رقم #{new_num} بنجاح!</b>\n\n"
            f"👤 الاسم: {data.get('name')}\n"
            f"📝 الخدمة: {data.get('service')}\n"
            f"📊 الحالة: 🔍 تحت المراجعة\n\n"
            f"📎 لإرفاق ملفات: /attach",
            chat_id
        )
        # إرسال إشعار للقناة
        if CHANNEL_ID:
            notify_case(case_data, case_id, "new")
        logger.info(f"✅ طلب جديد #{new_num} أُضيف من تليجرام")
    except Exception as e:
        logger.error(f"❌ حفظ طلب: {e}")
        send_msg("❌ حدث خطأ أثناء الحفظ.", chat_id)

# ─── أوامر القراءة ────────────────────────────────────
def do_list_cases(chat_id, limit=5):
    try:
        data = fb_get(FIREBASE_PATH) or {}
        cases = sorted(data.items(), key=lambda x: x[1].get("caseNumber",0), reverse=True)
        if not cases:
            send_msg("📂 لا توجد طلبات حتى الآن.", chat_id)
            return
        total = len(cases)
        send_msg(f"📂 <b>آخر الطلبات</b> (إجمالي: {total})\nاستخدم /case رقم لعرض تفاصيل طلب:", chat_id)
        for case_id, c in cases[:limit]:
            send_msg(fmt_case(c), chat_id, case_kb(case_id))
            time.sleep(0.3)
        if total > limit:
            send_msg(f"📄 يوجد {total - limit} طلب آخر — استخدم /search للبحث.", chat_id)
    except Exception as e:
        logger.error(f"❌ list cases: {e}")
        send_msg("❌ خطأ في جلب الطلبات.", chat_id)

def do_search(query, chat_id):
    try:
        data = fb_get(FIREBASE_PATH) or {}
        q = query.lower()
        results = [
            (cid, c) for cid, c in data.items()
            if q in str(c.get("name","")).lower()
            or q in str(c.get("phone","")).lower()
            or q in str(c.get("country","")).lower()
            or q in str(c.get("nationalId","")).lower()
            or q in str(c.get("caseNumber","")).lower()
            or q in str(c.get("hospital","")).lower()
        ]
        if not results:
            send_msg(f"🔍 لا توجد نتائج لـ: <b>{query}</b>", chat_id)
            return
        send_msg(f"🔍 نتائج البحث عن «<b>{query}</b>» — {len(results)} نتيجة:", chat_id)
        for case_id, c in results[:5]:
            send_msg(fmt_case(c), chat_id, case_kb(case_id))
            time.sleep(0.3)
        if len(results) > 5:
            send_msg(f"⚠️ تم عرض 5 من {len(results)} — دقق البحث للمزيد.", chat_id)
    except Exception as e:
        logger.error(f"❌ search: {e}")
        send_msg("❌ خطأ في البحث.", chat_id)

def do_get_case(num, chat_id):
    try:
        data = fb_get(FIREBASE_PATH) or {}
        for cid, c in data.items():
            if c.get("caseNumber") == num:
                send_msg(fmt_case(c), chat_id, case_kb(cid))
                return
        send_msg(f"❌ لا يوجد طلب رقم <b>{num}</b>", chat_id)
    except Exception as e:
        logger.error(f"❌ get case: {e}")
        send_msg("❌ خطأ في جلب الطلب.", chat_id)

def do_stats(chat_id):
    try:
        data = fb_get(FIREBASE_PATH) or {}
        total = len(data)
        stats = {}
        for c in data.values():
            s = c.get("status","unknown")
            stats[s] = stats.get(s,0) + 1
        lines = ["📊 <b>إحصائيات الطلبات</b>", "━━━━━━━━━━━━━━━━━━━━",
                 f"📦 <b>الإجمالي:</b> {total}", ""]
        for k, lbl in STATUS_LABELS.items():
            lines.append(f"{lbl}: <b>{stats.get(k,0)}</b>")
        lines += ["━━━━━━━━━━━━━━━━━━━━",
                  f"🕐 {datetime.now().strftime('%Y-%m-%d %H:%M')}"]
        send_msg("\n".join(lines), chat_id)
    except Exception as e:
        logger.error(f"❌ stats: {e}")
        send_msg("❌ خطأ في الإحصائيات.", chat_id)

# ─── معالجة Callbacks ─────────────────────────────────
def handle_callback(cb):
    cb_id   = cb["id"]
    chat_id = str(cb["message"]["chat"]["id"])
    msg_id  = cb["message"]["message_id"]
    data    = cb.get("data","")
    user    = cb.get("from",{})
    uname   = user.get("username") or user.get("first_name","مستخدم")

    parts = data.split("|")
    action = parts[0]

    # تغيير الحالة
    if action == "st" and len(parts) == 3:
        _, case_id, new_status = parts
        lbl = STATUS_LABELS.get(new_status, new_status)
        try:
            fb_update(f"{FIREBASE_PATH}/{case_id}",
                      {"status": new_status, "updatedAt": datetime.now().isoformat()})
            answer_cb(cb_id, f"✅ {lbl}")
            logger.info(f"✅ طلب {case_id} → {new_status} بواسطة {uname}")
            c = fb_get(f"{FIREBASE_PATH}/{case_id}")
            if c:
                edit_msg(chat_id, msg_id, fmt_case(c,"update"), case_kb(case_id))
        except Exception as e:
            answer_cb(cb_id, "❌ خطأ")
            logger.error(f"❌ تحديث حالة: {e}")

    # حذف (طلب تأكيد)
    elif action == "del" and len(parts) == 2:
        case_id = parts[1]
        answer_cb(cb_id)
        edit_msg(chat_id, msg_id,
            "⚠️ <b>تأكيد الحذف</b>\n\nهل أنت متأكد من حذف هذا الطلب نهائيًا؟",
            {"inline_keyboard":[[
                {"text":"✅ نعم، احذف","callback_data":f"cfm|{case_id}"},
                {"text":"❌ إلغاء",    "callback_data":f"cnl|{case_id}"},
            ]]})

    # تأكيد الحذف
    elif action == "cfm" and len(parts) == 2:
        case_id = parts[1]
        try:
            fb_delete(f"{FIREBASE_PATH}/{case_id}")
            answer_cb(cb_id, "🗑️ تم الحذف")
            del_msg(chat_id, msg_id)
            logger.info(f"🗑️ طلب {case_id} حُذف بواسطة {uname}")
        except Exception as e:
            answer_cb(cb_id, "❌ خطأ")
            logger.error(f"❌ حذف: {e}")

    # إلغاء الحذف
    elif action == "cnl" and len(parts) == 2:
        case_id = parts[1]
        answer_cb(cb_id, "تم الإلغاء")
        try:
            c = fb_get(f"{FIREBASE_PATH}/{case_id}")
            if c:
                edit_msg(chat_id, msg_id, fmt_case(c,"update"), case_kb(case_id))
        except:
            pass

    # تفاصيل
    elif action == "dtl" and len(parts) == 2:
        case_id = parts[1]
        answer_cb(cb_id)
        try:
            c = fb_get(f"{FIREBASE_PATH}/{case_id}")
            if c:
                txt = fmt_case(c,"update") + f"\n🆔 <b>معرف:</b> <code>{case_id}</code>"
                send_msg(txt, chat_id, case_kb(case_id))
        except Exception as e:
            logger.error(f"❌ تفاصيل: {e}")

    # عرض المستندات
    elif action == "docs" and len(parts) == 2:
        case_id = parts[1]
        answer_cb(cb_id)
        try:
            c = fb_get(f"{FIREBASE_PATH}/{case_id}")
            if not c:
                return
            docs = c.get("documents")
            if not isinstance(docs, dict) or not docs:
                send_msg(f"📎 لا توجد مستندات للطلب #{c.get('caseNumber')}", chat_id)
                return
            cap = f"📎 مستندات طلب #{c.get('caseNumber')} — {c.get('name','')}"
            send_msg(f"📎 جاري إرسال {len(docs)} مستند...", chat_id)
            for doc in list(docs.values())[:10]:
                try:
                    raw = doc.get("data","")
                    if "," not in raw:
                        continue
                    fb = base64.b64decode(raw.split(",",1)[1])
                    fname = doc.get("name","file")
                    mime  = doc.get("type","application/octet-stream")
                    if mime.startswith("image/"):
                        send_photo(fb, cap, chat_id, fname)
                    else:
                        send_doc(fb, cap, chat_id, fname, mime)
                    time.sleep(0.5)
                except Exception as e:
                    logger.error(f"❌ doc: {e}")
        except Exception as e:
            logger.error(f"❌ docs: {e}")

    # أوامر من القائمة
    elif action == "cmd" and len(parts) == 2:
        answer_cb(cb_id)
        cmd_map = {
            "add":    start_add_wizard,
            "cases":  do_list_cases,
            "search": lambda cid: [
                user_sessions.update({cid: {"state":"wait_search_query"}}),
                send_msg("🔍 أدخل كلمة البحث:", cid)
            ],
            "stats":  do_stats,
            "attach": lambda cid: [
                user_sessions.update({cid: {"state":"wait_case_num_for_attach"}}),
                send_msg("📎 أدخل رقم الطلب:", cid)
            ],
            "help":   lambda cid: handle_message({"chat":{"id":int(cid)}, "text":"/help",
                                                   "from":{"first_name":"user"}}),
        }
        fn = cmd_map.get(parts[1])
        if fn:
            fn(chat_id)

    else:
        answer_cb(cb_id)

# ─── مراقبة Firebase ──────────────────────────────────
class FirebaseMonitor:
    def __init__(self):
        self.known = {}
        self.ready = False

    def load(self):
        try:
            self.known = fb_get(FIREBASE_PATH) or {}
            self.ready = True
            logger.info(f"📦 تحميل {len(self.known)} طلب موجود")
        except Exception as e:
            logger.error(f"❌ تحميل: {e}")
            self.ready = True

    def check(self):
        try:
            current = fb_get(FIREBASE_PATH) or {}
            new_c, upd_c = [], []
            for cid, cd in current.items():
                if cid not in self.known:
                    new_c.append((cid, cd))
                else:
                    if cd.get("updatedAt","") != self.known[cid].get("updatedAt",""):
                        upd_c.append((cid, cd))
            self.known = current
            for cid, cd in new_c:
                notify_case(cd, cid, "new"); time.sleep(1)
            for cid, cd in upd_c:
                notify_case(cd, cid, "update"); time.sleep(1)
        except Exception as e:
            logger.error(f"❌ check: {e}")

    def run(self):
        logger.info(f"👀 مراقبة Firebase كل {POLL_INTERVAL}s...")
        self.load()
        while True:
            try:
                self.check()
                time.sleep(POLL_INTERVAL)
            except KeyboardInterrupt:
                break
            except Exception as e:
                logger.error(f"❌: {e}")
                time.sleep(POLL_INTERVAL)

# ─── Polling ──────────────────────────────────────────
class Poller:
    def __init__(self):
        self.offset = 0

    def run(self):
        logger.info("🤖 Polling نشط...")
        while True:
            try:
                r = requests.get(f"{TELEGRAM_API}/getUpdates",
                    params={"offset":self.offset,"timeout":30}, timeout=35)
                updates = r.json().get("result",[]) if r.json().get("ok") else []
                for upd in updates:
                    self.offset = upd["update_id"] + 1
                    try:
                        if "message" in upd:
                            msg = upd["message"]
                            if msg.get("text"):
                                handle_message(msg)
                            elif msg.get("document") or msg.get("photo"):
                                handle_file(msg)
                        elif "callback_query" in upd:
                            handle_callback(upd["callback_query"])
                    except Exception as e:
                        logger.error(f"❌ update: {e}")
            except KeyboardInterrupt:
                break
            except Exception as e:
                logger.error(f"❌ polling: {e}")
                time.sleep(5)

# ─── Main ─────────────────────────────────────────────
def main():
    logger.info("="*50)
    logger.info("🚀 El Ashry Pro Bot v4.0")
    logger.info("="*50)

    if not BOT_TOKEN:
        logger.error("❌ BOT_TOKEN غير محدد!")
        return

    firebase_ok = init_firebase()
    register_commands()

    send_msg(
        "🚀 <b>El Ashry Pro Bot v4.0 — تم التشغيل</b>\n"
        f"🕐 {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}\n"
        f"🔗 Firebase: {'✅ متصل' if firebase_ok else '❌ غير متصل'}\n"
        "✅ جميع الأوامر نشطة",
        CHANNEL_ID
    )

    if firebase_ok:
        t = threading.Thread(target=FirebaseMonitor().run, daemon=True)
        t.start()

    Poller().run()

if __name__ == "__main__":
    main()
