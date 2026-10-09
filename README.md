# מערכת תורנויות

משתני סביבה ברנדר:
- DATABASE_URL - כתובת ה-Postgres (Internal Database URL)
- ADMIN_PASSWORD - סיסמת כניסה לדף הניהול
- IVR_SECRET - מחרוזת סודית לכתובת השלוחה
- ALLOWED_ORIGIN - (אופציונלי) כתובת האתר שבו יושב דף הניהול

כתובת השלוחה בימות המשיח (שלוחת API): https://<שם-השירות>.onrender.com/ivr/<IVR_SECRET>
בנייה: npm install | הפעלה: npm start
