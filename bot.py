"""
El Ashry Pro - Telegram Bot (Python)
يراقب Firebase Realtime Database ويرسل إشعارات تلغرام عند إضافة/تحديث الطلبات
"""

import os
import json
import asyncio
import logging
import time
from datetime import datetime

import aiohttp
import requests
from dotenv import load_dotenv
import firebase_admin
from firebase_admin import credentials, db as firebase_db

load_dotenv()

# ─── إعداد Logging ───────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
logger = logging.getLogger(__name__)

# ─── إعداد المتغيرات البيئية ──────────────────────────────────
BOT_TOKEN = os.getenv("BOT_TOKEN", "")
CHANNEL_ID = os.getenv("CHANNEL_ID", "")
FIREBASE_URL = os.getenv("FIREBASE_URL", "https://el-ashry-default-rtdb.firebaseio.com")
FIREBASE_PATH = os.getenv("FIREBASE_PATH", "cases")
BOT_PASSWORD = os.getenv("BOT_PASSWORD", "521988")

# إعداد بيانات Firebase من متغير بيئي JSON
FIREBASE_CREDENTIALS_JSON = os.getenv("FIREBASE_CREDENTIALS_JSON", "")

# ─── ثوابت ───────────────────────────────────────────────────
STATUS_LABELS = {
    "executed": "✅ تم التنفيذ",
    "under_review": "🔍 تحت المراجعة",
    "under_procedure": "⚙️ تحت الإجراء",
    "responded": "💬 تم الرد",
    "rejected": "❌ طلب مرفوض",
}

TELEGRAM_API = f"https://api.telegram.org/bot{BOT_TOKEN}"

# ─── تهيئة Firebase ──────────────────────────────────────────
def init_firebase():
    if firebase_admin._apps:
        return True
    try:
        if FIREBASE_CREDENTIALS_JSON:
            cred_dict = json.loads(FIREBASE_CREDENTIALS_JSON)
            cred = credentials.Certificate(cred_dict)
        elif os.path.exists("serviceAccountKey.json"):
            cred = credentials.Certificate("serviceAccountKey.json")
        else:
            logger.warning("لا توجد بيانات اعتماد Firebase - سيعمل البوت بدون مراقبة Firebase")
            return False

        firebase_admin.initialize_app(cred, {"databaseURL": FIREBASE_URL})
        logger.info("✅ تم الاتصال بـ Firebase بنجاح")
        return True
    except Exception as e:
        logger.error(f"❌ خطأ في تهيئة Firebase: {e}")
        return False


# ─── إرسال رسالة تلغرام ──────────────────────────────────────
async def send_telegram_message(text: str, chat_id: str = None, parse_mode: str = "HTML") -> bool:
    target = chat_id or CHANNEL_ID
    if not target:
        logger.warning("لم يتم تحديد CHANNEL_ID")
        return False

    url = f"{TELEGRAM_API}/sendMessage"
    payload = {
        "chat_id": target,
        "text": text,
        "parse_mode": parse_mode,
    }

    try:
        async with aiohttp.ClientSession() as session:
            async with session.post(url, json=payload, timeout=aiohttp.ClientTimeout(total=10)) as resp:
                data = await resp.json()
                if data.get("ok"):
                    logger.info(f"✅ تم إرسال الرسالة إلى {target}")
                    return True
                else:
                    logger.error(f"❌ خطأ تلغرام: {data.get('description', 'خطأ غير معروف')}")
                    return False
    except Exception as e:
        logger.error(f"❌ خطأ في الإرسال: {e}")
        return False


def send_telegram_message_sync(text: str, chat_id: str = None, parse_mode: str = "HTML") -> bool:
    target = chat_id or CHANNEL_ID
    if not target:
        return False

    url = f"{TELEGRAM_API}/sendMessage"
    payload = {"chat_id": target, "text": text, "parse_mode": parse_mode}

    try:
        resp = requests.post(url, json=payload, timeout=10)
        data = resp.json()
        if data.get("ok"):
            logger.info(f"✅ رسالة أُرسلت إلى {target}")
            return True
        else:
            logger.error(f"❌ خطأ تلغرام: {data.get('description')}")
            return False
    except Exception as e:
        logger.error(f"❌ خطأ في الإرسال: {e}")
        return False


