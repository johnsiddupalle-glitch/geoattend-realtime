import os, sqlite3, math, secrets, smtplib, ssl
from datetime import datetime, timezone, timedelta
from email.message import EmailMessage
from functools import wraps
from io import BytesIO
import base64

from flask import Flask, request, jsonify, send_from_directory
import qrcode

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(BASE_DIR, "data")
DB_PATH = os.path.join(DATA_DIR, "geoattend.db")
os.makedirs(DATA_DIR, exist_ok=True)

app = Flask(__name__, static_folder="public", static_url_path="")
app.config["JSON_SORT_KEYS"] = False

TOKENS = {}
OTPS = {}
OTP_TTL_SECONDS = 300


def now_iso():
    return datetime.now(timezone.utc).isoformat()


def db():
    con = sqlite3.connect(DB_PATH)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA foreign_keys = ON")
    return con


def init_db():
    con = db()
    con.executescript("""
    CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        email TEXT NOT NULL UNIQUE COLLATE NOCASE,
        role TEXT NOT NULL CHECK(role IN ('Admin','Faculty','Student')),
        student_id TEXT
    );
    CREATE TABLE IF NOT EXISTS sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        course TEXT NOT NULL,
        faculty_id INTEGER NOT NULL,
        faculty_name TEXT NOT NULL,
        lat REAL NOT NULL,
        lng REAL NOT NULL,
        radius REAL NOT NULL,
        active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        ended_at TEXT,
        FOREIGN KEY(faculty_id) REFERENCES users(id)
    );
    CREATE TABLE IF NOT EXISTS attendance (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id INTEGER NOT NULL,
        student_id INTEGER NOT NULL,
        student_name TEXT NOT NULL,
        student_email TEXT NOT NULL,
        distance INTEGER NOT NULL,
        marked_at TEXT NOT NULL,
        UNIQUE(session_id, student_id),
        FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE,
        FOREIGN KEY(student_id) REFERENCES users(id) ON DELETE CASCADE
    );
    """)
    seeds = [
        ("Admin User", "admin@geoattend.demo", "Admin", None),
        ("Dr. Priya", "faculty@example.com", "Faculty", None),
        ("John Student", "student@example.com", "Student", "STU001"),
    ]
    for name, email, role, sid in seeds:
        con.execute("INSERT OR IGNORE INTO users(name,email,role,student_id) VALUES(?,?,?,?)", (name,email,role,sid))
    con.commit()
    con.close()


def row_user(row):
    return dict(row) if row else None


def user_public(row):
    if not row:
        return None
    return {"id": row["id"], "name": row["name"], "email": row["email"], "role": row["role"], "studentId": row["student_id"]}


def session_public(row):
    return {
        "id": row["id"], "course": row["course"], "facultyId": row["faculty_id"],
        "facultyName": row["faculty_name"], "lat": row["lat"], "lng": row["lng"],
        "radius": row["radius"], "active": bool(row["active"]),
        "createdAt": row["created_at"], "endedAt": row["ended_at"]
    }


def attendance_public(row, include_session=False):
    d = {
        "id": row["id"], "sessionId": row["session_id"], "studentId": row["student_id"],
        "studentName": row["student_name"], "studentEmail": row["student_email"],
        "distance": row["distance"], "markedAt": row["marked_at"]
    }
    if include_session:
        d["session"] = {
            "id": row["sid"], "course": row["course"], "facultyId": row["faculty_id"],
            "facultyName": row["faculty_name"]
        } if row["sid"] is not None else None
    return d


def auth_required(fn):
    @wraps(fn)
    def wrapper(*args, **kwargs):
        header = request.headers.get("Authorization", "")
        token = header[7:] if header.startswith("Bearer ") else ""
        info = TOKENS.get(token)
        if not info:
            return jsonify(error="Please login again"), 401
        con = db()
        u = con.execute("SELECT * FROM users WHERE id=?", (info["user_id"],)).fetchone()
        con.close()
        if not u:
            return jsonify(error="User not found"), 401
        request.current_user = u
        request.current_token = token
        return fn(*args, **kwargs)
    return wrapper


def roles(*allowed):
    def deco(fn):
        @wraps(fn)
        @auth_required
        def wrapper(*args, **kwargs):
            if request.current_user["role"] not in allowed:
                return jsonify(error="Permission denied"), 403
            return fn(*args, **kwargs)
        return wrapper
    return deco


