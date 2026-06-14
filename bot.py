"""
بوت تليجرام احترافي - إدارة الطلبات البرلمانية
نسخة محدثة: دعم جلب المستندات من archive حسب رقم الطلب
"""

import os
import json
import logging
import sys
import asyncio
import aiohttp
from datetime import datetime
from threading import Thread
import http.server
import socketserver

import firebase_admin
from firebase_admin import credentials, db, storage

from telegram import (
    InlineKeyboardButton, InlineKeyboardMarkup, BotCommand, InputFile
)
from telegram.ext import (
    Application, CommandHandler, MessageHandler, filters,
    ConversationHandler, CallbackQueryHandler
)
from telegram.constants import ParseMode

# ─────────────────────────────────────────
# Logging
# ─────────────────────────────────────────
logging.basicConfig(
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    level=logging.INFO,
    handlers=[logging.StreamHandler(sys.stdout)],
)
logger = logging.getLogger("ParliamentBot")

# ─────────────────────────────────────────
# متغيرات البيئة
# ─────────────────────────────────────────
BOT_TOKEN      = os.environ["BOT_TOKEN"]
PASSWORD       = os.getenv("BOT_PASSWORD", "521988")
FIREBASE_URL   = os.environ["FIREBASE_URL"]
FIREBASE_JSON  = os.environ["FIREBASE_CREDENTIALS_JSON"]
FIREBASE_PATH  = os.getenv("FIREBASE_PATH", "parliament-requests")
ARCHIVE_PATH   = "archive"  # مسار قسم المستندات
STORAGE_BUCKET = os.getenv("FIREBASE_STORAGE_BUCKET", "")

# ✅ معرف القناة
CHANNEL_ID     = "-1003882612870" #معرف القناة

# ─────────────────────────────────────────
# حالات المحادثة
# ─────────────────────────────────────────
(
    WAIT_PASSWORD, MAIN_MENU, SEARCH_QUERY,
    EDIT_VALUE, ADD_TITLE, ADD_TYPE, ADD_AUTH, ADD_DETAILS, ADD_CONFIRM,
    UPLOAD_WAIT, VIEW_ARCHIVE_DOCS, UPLOAD_REQ_ID, UPLOAD_FILE,
) = range(13)

# ─────────────────────────────────────────
# Firebase
# ─────────────────────────────────────────
def init_firebase() -> None:
    if firebase_admin._apps:
        return
    try:
        cred_data = json.loads(FIREBASE_JSON)
        cred = credentials.Certificate(cred_data)
        opts = {"databaseURL": FIREBASE_URL}
        if STORAGE_BUCKET:
            opts["storageBucket"] = STORAGE_BUCKET
        firebase_admin.initialize_app(cred, opts)
        logger.info("✅ Firebase initialized")
    except Exception as e:
        logger.critical(f"❌ Firebase init failed: {e}")
        raise


def get_all() -> list:
    try:
        data = db.reference(FIREBASE_PATH).get()
        if not data:
            logger.warning(f"⚠️ No data at: '{FIREBASE_PATH}'")
            return []
        if isinstance(data, dict):
            return [{"firebaseKey": k, **v} for k, v in data.items() if isinstance(v, dict)]
        return []
    except Exception as e:
        logger.error(f"get_all error: {e}")
        return []


def get_req(key: str):
    try:
        return db.reference(f"{FIREBASE_PATH}/{key}").get()
    except Exception as e:
        logger.error(f"get_req error: {e}")
        return None


def update_req(key: str, field: str, value) -> bool:
    try:
        db.reference(f"{FIREBASE_PATH}/{key}").update({field: value})
        return True
    except Exception as e:
        logger.error(f"update_req error: {e}")
        return False


def delete_req(key: str) -> bool:
    try:
        db.reference(f"{FIREBASE_PATH}/{key}").delete()
        return True
    except Exception as e:
        logger.error(f"delete_req error: {e}")
        return False


def add_req(data: dict) -> bool:
    try:
        db.reference(FIREBASE_PATH).push(data)
        return True
    except Exception as e:
        logger.error(f"add_req error: {e}")
        return False


def add_document_to_req(key: str, doc_info: dict) -> bool:
    """إضافة مستند لقائمة مستندات الطلب"""
    try:
        ref  = db.reference(f"{FIREBASE_PATH}/{key}")
        data = ref.get() or {}
        docs = data.get("documents", [])
        if not isinstance(docs, list):
            docs = list(docs.values()) if isinstance(docs, dict) else []
        docs.append(doc_info)
        ref.update({"documents": docs, "hasDocuments": True})
        return True
    except Exception as e:
        logger.error(f"add_document error: {e}")
        return False


def add_document_to_archive(req_id: str, doc_info: dict) -> bool:
    """إضافة مستند لقسم archive بناءً على رقم الطلب"""
    try:
        req_index = int(req_id)
        archive_ref = db.reference(ARCHIVE_PATH)
        
        # جلب البيانات الحالية
        archive_data = archive_ref.get() or []
        if isinstance(archive_data, dict):
            archive_data = list(archive_data.values())
        
        # التأكد من أن القائمة كبيرة بما يكفي
        while len(archive_data) <= req_index:
            archive_data.append(None)
        
        # إنشاء مفتاح فريد للمستند
        doc_key = archive_ref.child(str(req_index)).push().key
        
        # إضافة المستند
        if archive_data[req_index] is None:
            archive_data[req_index] = {}
        
        archive_data[req_index][doc_key] = doc_info
        
        # حفظ البيانات
        archive_ref.set(archive_data)
        logger.info(f"✅ تم حفظ المستند في archive للطلب {req_id}")
        return True
    except Exception as e:
        logger.error(f"add_document_to_archive error: {e}")
        return False