# ─── تنسيق رسالة الطلب ───────────────────────────────────────
def format_case_message(case_data: dict, case_id: str, event_type: str = "new") -> str:
    status = case_data.get("status", "under_review")
    status_label = STATUS_LABELS.get(status, status)
    case_num = case_data.get("caseNumber", "?")
    name = case_data.get("name", "غير معروف")
    phone = case_data.get("phone", "")
    national_id = case_data.get("nationalId", "")
    country = case_data.get("country", "")
    hospital = case_data.get("hospital", "")
    service = case_data.get("service", "")
    desc = case_data.get("desc", "")
    submission_date = case_data.get("submissionDate", "")
    response_date = case_data.get("responseDate", "")
    response = case_data.get("response", "")
    rejection = case_data.get("rejection", "")

    if event_type == "new":
        header = f"🆕 <b>طلب جديد #{case_num}</b>"
    elif event_type == "update":
        header = f"🔄 <b>تحديث طلب #{case_num}</b>"
    else:
        header = f"📋 <b>طلب #{case_num}</b>"

    lines = [
        header,
        "━━━━━━━━━━━━━━━━━━━━",
        f"👤 <b>الاسم:</b> {name}",
    ]

    if phone:
        lines.append(f"📱 <b>الهاتف:</b> <code>{phone}</code>")
    if national_id:
        lines.append(f"🆔 <b>الرقم القومي:</b> <code>{national_id}</code>")
    if country:
        lines.append(f"🏠 <b>البلد:</b> {country}")
    if hospital:
        lines.append(f"🏥 <b>المستشفى:</b> {hospital}")
    if service:
        lines.append(f"📝 <b>الخدمة:</b> {service}")

    lines.append(f"📊 <b>الحالة:</b> {status_label}")

    if submission_date:
        lines.append(f"📅 <b>تاريخ الطلب:</b> {submission_date}")
    if response_date:
        lines.append(f"📆 <b>تاريخ الرد:</b> {response_date}")
    if desc:
        short_desc = desc[:200] + "..." if len(desc) > 200 else desc
        lines.append(f"📄 <b>الوصف:</b> {short_desc}")
    if status == "responded" and response:
        short_resp = response[:200] + "..." if len(response) > 200 else response
        lines.append(f"✅ <b>الرد:</b> {short_resp}")
    if status == "rejected" and rejection:
        lines.append(f"❌ <b>سبب الرفض:</b> {rejection}")

    lines.append("━━━━━━━━━━━━━━━━━━━━")
    lines.append("🏢 <i>مكتب الحاج أحمد الحديدي</i>")

    now = datetime.now().strftime("%Y-%m-%d %H:%M")
    lines.append(f"🕐 <i>{now}</i>")

    return "\n".join(lines)


# ─── مراقبة Firebase ─────────────────────────────────────────
class FirebaseMonitor:
    def __init__(self):
        self.known_cases: dict = {}
        self.initialized = False

    def load_existing_cases(self):
        """تحميل الطلبات الموجودة مسبقًا لتجنب إرسال إشعارات عنها"""
        try:
            ref = firebase_db.reference(FIREBASE_PATH)
            data = ref.get()
            if data:
                self.known_cases = data
                logger.info(f"📦 تم تحميل {len(data)} طلب موجود")
            else:
                self.known_cases = {}
                logger.info("📦 لا توجد طلبات موجودة")
            self.initialized = True
        except Exception as e:
            logger.error(f"❌ خطأ في تحميل الطلبات: {e}")
            self.known_cases = {}
            self.initialized = True

    def check_for_changes(self):
        """التحقق من التغييرات في Firebase"""
        try:
            ref = firebase_db.reference(FIREBASE_PATH)
            current_data = ref.get() or {}

            new_cases = []
            updated_cases = []

            for case_id, case_data in current_data.items():
                if case_id not in self.known_cases:
                    # طلب جديد
                    new_cases.append((case_id, case_data))
                else:
                    # تحقق من التحديث
                    old_updated = self.known_cases[case_id].get("updatedAt", "")
                    new_updated = case_data.get("updatedAt", "")
                    if new_updated and new_updated != old_updated:
                        updated_cases.append((case_id, case_data))

            self.known_cases = current_data
            return new_cases, updated_cases

        except Exception as e:
            logger.error(f"❌ خطأ في قراءة Firebase: {e}")
            return [], []

    def run_monitoring_loop(self, interval: int = 30):
        """حلقة المراقبة الرئيسية"""
        logger.info(f"👀 بدء مراقبة Firebase (كل {interval} ثانية)...")
        self.load_existing_cases()

        while True:
            try:
                new_cases, updated_cases = self.check_for_changes()

                for case_id, case_data in new_cases:
                    msg = format_case_message(case_data, case_id, "new")
                    send_telegram_message_sync(msg)
                    time.sleep(0.5)  # تجنب الإرسال السريع جداً

                for case_id, case_data in updated_cases:
                    msg = format_case_message(case_data, case_id, "update")
                    send_telegram_message_sync(msg)
                    time.sleep(0.5)

                time.sleep(interval)

            except KeyboardInterrupt:
                logger.info("🛑 تم إيقاف المراقبة")
                break
            except Exception as e:
                logger.error(f"❌ خطأ في حلقة المراقبة: {e}")
                time.sleep(interval)


