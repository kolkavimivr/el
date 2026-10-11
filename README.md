# שרת שלוחות - תורנויות
משתני סביבה ברנדר:
- GITHUB_TOKEN - טוקן עם Contents קריאה+כתיבה לריפו הנתונים בלבד
- DATA_REPO - למשל kolkavimivr/el-data
- IVR_SECRET - מחרוזת סודית לכתובת השלוחות
- TEACHER_PASS - סיסמת המורה (ברירת מחדל 12369)
- YEMOT_TOKEN, CRON_KEY, CALLER_ID (אופציונלי), TZ_TIMEOUT (אופציונלי) - לצינתוק היומי

שלוחת תלמידה: https://<השירות>.onrender.com/ivr/<IVR_SECRET>
שלוחת מורה: https://<השירות>.onrender.com/ivr/<IVR_SECRET>/teacher