def get_archive_docs(req_id: str) -> list:
    """
    جلب جميع المستندات المرتبطة برقم طلب معين من قسم archive
    البنية: archive -> [index] -> {document_key: {file_info}}
    ملاحظة: الفهرس = reqId (الطلب يأخذ نفس رقمه كفهرس في القائمة)
    """
    try:
        archive_data = db.reference(ARCHIVE_PATH).get()
        if not archive_data:
            logger.warning(f"⚠️ No archive data found")
            return []
        
        # تحويل البيانات إلى قائمة
        if isinstance(archive_data, list):
            archive_list = archive_data
        else:
            archive_list = list(archive_data.values()) if isinstance(archive_data, dict) else []
        
        # تحويل req_id إلى index
        try:
            req_index = int(req_id)
        except (ValueError, TypeError):
            logger.error(f"Invalid req_id: {req_id}")
            return []
        
        # التحقق من أن الفهرس ضمن النطاق
        if req_index < 0 or req_index >= len(archive_list):
            logger.warning(f"req_index {req_index} out of range (max: {len(archive_list)-1})")
            return []
        
        # جلب المستندات في هذا الفهرس
        req_docs = archive_list[req_index]
        
        # إذا كان None، لا توجد مستندات
        if req_docs is None:
            return []
        
        if not isinstance(req_docs, dict):
            logger.warning(f"req_docs at index {req_index} is not a dict")
            return []
        
        # تحويل المستندات إلى قائمة مع الحفاظ على المعلومات
        docs = []
        for doc_key, doc_info in req_docs.items():
            if isinstance(doc_info, dict):
                docs.append({
                    "doc_key": doc_key,
                    **doc_info
                })
        
        logger.info(f"✅ Found {len(docs)} documents for req_id {req_id}")
        return docs
    except Exception as e:
        logger.error(f"get_archive_docs error: {e}")
        return []


# ─────────────────────────────────────────
# ثوابت العرض
# ─────────────────────────────────────────
MONTHS_AR = [
    "يناير","فبراير","مارس","أبريل","مايو","يونيو",
    "يوليو","أغسطس","سبتمبر","أكتوبر","نوفمبر","ديسمبر"
]

STATUS = {
    "execution": "⏳ قيد التنفيذ",
    "completed": "✅ مكتمل",
    "replied":   "📩 تم الرد",
    "rejected":  "❌ مرفوض",
}

REQ_TYPE = {
    "special":  "🟣 طلب خاص",
    "general":  "🔵 طلب عام",
    "briefing": "🟠 طلب إحاطة",
    "urgent":   "🔴 بيان عاجل",
}

FILE_TYPE_ICONS = {
    "document": "📄",
    "photo": "📷",
    "video": "🎥",
    "audio": "🎵",
}


def fmt_date(s: str) -> str:
    if not s:
        return "غير محدد"
    try:
        d = datetime.strptime(str(s)[:10], "%Y-%m-%d")
        return f"{d.day} {MONTHS_AR[d.month - 1]} {d.year}"
    except Exception:
        return str(s)


def format_req(r: dict, short: bool = False) -> str:
    s     = STATUS.get(r.get("status", ""), r.get("status", "غير محدد"))
    rtype = REQ_TYPE.get(r.get("requestType", ""), r.get("requestType", "غير محدد"))
    has_docs = "📎 نعم" if r.get("hasDocuments") else "لا"
    lines = [
        f"📌 *رقم الطلب:* {r.get('reqId', '—')}",
        f"🗂️ *النوع:* {rtype}",
        f"📝 *العنوان:* {r.get('title', '—')}",
        f"🏛️ *الجهة:* {r.get('authority', '—')}",
        f"📅 *التاريخ:* {fmt_date(r.get('reqDate', ''))}",
        f"🔖 *الحالة:* {s}",
        f"📎 *مستندات:* {has_docs}",
    ]
    if not short and r.get("details"):
        lines.append(f"\n📄 *التفاصيل:*\n{r['details'][:800]}")
    return "\n".join(lines)


def build_stats() -> str:
    reqs  = get_all()
    total = len(reqs)
    by_status: dict = {}
    by_type:   dict = {}
    for r in reqs:
        st = r.get("status", "?")
        rt = r.get("requestType", "?")
        by_status[st] = by_status.get(st, 0) + 1
        by_type[rt]   = by_type.get(rt, 0) + 1

    lines = [
        "📊 *إحصائيات الطلبات*\n",
        f"🔢 الإجمالي: *{total} طلب*\n",
        "*📋 حسب الحالة:*",
    ]
    for k, v in by_status.items():
        pct = round(v / total * 100) if total else 0
        lines.append(f"  {STATUS.get(k, k)}: *{v}* ({pct}%)")
    lines.append("\n*🗂️ حسب النوع:*")
    for k, v in by_type.items():
        pct = round(v / total * 100) if total else 0
        lines.append(f"  {REQ_TYPE.get(k, k)}: *{v}* ({pct}%)")
    return "\n".join(lines)


# ─────────────────────────────────────────
# لوحات المفاتيح
# ─────────────────────────────────────────
def main_kb() -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup([
        [
            InlineKeyboardButton("🔍 بحث",        callback_data="search"),
            InlineKeyboardButton("📊 إحصائيات",   callback_data="stats"),
        ],
        [
            InlineKeyboardButton("📋 كل الطلبات", callback_data="list_all"),
            InlineKeyboardButton("🔽 فلترة",       callback_data="filter"),
        ],
        [
            InlineKeyboardButton("➕ إضافة طلب",  callback_data="add"),
        ],
    ])


def req_kb(key: str) -> InlineKeyboardMarkup:
    """لوحة مفاتيح الطلب الواحد — مع زر عرض مستندات Archive"""
    return InlineKeyboardMarkup([
        [
            InlineKeyboardButton("📄 عرض الطلب كامل",   callback_data=f"view_full:{key}"),
            InlineKeyboardButton("📎 المستندات",        callback_data=f"view_archive:{key}"),
        ],
        [
            InlineKeyboardButton("✏️ تعديل الحالة",     callback_data=f"edit_status:{key}"),
            InlineKeyboardButton("✏️ تعديل العنوان",    callback_data=f"edit_title:{key}"),
        ],
        [
            InlineKeyboardButton("📤 رفع مستند",        callback_data=f"upload_doc:{key}"),
            InlineKeyboardButton("🗑️ حذف",              callback_data=f"delete:{key}"),
        ],
        [
            InlineKeyboardButton("📢 رفع على القناة",   callback_data=f"send_to_channel:{key}"),
        ],
    ])


def type_kb(prefix: str) -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup([
        [InlineKeyboardButton("🟣 طلب خاص",   callback_data=f"{prefix}special")],
        [InlineKeyboardButton("🔵 طلب عام",   callback_data=f"{prefix}general")],
        [InlineKeyboardButton("🟠 طلب إحاطة", callback_data=f"{prefix}briefing")],
        [InlineKeyboardButton("🔴 بيان عاجل", callback_data=f"{prefix}urgent")],
    ])


