"""
أداة تشخيص - لمعرفة المسار الصحيح في Firebase
شغّل هذا الملف مرة واحدة فقط لرؤية بنية قاعدة البيانات
"""
import os, json
import firebase_admin
from firebase_admin import credentials, db

FIREBASE_URL  = os.environ["FIREBASE_URL"]
FIREBASE_JSON = os.environ["FIREBASE_CREDENTIALS_JSON"]

cred = credentials.Certificate(json.loads(FIREBASE_JSON))
firebase_admin.initialize_app(cred, {"databaseURL": FIREBASE_URL})

root = db.reference("/").get()

if root is None:
    print("❌ قاعدة البيانات فارغة تماماً!")
else:
    print("✅ المسارات الموجودة في قاعدة البيانات:")
    for key in root.keys():
        val = root[key]
        if isinstance(val, dict):
            count = len(val)
            sample_key = next(iter(val))
            sample_fields = list(val[sample_key].keys()) if isinstance(val[sample_key], dict) else []
            print(f"\n  📁 '{key}': {count} عنصر")
            print(f"     مثال على الحقول: {sample_fields}")
        else:
            print(f"  📄 '{key}': {type(val).__name__}")

print("\n⚙️  ضع اسم المسار الصحيح في متغير FIREBASE_PATH")