def haversine(lat1, lon1, lat2, lon2):
    R = 6371000.0
    p = math.pi / 180.0
    a = math.sin((lat2-lat1)*p/2)**2 + math.cos(lat1*p)*math.cos(lat2*p)*math.sin((lon2-lon1)*p/2)**2
    return R * 2 * math.atan2(math.sqrt(a), math.sqrt(max(0.0, 1-a)))


def make_qr(data):
    img = qrcode.make(data)
    buf = BytesIO()
    img.save(buf, format="PNG")
    return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode("ascii")


def send_otp_email(to, code, role):
    host = os.getenv("SMTP_HOST")
    user = os.getenv("SMTP_USER")
    password = os.getenv("SMTP_PASS")
    if not host or not user or not password:
        print(f"[DEMO OTP] {to} ({role}) => {code}", flush=True)
        return False
    port = int(os.getenv("SMTP_PORT", "587"))
    secure = os.getenv("SMTP_SECURE", "false").lower() == "true"
    msg = EmailMessage()
    msg["Subject"] = "GeoAttend Login OTP"
    msg["From"] = os.getenv("SMTP_FROM", user)
    msg["To"] = to
    msg.set_content(f"Your GeoAttend {role} login OTP is {code}. It expires in 5 minutes.")
    if secure:
        with smtplib.SMTP_SSL(host, port, context=ssl.create_default_context()) as smtp:
            smtp.login(user, password)
            smtp.send_message(msg)
    else:
        with smtplib.SMTP(host, port) as smtp:
            smtp.starttls(context=ssl.create_default_context())
            smtp.login(user, password)
            smtp.send_message(msg)
    return True


@app.get("/api/health")
def health():
    return jsonify(ok=True, backend="python", service="GeoAttend")


@app.post("/api/auth/send-otp")
def send_otp():
    body = request.get_json(silent=True) or {}
    email = str(body.get("email", "")).strip().lower()
    role = str(body.get("role", "")).strip()
    if not email or role not in ("Admin", "Faculty"):
        return jsonify(error="Enter a valid email and role"), 400
    con = db()
    u = con.execute("SELECT * FROM users WHERE lower(email)=? AND role=?", (email, role)).fetchone()
    con.close()
    if not u:
        return jsonify(error="User not found or role mismatch"), 404
    code = str(secrets.randbelow(900000) + 100000)
    OTPS[f"{role}:{email}"] = {"code": code, "expires": datetime.now(timezone.utc) + timedelta(seconds=OTP_TTL_SECONDS)}
    try:
        sent = send_otp_email(email, code, role)
    except Exception as exc:
        print("SMTP error:", exc, flush=True)
        return jsonify(error="Could not send OTP. Check SMTP settings."), 500
    response = {"ok": True, "message": "OTP sent to your email" if sent else "Demo OTP generated"}
    # Demo mode intentionally exposes OTP so the deployed demo can be tested without SMTP.
    if not sent or os.getenv("SHOW_DEMO_OTP", "true").lower() == "true":
        response["demoOtp"] = code
    return jsonify(response)


@app.post("/api/auth/verify-otp")
def verify_otp():
    body = request.get_json(silent=True) or {}
    email = str(body.get("email", "")).strip().lower()
    role = str(body.get("role", "")).strip()
    code = str(body.get("otp", "")).strip()
    key = f"{role}:{email}"
    saved = OTPS.get(key)
    if not saved or saved["expires"] < datetime.now(timezone.utc) or saved["code"] != code:
        return jsonify(error="Invalid or expired OTP"), 401
    con = db()
    u = con.execute("SELECT * FROM users WHERE lower(email)=? AND role=?", (email, role)).fetchone()
    con.close()
    if not u:
        return jsonify(error="User not found or role mismatch"), 404
    OTPS.pop(key, None)
    token = secrets.token_urlsafe(48)
    TOKENS[token] = {"user_id": u["id"], "created_at": now_iso()}
    return jsonify(token=token, user=user_public(u))


@app.get("/api/me")
@auth_required
def me():
    return jsonify(user=user_public(request.current_user))


@app.post("/api/auth/logout")
@auth_required
def logout():
    TOKENS.pop(request.current_token, None)
    return jsonify(ok=True)