def status_kb() -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup([
        [InlineKeyboardButton("⏳ قيد التنفيذ", callback_data="set_status:execution")],
        [InlineKeyboardButton("✅ مكتمل",       callback_data="set_status:completed")],
        [InlineKeyboardButton("📩 تم الرد",     callback_data="set_status:replied")],
        [InlineKeyboardButton("❌ مرفوض",       callback_data="set_status:rejected")],
    ])


# ─────────────────────────────────────────
# دوال المساعدة
# ─────────────────────────────────────────
async def send(update, text: str, markup=None, edit: bool = False) -> None:
    if edit and update.callback_query:
        await update.callback_query.edit_message_text(
            text, parse_mode=ParseMode.MARKDOWN, reply_markup=markup)
    else:
        await update.message.reply_text(
            text, parse_mode=ParseMode.MARKDOWN, reply_markup=markup)


def check_auth(ctx, user_id) -> bool:
    return ctx.user_data.get("auth", False)


# ─────────────────────────────────────────
# الأوامر الأساسية
# ─────────────────────────────────────────
async def cmd_start(update, ctx) -> int:
    user_id = update.effective_user.id
    if not check_auth(ctx, user_id):
        await update.message.reply_text(
            "🔐 أهلاً وسهلاً!\n\nالرجاء إدخال كلمة المرور للوصول:",
            reply_markup=InlineKeyboardMarkup([]))
        return WAIT_PASSWORD
    await update.message.reply_text(
        "🏠 *القائمة الرئيسية*", reply_markup=main_kb())
    return MAIN_MENU


async def check_password(update, ctx) -> int:
    if update.message.text.strip() == PASSWORD:
        ctx.user_data["auth"] = True
        await update.message.reply_text(
            "✅ تم التحقق بنجاح!\n\n🏠 *القائمة الرئيسية*",
            parse_mode=ParseMode.MARKDOWN, reply_markup=main_kb())
        return MAIN_MENU
    await update.message.reply_text("❌ كلمة المرور خاطئة. حاول مجدداً:")
    return WAIT_PASSWORD


async def cmd_logout(update, ctx) -> int:
    ctx.user_data["auth"] = False
    await update.message.reply_text("🚪 تم تسجيل الخروج بنجاح.")
    return WAIT_PASSWORD


async def cmd_stats(update, ctx) -> int:
    if not check_auth(ctx, update.effective_user.id):
        await update.message.reply_text("🔐 أرسل /start لتسجيل الدخول.")
        return WAIT_PASSWORD
    await update.message.reply_text(
        build_stats(), parse_mode=ParseMode.MARKDOWN, reply_markup=main_kb())
    return MAIN_MENU


async def cmd_help(update, ctx) -> int:
    help_text = """
🤖 *مساعدة البوت*

*الأوامر الرئيسية:*
/start — القائمة الرئيسية
/stats — إحصائيات الطلبات
/upload — رفع مستند
/logout — تسجيل الخروج

*الميزات:*
📋 عرض جميع الطلبات
🔍 البحث عن طلب
📊 إحصائيات شاملة
➕ إضافة طلب جديد
✏️ تعديل البيانات
📤 رفع المستندات
📢 رفع على قناة تليجرام

*هل تحتاج مساعدة إضافية؟*
تواصل مع المسؤول 👤
"""
    await update.message.reply_text(help_text, parse_mode=ParseMode.MARKDOWN)
    return -1


async def cmd_upload(update, ctx) -> int:
    if not check_auth(ctx, update.effective_user.id):
        await update.message.reply_text("🔐 أرسل /start لتسجيل الدخول.")
        return WAIT_PASSWORD
    await update.message.reply_text(
        "📌 أدخل *رقم الطلب* المراد رفع مستند له:",
        parse_mode=ParseMode.MARKDOWN)
    return UPLOAD_REQ_ID


# ─────────────────────────────────────────
# معالجة إدخال رقم الطلب لرفع مستند
# ─────────────────────────────────────────
async def handle_upload_req_id(update, ctx) -> int:
    if not check_auth(ctx, update.effective_user.id):
        await update.message.reply_text("🔐 أرسل /start لتسجيل الدخول.")
        return WAIT_PASSWORD
    
    req_id = update.message.text.strip()
    reqs = get_all()
    req = next((r for r in reqs if r.get("reqId") == req_id), None)
    
    if not req:
        await update.message.reply_text(
            f"❌ الطلب رقم *{req_id}* غير موجود.\n\nحاول مرة أخرى أو أرسل /start للعودة.",
            parse_mode=ParseMode.MARKDOWN)
        return UPLOAD_REQ_ID
    
    ctx.user_data["upload_req_id"] = req_id
    ctx.user_data["upload_req_key"] = req.get("firebaseKey")
    
    await update.message.reply_text(
        f"✅ تم التحقق من الطلب رقم *{req_id}*\n\n"
        f"📝 *العنوان:* {req.get('title')}\n"
        f"🏛️ *الجهة:* {req.get('authority')}\n\n"
        f"📤 الآن أرسل الملف أو الصورة (PDF، صورة، فيديو، إلخ)\n\n"
        f"أو اكتب /cancel للإلغاء",
        parse_mode=ParseMode.MARKDOWN)
    return UPLOAD_FILE