# ─── بوت تلغرام ──────────────────────────────────────────────
class TelegramBot:
    def __init__(self):
        self.offset = 0
        self.password = BOT_PASSWORD

    def get_updates(self) -> list:
        try:
            resp = requests.get(
                f"{TELEGRAM_API}/getUpdates",
                params={"offset": self.offset, "timeout": 30},
                timeout=35,
            )
            data = resp.json()
            if data.get("ok"):
                return data.get("result", [])
            return []
        except Exception as e:
            logger.error(f"❌ خطأ في getUpdates: {e}")
            return []

    def handle_update(self, update: dict):
        msg = update.get("message", {})
        if not msg:
            return

        chat_id = str(msg.get("chat", {}).get("id", ""))
        text = msg.get("text", "").strip()
        user = msg.get("from", {})
        username = user.get("username", user.get("first_name", "مستخدم"))

        logger.info(f"📩 رسالة من {username}: {text}")

        if text == "/start":
            reply = (
                "👋 <b>مرحباً بك في بوت El Ashry Pro</b>\n\n"
                "📋 هذا البوت يرسل إشعارات تلقائية عند:\n"
                "• إضافة طلب جديد\n"
                "• تحديث حالة طلب موجود\n\n"
                "🔧 الأوامر المتاحة:\n"
                "/start - بدء البوت\n"
                "/stats - إحصائيات الطلبات\n"
                "/help - المساعدة"
            )
            send_telegram_message_sync(reply, chat_id)

        elif text == "/stats":
            self.send_stats(chat_id)

        elif text == "/help":
            reply = (
                "ℹ️ <b>مساعدة - El Ashry Pro Bot</b>\n\n"
                "/start - بدء البوت\n"
                "/stats - إحصائيات الطلبات الحالية\n"
                "/help - عرض هذه المساعدة\n\n"
                "📲 يرسل البوت إشعارًا تلقائيًا عند كل إضافة أو تحديث."
            )
            send_telegram_message_sync(reply, chat_id)

        else:
            reply = "❓ أمر غير معروف. اكتب /help للمساعدة."
            send_telegram_message_sync(reply, chat_id)

    def send_stats(self, chat_id: str):
        try:
            if not firebase_admin._apps:
                send_telegram_message_sync("⚠️ Firebase غير متصل", chat_id)
                return

            ref = firebase_db.reference(FIREBASE_PATH)
            data = ref.get() or {}
            total = len(data)
            stats = {}
            for case in data.values():
                s = case.get("status", "unknown")
                stats[s] = stats.get(s, 0) + 1

            lines = [
                f"📊 <b>إحصائيات الطلبات</b>",
                "━━━━━━━━━━━━━━━━━━━━",
                f"📦 <b>إجمالي الطلبات:</b> {total}",
            ]
            for status, label in STATUS_LABELS.items():
                count = stats.get(status, 0)
                if count:
                    lines.append(f"{label}: {count}")

            lines.append("━━━━━━━━━━━━━━━━━━━━")
            lines.append(f"🕐 {datetime.now().strftime('%Y-%m-%d %H:%M')}")
            send_telegram_message_sync("\n".join(lines), chat_id)

        except Exception as e:
            logger.error(f"خطأ في الإحصائيات: {e}")
            send_telegram_message_sync("❌ حدث خطأ في جلب الإحصائيات", chat_id)

    def run_polling(self):
        logger.info("🤖 بدء تشغيل بوت تلغرام (polling)...")
        while True:
            try:
                updates = self.get_updates()
                for update in updates:
                    self.offset = update["update_id"] + 1
                    self.handle_update(update)
            except KeyboardInterrupt:
                logger.info("🛑 تم إيقاف البوت")
                break
            except Exception as e:
                logger.error(f"❌ خطأ في polling: {e}")
                time.sleep(5)


# ─── نقطة الدخول الرئيسية ─────────────────────────────────────
def main():
    logger.info("=" * 50)
    logger.info("🚀 El Ashry Pro - Telegram Bot بدء التشغيل")
    logger.info("=" * 50)

    if not BOT_TOKEN:
        logger.error("❌ BOT_TOKEN غير محدد في المتغيرات البيئية!")
        return

    if not CHANNEL_ID:
        logger.warning("⚠️ CHANNEL_ID غير محدد - لن يتم إرسال الإشعارات للقناة")

    firebase_ok = init_firebase()

    # إرسال رسالة تشغيل
    startup_msg = (
        "🚀 <b>El Ashry Pro Bot - تم التشغيل</b>\n"
        f"🕐 {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}\n"
        f"🔗 Firebase: {'✅ متصل' if firebase_ok else '❌ غير متصل'}\n"
        "👀 المراقبة نشطة..."
    )
    send_telegram_message_sync(startup_msg)

    if firebase_ok:
        # تشغيل المراقبة في thread منفصل
        import threading

        monitor = FirebaseMonitor()
        monitor_thread = threading.Thread(
            target=monitor.run_monitoring_loop,
            kwargs={"interval": 30},
            daemon=True,
        )
        monitor_thread.start()
        logger.info("✅ مراقبة Firebase نشطة في الخلفية")

    # تشغيل بوت تلغرام
    bot = TelegramBot()
    bot.run_polling()


if __name__ == "__main__":
    main()