@app.get("/api/users")
@roles("Admin")
def list_users():
    con = db(); rows = con.execute("SELECT * FROM users ORDER BY role, name").fetchall(); con.close()
    return jsonify([user_public(x) for x in rows])


@app.post("/api/users")
@roles("Admin")
def add_user():
    body = request.get_json(silent=True) or {}
    name = str(body.get("name", "")).strip()
    email = str(body.get("email", "")).strip().lower()
    role = str(body.get("role", "")).strip()
    sid = str(body.get("studentId", "")).strip()
    if not name or not email or role not in ("Student", "Faculty"):
        return jsonify(error="Name, email and valid role are required"), 400
    con = db()
    try:
        existing = con.execute("SELECT id FROM users WHERE lower(email)=?", (email,)).fetchone()
        if existing:
            return jsonify(error="Email already exists"), 409
        if role == "Student" and not sid:
            sid = f"STU{con.execute('SELECT COALESCE(MAX(id),0)+1 FROM users').fetchone()[0]:03d}"
        cur = con.execute("INSERT INTO users(name,email,role,student_id) VALUES(?,?,?,?)", (name,email,role,sid or None))
        con.commit()
        u = con.execute("SELECT * FROM users WHERE id=?", (cur.lastrowid,)).fetchone()
    finally:
        con.close()
    return jsonify(user_public(u)), 201


@app.delete("/api/users/<int:user_id>")
@roles("Admin")
def delete_user(user_id):
    if user_id == request.current_user["id"]:
        return jsonify(error="You cannot delete your own admin account"), 400
    con = db(); u = con.execute("SELECT * FROM users WHERE id=?", (user_id,)).fetchone()
    if not u:
        con.close(); return jsonify(error="User not found"), 404
    con.execute("DELETE FROM users WHERE id=?", (user_id,)); con.commit(); con.close()
    return jsonify(ok=True)


@app.get("/api/attendance")
@auth_required
def attendance():
    con = db()
    sql = """SELECT a.*, s.id sid, s.course, s.faculty_id, s.faculty_name
             FROM attendance a LEFT JOIN sessions s ON s.id=a.session_id"""
    params = ()
    if request.current_user["role"] == "Faculty":
        sql += " WHERE s.faculty_id=?"; params = (request.current_user["id"],)
    sql += " ORDER BY a.id DESC"
    rows = con.execute(sql, params).fetchall(); con.close()
    return jsonify([attendance_public(x, True) for x in rows])


@app.get("/api/sessions")
@auth_required
def sessions():
    con = db()
    if request.current_user["role"] == "Faculty":
        rows = con.execute("SELECT * FROM sessions WHERE faculty_id=? ORDER BY id DESC", (request.current_user["id"],)).fetchall()
    else:
        rows = con.execute("SELECT * FROM sessions ORDER BY id DESC").fetchall()
    con.close()
    return jsonify([session_public(x) for x in rows])


@app.post("/api/sessions")
@roles("Admin", "Faculty")
def create_session():
    body = request.get_json(silent=True) or {}
    course = str(body.get("course", "")).strip()
    try:
        lat = float(body.get("lat")); lng = float(body.get("lng")); radius = float(body.get("radius", 100))
    except (TypeError, ValueError):
        return jsonify(error="Course and valid location are required"), 400
    if not course or not (-90 <= lat <= 90) or not (-180 <= lng <= 180):
        return jsonify(error="Course and valid location are required"), 400
    radius = min(max(radius, 20), 1000)
    con = db()
    con.execute("UPDATE sessions SET active=0, ended_at=? WHERE faculty_id=? AND active=1", (now_iso(), request.current_user["id"]))
    cur = con.execute("""INSERT INTO sessions(course,faculty_id,faculty_name,lat,lng,radius,active,created_at)
                        VALUES(?,?,?,?,?,?,1,?)""", (course, request.current_user["id"], request.current_user["name"], lat,lng,radius,now_iso()))
    con.commit()
    s = con.execute("SELECT * FROM sessions WHERE id=?", (cur.lastrowid,)).fetchone()
    con.close()
    scan_url = f"{request.host_url.rstrip('/')}/?scan={s['id']}"
    qr = make_qr(scan_url)
    out = session_public(s); out.update({"qr": qr, "scanUrl": scan_url})
    return jsonify(out), 201