# ─────────────────────────────────────────
# معالجة رفع المستندات
# ─────────────────────────────────────────
async def handle_upload_file(update, ctx) -> int:
    """معالجة رفع الملف للطلب المحدد"""
    if not check_auth(ctx, update.effective_user.id):
        await update.message.reply_text("🔐 أرسل /start لتسجيل الدخول.")
        return WAIT_PASSWORD
    
    # التحقق من الإلغاء
    if update.message.text and update.message.text.lower() == "/cancel":
        await update.message.reply_text("❌ تم الإلغاء.", reply_markup=main_kb())
        ctx.user_data.pop("upload_req_id", None)
        ctx.user_data.pop("upload_req_key", None)
        return MAIN_MENU
    
    # استخراج بيانات الملف
    doc_info = {}
    file_id = None
    file_name = "بدون اسم"
    file_type = "document"
    
    if update.message.document:
        file_id = update.message.document.file_id
        file_name = update.message.document.file_name or file_name
        file_type = "document"
    elif update.message.photo:
        file_id = update.message.photo[-1].file_id
        file_name = f"صورة_{datetime.now().strftime('%Y%m%d_%H%M%S')}"
        file_type = "photo"
    elif update.message.video:
        file_id = update.message.video.file_id
        file_name = update.message.video.file_name or "فيديو"
        file_type = "video"
    elif update.message.audio:
        file_id = update.message.audio.file_id
        file_name = update.message.audio.file_name or "صوت"
        file_type = "audio"
    elif update.message.text:
        # في حالة إرسال نص بدلاً من ملف
        await update.message.reply_text(
            "❌ يرجى إرسال ملف، صورة، أو فيديو.\n\nأو اكتب /cancel للإلغاء")
        return UPLOAD_FILE
    else:
        await update.message.reply_text(
            "❌ نوع الملف غير مدعوم.\n\nيرجى إرسال: PDF، صورة، فيديو، أو صوت\n\nأو اكتب /cancel للإلغاء")
        return UPLOAD_FILE
    
    # إنشاء معلومات المستند
    doc_info = {
        "file_id": file_id,
        "file_name": file_name,
        "file_type": file_type,
        "caption": update.message.caption or "",
        "uploadedAt": datetime.now().isoformat(),
    }
    
    req_key = ctx.user_data.get("upload_req_key")
    req_id = ctx.user_data.get("upload_req_id")
    req = get_req(req_key)
    
    # إضافة المستند لقاعدة البيانات (في parliament-requests)
    if not add_document_to_req(req_key, doc_info):
        await update.message.reply_text(
            "❌ فشل رفع المستند. حاول مرة أخرى.",
            reply_markup=main_kb())
        ctx.user_data.pop("upload_req_id", None)
        ctx.user_data.pop("upload_req_key", None)
        return MAIN_MENU
    
    # إضافة المستند أيضاً في archive
    try:
        add_document_to_archive(req_id, doc_info)
    except Exception as e:
        logger.warning(f"⚠️ فشل حفظ المستند في archive: {e}")
    
    # إرسال المستند للقناة
    channel_sent = False
    if CHANNEL_ID:
        try:
            header_text = (
                f"📌 *مستند جديد*\n\n"
                f"📎 *الملف:* {file_name}\n"
                f"🔤 *النوع:* {file_type}\n"
                f"📋 *الطلب:* #{req_id}\n"
                f"📝 *العنوان:* {req.get('title', '—')}\n"
                f"🏛️ *الجهة:* {req.get('authority', '—')}\n"
                f"👤 *تم الرفع بواسطة:* {update.effective_user.first_name}\n"
                f"⏰ *التاريخ:* {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}"
            )
            
            # إرسال الملف للقناة
            if file_type == "photo":
                await ctx.bot.send_photo(
                    chat_id=CHANNEL_ID,
                    photo=file_id,
                    caption=header_text,
                    parse_mode=ParseMode.MARKDOWN
                )
            elif file_type == "document":
                await ctx.bot.send_document(
                    chat_id=CHANNEL_ID,
                    document=file_id,
                    caption=header_text,
                    parse_mode=ParseMode.MARKDOWN
                )
            elif file_type == "video":
                await ctx.bot.send_video(
                    chat_id=CHANNEL_ID,
                    video=file_id,
                    caption=header_text,
                    parse_mode=ParseMode.MARKDOWN
                )
            elif file_type == "audio":
                await ctx.bot.send_audio(
                    chat_id=CHANNEL_ID,
                    audio=file_id,
                    caption=header_text,
                    parse_mode=ParseMode.MARKDOWN
                )
            logger.info(f"✅ تم إرسال المستند '{file_name}' للقناة")
            channel_sent = True
        except Exception as e:
            logger.error(f"❌ فشل إرسال الملف للقناة: {e}")
    
    # إرسال رسالة النجاح المناسبة
    if channel_sent:
        msg = f"✅ تم رفع المستند *'{file_name}'* للطلب رقم *{req_id}* بنجاح!\n\n📎 تم حفظ البيانات في قاعدة البيانات\n📢 تم إرسال المستند للقناة"
    elif CHANNEL_ID:
        msg = f"⚠️ تم حفظ المستند *'{file_name}'* في قاعدة البيانات للطلب رقم *{req_id}*\n\n❌ لكن فشل إرساله للقناة. تحقق من معرف القناة والصلاحيات."
    else:
        msg = f"✅ تم حفظ المستند *'{file_name}'* في قاعدة البيانات للطلب رقم *{req_id}* بنجاح!\n\n⚠️ لم يتم تعيين معرف القناة، لذا لم يتم إرسال المستند للقناة."
    
    await update.message.reply_text(msg, parse_mode=ParseMode.MARKDOWN, reply_markup=main_kb())
    
    # تنظيف البيانات
    ctx.user_data.pop("upload_req_id", None)
    ctx.user_data.pop("upload_req_key", None)
    
    return MAIN_MENU


async def handle_upload(update, ctx) -> int:
    if not check_auth(ctx, update.effective_user.id):
        await update.message.reply_text("🔐 أرسل /start لتسجيل الدخول.")
        return WAIT_PASSWORD
    
    upload_mode = ctx.user_data.get("upload_mode", "")
    
    # إذا كانت الرسالة إلغاء
    if update.message and update.message.text == "/cancel":
        await update.message.reply_text("❌ تم الإلغاء.", reply_markup=main_kb())
        return MAIN_MENU
    
    # الانتظار لرقم الطلب
    if upload_mode == "wait_req_id":
        req_id = update.message.text.strip()
        reqs = get_all()
        req = next((r for r in reqs if r.get("reqId") == req_id), None)
        if not req:
            await update.message.reply_text(f"❌ الطلب رقم {req_id} غير موجود.")
            return UPLOAD_WAIT
        ctx.user_data["upload_req_id"] = req_id
        ctx.user_data["upload_req_key"] = req.get("firebaseKey")
        ctx.user_data["upload_mode"] = "wait_file"
        await update.message.reply_text(
            f"📤 أرسل الآن الملف أو الصورة (أو أرسل /cancel للإلغاء)")
        return UPLOAD_WAIT
    
    # الانتظار للملف
    if upload_mode == "wait_file":
        doc_info = {}
        file_id = None
        file_name = "بدون اسم"
        file_type = "document"
        
        if update.message.document:
            file_id = update.message.document.file_id
            file_name = update.message.document.file_name or file_name
            file_type = "document"
        elif update.message.photo:
            file_id = update.message.photo[-1].file_id
            file_name = f"صورة_{datetime.now().strftime('%Y%m%d_%H%M%S')}"
            file_type = "photo"
        elif update.message.video:
            file_id = update.message.video.file_id
            file_name = update.message.video.file_name or "فيديو"
            file_type = "video"
        elif update.message.audio:
            file_id = update.message.audio.file_id
            file_name = update.message.audio.file_name or "صوت"
            file_type = "audio"
        else:
            await update.message.reply_text("❌ نوع الملف غير مدعوم.")
            return UPLOAD_WAIT
        
        doc_info = {
            "file_id": file_id,
            "file_name": file_name,
            "file_type": file_type,
            "caption": update.message.caption or "",
            "uploadedAt": datetime.now().isoformat(),
        }
        
        req_key = ctx.user_data.get("upload_req_key")
        req_id = ctx.user_data.get("upload_req_id")
        
        if add_document_to_req(req_key, doc_info):
            msg = f"✅ تم رفع المستند '{file_name}' للطلب رقم {req_id} بنجاح."
        else:
            msg = "❌ فشل رفع المستند."
        
        await update.message.reply_text(msg, reply_markup=main_kb())
        ctx.user_data.pop("upload_mode", None)
        ctx.user_data.pop("upload_req_id", None)
        ctx.user_data.pop("upload_req_key", None)
        return MAIN_MENU
    
    await update.message.reply_text("❌ حدث خطأ ما.", reply_markup=main_kb())
    return MAIN_MENU


# ─────────────────────────────────────────
# معالجة رفع المستندات على القناة
# ─────────────────────────────────────────
async def send_docs_to_channel(update, ctx, req_id: str, req_key: str):
    """رفع جميع مستندات الطلب على قناة تليجرام"""
    if not CHANNEL_ID:
        await update.callback_query.answer("❌ لم يتم تعيين معرف القناة", show_alert=True)
        return
    
    docs = get_archive_docs(req_id)
    if not docs:
        await update.callback_query.answer("ℹ️ لا توجد مستندات لهذا الطلب", show_alert=True)
        return
    
    try:
        # إرسال رسالة البداية
        req = get_req(req_key)
        header_text = (
            f"📌 *مستندات الطلب رقم {req_id}*\n\n"
            f"📝 *العنوان:* {req.get('title', '—')}\n"
            f"🏛️ *الجهة:* {req.get('authority', '—')}\n"
            f"📅 *التاريخ:* {fmt_date(req.get('reqDate', ''))}\n\n"
            f"📎 *المستندات:* ({len(docs)})\n"
            f"{'─' * 40}"
        )
        
        await ctx.bot.send_message(
            chat_id=CHANNEL_ID,
            text=header_text,
            parse_mode=ParseMode.MARKDOWN
        )
        
        # إرسال كل مستند
        for i, doc in enumerate(docs, 1):
            file_id = doc.get("file_id")
            file_name = doc.get("file_name", "مستند")
            file_type = doc.get("file_type", "document")
            caption = doc.get("caption", "")
            uploaded_at = doc.get("uploadedAt", "")
            
            # صياغة التسمية التوضيحية
            doc_caption = (
                f"*{i}. {file_name}*\n"
                f"📁 النوع: {file_type}\n"
                f"⏰ التاريخ: {uploaded_at[:10]}\n"
                f"{caption if caption else ''}"
            )
            
            try:
                if file_type == "photo":
                    await ctx.bot.send_photo(
                        chat_id=CHANNEL_ID,
                        photo=file_id,
                        caption=doc_caption,
                        parse_mode=ParseMode.MARKDOWN
                    )
                elif file_type == "document":
                    await ctx.bot.send_document(
                        chat_id=CHANNEL_ID,
                        document=file_id,
                        caption=doc_caption,
                        parse_mode=ParseMode.MARKDOWN
                    )
                elif file_type == "video":
                    await ctx.bot.send_video(
                        chat_id=CHANNEL_ID,
                        video=file_id,
                        caption=doc_caption,
                        parse_mode=ParseMode.MARKDOWN
                    )
                elif file_type == "audio":
                    await ctx.bot.send_audio(
                        chat_id=CHANNEL_ID,
                        audio=file_id,
                        caption=doc_caption,
                        parse_mode=ParseMode.MARKDOWN
                    )
            except Exception as e:
                logger.error(f"Error sending document {i}: {e}")
                continue
        
        await update.callback_query.answer("✅ تم رفع جميع المستندات على القناة", show_alert=True)
        
    except Exception as e:
        logger.error(f"send_docs_to_channel error: {e}")
        await update.callback_query.answer("❌ فشل رفع المستندات", show_alert=True)