@app.get("/api/sessions/<int:session_id>")
@auth_required
def get_session(session_id):
    con = db(); s = con.execute("SELECT * FROM sessions WHERE id=?", (session_id,)).fetchone(); con.close()
    if not s: return jsonify(error="Session not found"), 404
    if request.current_user["role"] == "Faculty" and s["faculty_id"] != request.current_user["id"]:
        return jsonify(error="Permission denied"), 403
    return jsonify(session_public(s))


@app.get("/api/public/sessions/<int:session_id>")
def public_session(session_id):
    con = db(); s = con.execute("SELECT * FROM sessions WHERE id=?", (session_id,)).fetchone(); con.close()
    if not s: return jsonify(error="Session not found"), 404
    return jsonify(session_public(s))


@app.post("/api/sessions/<int:session_id>/stop")
@roles("Admin", "Faculty")
def stop_session(session_id):
    con = db(); s = con.execute("SELECT * FROM sessions WHERE id=?", (session_id,)).fetchone()
    if not s: con.close(); return jsonify(error="Session not found"), 404
    if request.current_user["role"] == "Faculty" and s["faculty_id"] != request.current_user["id"]:
        con.close(); return jsonify(error="Permission denied"), 403
    con.execute("UPDATE sessions SET active=0, ended_at=? WHERE id=?", (now_iso(), session_id)); con.commit()
    s = con.execute("SELECT * FROM sessions WHERE id=?", (session_id,)).fetchone(); con.close()
    return jsonify(session_public(s))


@app.post("/api/attendance/mark")
def mark_attendance():
    body = request.get_json(silent=True) or {}
    try:
        session_id = int(body.get("sessionId")); lat = float(body.get("lat")); lng = float(body.get("lng"))
    except (TypeError, ValueError):
        return jsonify(error="Session, student email and location are required"), 400
    email = str(body.get("email", "")).strip().lower()
    if not session_id or not email or not (-90 <= lat <= 90) or not (-180 <= lng <= 180):
        return jsonify(error="Session, student email and location are required"), 400
    con = db()
    s = con.execute("SELECT * FROM sessions WHERE id=?", (session_id,)).fetchone()
    if not s or not s["active"]:
        con.close(); return jsonify(error="This QR session is no longer active"), 400
    st = con.execute("SELECT * FROM users WHERE lower(email)=? AND role='Student'", (email,)).fetchone()
    if not st:
        con.close(); return jsonify(error="Student not found. Ask admin to add you."), 404
    distance = haversine(s["lat"], s["lng"], lat, lng)
    if distance > s["radius"]:
        con.close(); return jsonify(error=f"Outside geofence. You are about {round(distance)}m away; allowed {round(s['radius'])}m."), 403
    duplicate = con.execute("SELECT id FROM attendance WHERE session_id=? AND student_id=?", (session_id, st["id"])).fetchone()
    if duplicate:
        con.close(); return jsonify(error="Attendance already marked for this session"), 409
    marked = now_iso()
    cur = con.execute("""INSERT INTO attendance(session_id,student_id,student_name,student_email,distance,marked_at)
                        VALUES(?,?,?,?,?,?)""", (session_id,st["id"],st["name"],st["email"],round(distance),marked))
    con.commit()
    a = con.execute("SELECT * FROM attendance WHERE id=?", (cur.lastrowid,)).fetchone(); con.close()
    return jsonify(ok=True, message="Attendance marked successfully", attendance=attendance_public(a)), 201


@app.get("/api/session/<int:session_id>/attendance")
@auth_required
def session_attendance(session_id):
    con = db(); s = con.execute("SELECT * FROM sessions WHERE id=?", (session_id,)).fetchone()
    if not s: con.close(); return jsonify(error="Session not found"), 404
    if request.current_user["role"] == "Faculty" and s["faculty_id"] != request.current_user["id"]:
        con.close(); return jsonify(error="Permission denied"), 403
    rows = con.execute("SELECT * FROM attendance WHERE session_id=? ORDER BY id DESC", (session_id,)).fetchall(); con.close()
    return jsonify([attendance_public(x) for x in rows])


@app.route("/", defaults={"path": ""})
@app.route("/<path:path>")
def frontend(path):
    if path.startswith("api/"):
        return jsonify(error="Not found"), 404
    return send_from_directory(app.static_folder, "index.html")


init_db()

if __name__ == "__main__":
    port = int(os.getenv("PORT", "10000"))
    app.run(host="0.0.0.0", port=port, debug=False)