# ─────────────────────────────────────────
# معالجة استدعاءات الزرار
# ─────────────────────────────────────────
async def main_cb(update, ctx) -> int:
    q = update.callback_query
    await q.answer()
    action = q.data
    
    if action == "search":
        await q.message.reply_text("🔍 أدخل *كلمة البحث*:", parse_mode=ParseMode.MARKDOWN)
        return SEARCH_QUERY
    
    if action == "stats":
        await send(update, build_stats(), main_kb(), edit=True)
        return MAIN_MENU
    
    if action == "list_all":
        reqs = get_all()
        if not reqs:
            await send(update, "📋 لا توجد طلبات.", main_kb(), edit=True)
            return MAIN_MENU
        await send(update, f"📋 إجمالي الطلبات: *{len(reqs)}*", edit=True)
        for r in reqs[:15]:
            await q.message.reply_text(
                format_req(r, short=True),
                parse_mode=ParseMode.MARKDOWN,
                reply_markup=req_kb(r["firebaseKey"]))
        await q.message.reply_text("🏠", reply_markup=main_kb())
        return MAIN_MENU
    
    if action == "filter":
        await send(update, "🔽 اختر معيار الفلترة:", InlineKeyboardMarkup([
            [InlineKeyboardButton("🔖 حسب الحالة", callback_data="filter_status")],
            [InlineKeyboardButton("🗂️ حسب النوع", callback_data="filter_type")],
        ]), edit=True)
        return MAIN_MENU
    
    if action == "add":
        ctx.user_data["new_req"] = {}
        await q.message.reply_text("📝 أدخل *عنوان* الطلب:", parse_mode=ParseMode.MARKDOWN)
        return ADD_TITLE
    
    # معالجة التعديلات
    if action.startswith("edit_"):
        parts = action.split(":")
        field_type = parts[0].replace("edit_", "")
        key = parts[1] if len(parts) > 1 else None
        
        if not key:
            await q.answer("❌ خطأ", show_alert=True)
            return MAIN_MENU
        
        ctx.user_data["edit_key"] = key
        
        if field_type == "status":
            await send(update, "✏️ اختر *الحالة* الجديدة:", status_kb(), edit=True)
            return MAIN_MENU
        elif field_type == "title":
            ctx.user_data["edit_field"] = "title"
            await send(update, "✏️ أدخل *العنوان* الجديد:", edit=True)
            return EDIT_VALUE
    
    # معالجة تعيين الحالة
    if action.startswith("set_status:"):
        status = action.split(":")[1]
        key = ctx.user_data.get("edit_key")
        if key and update_req(key, "status", status):
            await send(update, "✅ تم تحديث الحالة.", main_kb(), edit=True)
        else:
            await q.answer("❌ فشل التحديث", show_alert=True)
        return MAIN_MENU
    
    # عرض مستندات archive
    if action.startswith("view_archive:"):
        key = action.split(":")[1]
        req = get_req(key)
        req_id = req.get("reqId") if req else "؟"
        
        docs = get_archive_docs(req_id)
        if not docs:
            await q.answer("ℹ️ لا توجد مستندات مخزنة", show_alert=False)
            return MAIN_MENU
        
        # عرض قائمة المستندات مع أزرار لفتح كل واحد
        buttons = []
        for i, doc in enumerate(docs, 1):
            doc_name = doc.get('file_name', 'بدون اسم')
            file_type = doc.get('file_type', 'document')
            icon = FILE_TYPE_ICONS.get(file_type, '📄')
            buttons.append([
                InlineKeyboardButton(
                    f"{icon} {i}. {doc_name[:30]}",
                    callback_data=f"open_doc:{key}:{i-1}"
                )
            ])
        
        # إضافة أزرار التحكم
        buttons.append([
            InlineKeyboardButton("📢 رفع على القناة", callback_data=f"send_to_channel:{key}"),
            InlineKeyboardButton("🔙 عودة", callback_data="home"),
        ])
        
        await send(update,
            f"📎 *مستندات الطلب رقم {req_id}* ({len(docs)})\n\n"
            f"اضغط على أي مستند لعرضه:",
            InlineKeyboardMarkup(buttons),
            edit=True
        )
        return MAIN_MENU
    
    # فتح وعرض مستند معين
    if action.startswith("open_doc:"):
        parts = action.split(":")
        key = parts[1]
        doc_index = int(parts[2]) if len(parts) > 2 else 0
        
        req = get_req(key)
        req_id = req.get("reqId") if req else "؟"
        
        docs = get_archive_docs(req_id)
        if not docs or doc_index >= len(docs):
            await q.answer("❌ المستند غير متاح", show_alert=True)
            return MAIN_MENU
        
        doc = docs[doc_index]
        file_id = doc.get("file_id")
        file_name = doc.get("file_name", "مستند")
        file_type = doc.get("file_type", "document")
        caption = doc.get("caption", "")
        uploaded_at = doc.get("uploadedAt", "")
        
        # بناء التسمية التوضيحية
        doc_caption = (
            f"*{file_name}*\n\n"
            f"📁 النوع: {file_type}\n"
            f"⏰ التاريخ: {uploaded_at[:10]}\n"
            f"📌 الطلب: {req_id}"
        )
        if caption:
            doc_caption += f"\n📝 ملاحظة: {caption}"
        
        # إنشاء أزرار التنقل
        nav_buttons = []
        if doc_index > 0:
            nav_buttons.append(InlineKeyboardButton("⬅️ السابق", callback_data=f"open_doc:{key}:{doc_index-1}"))
        
        nav_buttons.append(InlineKeyboardButton(f"{doc_index+1}/{len(docs)}", callback_data="noop"))
        
        if doc_index < len(docs) - 1:
            nav_buttons.append(InlineKeyboardButton("التالي ➡️", callback_data=f"open_doc:{key}:{doc_index+1}"))
        
        try:
            if file_type == "photo":
                await q.message.reply_photo(
                    photo=file_id,
                    caption=doc_caption,
                    parse_mode=ParseMode.MARKDOWN,
                    reply_markup=InlineKeyboardMarkup([
                        nav_buttons,
                        [InlineKeyboardButton("🔙 عودة للمستندات", callback_data=f"view_archive:{key}")]
                    ])
                )
            elif file_type == "document":
                await q.message.reply_document(
                    document=file_id,
                    caption=doc_caption,
                    parse_mode=ParseMode.MARKDOWN,
                    reply_markup=InlineKeyboardMarkup([
                        nav_buttons,
                        [InlineKeyboardButton("🔙 عودة للمستندات", callback_data=f"view_archive:{key}")]
                    ])
                )
            elif file_type == "video":
                await q.message.reply_video(
                    video=file_id,
                    caption=doc_caption,
                    parse_mode=ParseMode.MARKDOWN,
                    reply_markup=InlineKeyboardMarkup([
                        nav_buttons,
                        [InlineKeyboardButton("🔙 عودة للمستندات", callback_data=f"view_archive:{key}")]
                    ])
                )
            elif file_type == "audio":
                await q.message.reply_audio(
                    audio=file_id,
                    caption=doc_caption,
                    parse_mode=ParseMode.MARKDOWN,
                    reply_markup=InlineKeyboardMarkup([
                        nav_buttons,
                        [InlineKeyboardButton("🔙 عودة للمستندات", callback_data=f"view_archive:{key}")]
                    ])
                )
            else:
                await q.message.reply_text(
                    f"❌ نوع الملف '{file_type}' غير مدعوم للعرض المباشر\n\n{doc_caption}",
                    parse_mode=ParseMode.MARKDOWN,
                    reply_markup=InlineKeyboardMarkup([
                        [InlineKeyboardButton("🔙 عودة للمستندات", callback_data=f"view_archive:{key}")]
                    ])
                )
            
            await q.answer()
        except Exception as e:
            logger.error(f"Error opening document: {e}")
            await q.answer("❌ فشل فتح المستند", show_alert=True)
        
        return MAIN_MENU
    
    # رفع على القناة
    if action.startswith("send_to_channel:"):
        key = action.split(":")[1]
        req = get_req(key)
        req_id = req.get("reqId") if req else "؟"
        await send_docs_to_channel(update, ctx, req_id, key)
        return MAIN_MENU
    
    # حذف
    if action.startswith("delete:"):
        key = action.split(":")[1]
        if delete_req(key):
            await send(update, "🗑️ تم حذف الطلب.", main_kb(), edit=True)
        else:
            await q.answer("❌ فشل الحذف", show_alert=True)
        return MAIN_MENU
    
    # زر بدون فعل (لعرض الرقم فقط)
    if action == "noop":
        await q.answer()
        return MAIN_MENU
    
    # الحد الأدنى من المعالجة الأخرى
    if action == "home":
        await send(update, "🏠 *القائمة الرئيسية*", main_kb(), edit=True)
        return MAIN_MENU
    
    return MAIN_MENU


async def do_search(update, ctx) -> int:
    q     = update.message.text.strip().lower()
    reqs  = get_all()
    found = [
        r for r in reqs
        if q in " ".join(filter(None, [
            str(r.get("reqId", "")),
            r.get("title", ""),
            r.get("authority", ""),
            r.get("details", ""),
            r.get("status", ""),
        ])).lower()
    ]
    if not found:
        await update.message.reply_text(
            f"🔍 لا توجد نتائج لـ *{q}*",
            parse_mode=ParseMode.MARKDOWN, reply_markup=main_kb())
        return MAIN_MENU
    await update.message.reply_text(
        f"🔍 وُجد *{len(found)}* نتيجة:", parse_mode=ParseMode.MARKDOWN)
    for r in found[:10]:
        await update.message.reply_text(
            format_req(r, short=True),
            parse_mode=ParseMode.MARKDOWN,
            reply_markup=req_kb(r["firebaseKey"]))
    await update.message.reply_text("🏠", reply_markup=main_kb())
    return MAIN_MENU


async def do_edit_value(update, ctx) -> int:
    key   = ctx.user_data.get("edit_key")
    field = ctx.user_data.get("edit_field", "title")
    if key:
        ok  = update_req(key, field, update.message.text.strip())
        msg = "✅ تم التحديث بنجاح." if ok else "❌ فشل التحديث."
        await update.message.reply_text(msg, reply_markup=main_kb())
    ctx.user_data.pop("edit_key", None)
    ctx.user_data.pop("edit_field", None)
    return MAIN_MENU


# ─────────────────────────────────────────
# إضافة طلب
# ─────────────────────────────────────────
async def add_title(update, ctx) -> int:
    ctx.user_data["new_req"]["title"] = update.message.text.strip()
    await update.message.reply_text(
        "🗂️ اختر *نوع* الطلب:",
        parse_mode=ParseMode.MARKDOWN, reply_markup=type_kb("add_type:"))
    return ADD_TYPE


async def add_type_cb(update, ctx) -> int:
    q = update.callback_query
    await q.answer()
    ctx.user_data["new_req"]["requestType"] = q.data.split(":")[1]
    await q.message.reply_text("🏛️ أدخل *الجهة* المعنية:", parse_mode=ParseMode.MARKDOWN)
    return ADD_AUTH


async def add_auth(update, ctx) -> int:
    ctx.user_data["new_req"]["authority"] = update.message.text.strip()
    await update.message.reply_text(
        "📄 أدخل *التفاصيل* (أو أرسل `-` للتخطي):",
        parse_mode=ParseMode.MARKDOWN)
    return ADD_DETAILS


async def add_details(update, ctx) -> int:
    val = update.message.text.strip()
    ctx.user_data["new_req"]["details"] = "" if val == "-" else val
    req = ctx.user_data["new_req"]
    summary = (
        f"📋 *ملخص الطلب الجديد:*\n\n"
        f"📝 *العنوان:* {req.get('title')}\n"
        f"🗂️ *النوع:* {REQ_TYPE.get(req.get('requestType',''),'—')}\n"
        f"🏛️ *الجهة:* {req.get('authority')}\n"
        f"📄 *التفاصيل:* {req.get('details','—')[:200]}\n\n"
        "هل تريد الحفظ؟"
    )
    await update.message.reply_text(
        summary, parse_mode=ParseMode.MARKDOWN,
        reply_markup=InlineKeyboardMarkup([
            [InlineKeyboardButton("✅ حفظ",  callback_data="confirm_add"),
             InlineKeyboardButton("❌ إلغاء", callback_data="home")],
        ]))
    return ADD_CONFIRM


async def confirm_add(update, ctx) -> int:
    q = update.callback_query
    await q.answer()
    if q.data == "confirm_add":
        reqs   = get_all()
        max_id = max((int(r.get("reqId", "0") or 0) for r in reqs), default=0)
        req    = ctx.user_data.get("new_req", {})
        req.update({
            "reqId":        str(max_id + 1),
            "status":       "execution",
            "reqDate":      datetime.now().strftime("%Y-%m-%d"),
            "hasDocuments": False,
            "documents":    [],
            "createdBy":    update.effective_user.id,
        })
        ok  = add_req(req)
        msg = f"✅ تم إضافة الطلب رقم *{req['reqId']}* بنجاح." if ok else "❌ فشل الحفظ."
        await send(update, msg, main_kb(), edit=True)
    else:
        await send(update, "🏠 *القائمة الرئيسية*", main_kb(), edit=True)
    ctx.user_data.pop("new_req", None)
    return MAIN_MENU


async def fallback(update, ctx) -> int:
    if not check_auth(ctx, update.effective_user.id):
        await send(update, "🔐 أرسل /start لتسجيل الدخول.")
        return WAIT_PASSWORD
    await send(update, "🏠 *القائمة الرئيسية*", main_kb())
    return MAIN_MENU


# ─────────────────────────────────────────
# تسجيل أوامر البوت
# ─────────────────────────────────────────
# ─────────────────────────────────────────
# إيقاف أي بوت آخر يعمل بنفس التوكن
# ─────────────────────────────────────────
async def kick_other_bots() -> None:
    """
    يحذف الـ webhook ثم يُرسل getUpdates متكرر لإزاحة
    أي نسخة أخرى تعمل بنفس التوكن (polling conflict).
    """
    base_url = f"https://api.telegram.org/bot{BOT_TOKEN}"

    async with aiohttp.ClientSession() as session:

        # 1) حذف الـ webhook إن وُجد
        logger.info("🔍 فحص webhook...")
        async with session.post(f"{base_url}/getWebhookInfo") as r:
            info = await r.json()
        if info.get("result", {}).get("url"):
            logger.warning("⚠️ يوجد webhook نشط، جاري الحذف...")
            async with session.post(
                f"{base_url}/deleteWebhook",
                json={"drop_pending_updates": False}
            ) as r:
                res = await r.json()
            if res.get("result"):
                logger.info("✅ تم حذف الـ webhook")
        else:
            logger.info("✅ لا يوجد webhook")

        # 2) إزاحة أي polling آخر عبر إرسال getUpdates متكرر
        logger.info("🔄 إيقاف أي بوت آخر يعمل بنفس التوكن...")
        for attempt in range(1, 6):
            async with session.post(
                f"{base_url}/getUpdates",
                json={"offset": -1, "timeout": 0}
            ) as r:
                res = await r.json()

            if res.get("ok"):
                logger.info(f"✅ تم الاستيلاء على الجلسة (محاولة {attempt})")
                break

            desc = res.get("description", "")
            if "Conflict" in desc:
                logger.warning(f"⏳ يوجد بوت آخر نشط (محاولة {attempt}/5)، انتظار 3 ثوانٍ...")
                await asyncio.sleep(3)
            else:
                logger.warning(f"⚠️ محاولة {attempt}: {desc or 'خطأ غير معروف'}")
                await asyncio.sleep(2)
        else:
            logger.warning("⚠️ لم نتمكن من إيقاف البوت الآخر، سنبدأ على أي حال...")

        # انتظار قصير للتأكد من انتهاء الجلسة القديمة
        await asyncio.sleep(1)
        logger.info("🚀 جاهز للبدء")



    await application.bot.set_my_commands([
        BotCommand("start",  "🏠 القائمة الرئيسية"),
        BotCommand("stats",  "📊 إحصائيات الطلبات"),
        BotCommand("upload", "📤 رفع مستند لطلب"),
        BotCommand("logout", "🚪 تسجيل الخروج"),
        BotCommand("help",   "📖 المساعدة"),
    ])
    logger.info("✅ Bot commands registered")


# ─────────────────────────────────────────
# main
# ─────────────────────────────────────────
def main() -> None:
    port = int(os.environ.get("PORT", 10000))

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b"OK")
        def log_message(self, *_):
            pass

    def run_web():
        with socketserver.TCPServer(("", port), Handler) as s:
            s.serve_forever()

    Thread(target=run_web, daemon=True).start()
    logger.info(f"🌐 Health-check server on port {port}")

    init_firebase()

    # ✅ إيقاف أي بوت آخر يعمل بنفس التوكن قبل البدء
    asyncio.run(kick_other_bots())

    app = (
        Application.builder()
        .token(BOT_TOKEN)
        .post_init(post_init)
        .build()
    )

    # فلتر الملفات لحالة UPLOAD_WAIT
    file_filter = (
        filters.Document.ALL |
        filters.PHOTO |
        filters.VIDEO |
        filters.AUDIO
    )

    conv = ConversationHandler(
        entry_points=[
            CommandHandler("start",  cmd_start),
            CommandHandler("stats",  cmd_stats),
            CommandHandler("logout", cmd_logout),
            CommandHandler("upload", cmd_upload),
            CommandHandler("help",   cmd_help),
        ],
        states={
            WAIT_PASSWORD: [
                MessageHandler(filters.TEXT & ~filters.COMMAND, check_password)
            ],
            MAIN_MENU: [
                CallbackQueryHandler(main_cb),
                MessageHandler(filters.TEXT & ~filters.COMMAND, fallback),
            ],
            SEARCH_QUERY: [
                MessageHandler(filters.TEXT & ~filters.COMMAND, do_search)
            ],
            EDIT_VALUE: [
                MessageHandler(filters.TEXT & ~filters.COMMAND, do_edit_value)
            ],
            ADD_TITLE: [
                MessageHandler(filters.TEXT & ~filters.COMMAND, add_title)
            ],
            ADD_TYPE: [
                CallbackQueryHandler(add_type_cb, pattern="^add_type:")
            ],
            ADD_AUTH: [
                MessageHandler(filters.TEXT & ~filters.COMMAND, add_auth)
            ],
            ADD_DETAILS: [
                MessageHandler(filters.TEXT & ~filters.COMMAND, add_details)
            ],
            ADD_CONFIRM: [
                CallbackQueryHandler(confirm_add, pattern="^(confirm_add|home)$")
            ],
            UPLOAD_WAIT: [
                MessageHandler(file_filter, handle_upload),
                MessageHandler(filters.TEXT & ~filters.COMMAND, handle_upload),
                CommandHandler("cancel", handle_upload),
            ],
            UPLOAD_REQ_ID: [
                MessageHandler(filters.TEXT & ~filters.COMMAND, handle_upload_req_id),
                CommandHandler("cancel", cmd_start),
            ],
            UPLOAD_FILE: [
                MessageHandler(file_filter, handle_upload_file),
                MessageHandler(filters.TEXT & ~filters.COMMAND, handle_upload_file),
                CommandHandler("cancel", handle_upload_file),
            ],
        },
        fallbacks=[
            CommandHandler("start",  cmd_start),
            CommandHandler("logout", cmd_logout),
            CommandHandler("upload", cmd_upload),
            MessageHandler(filters.TEXT & ~filters.COMMAND, fallback),
        ],
        allow_reentry=True,
        name="main_conv",
    )

    app.add_handler(conv)
    app.add_handler(CommandHandler("help", cmd_help))

    logger.info("🚀 Bot started — polling for updates...")
    app.run_polling(
        drop_pending_updates=True,
        allowed_updates=["message", "callback_query"],
    )


if __name__ == "__main__":
    main()
