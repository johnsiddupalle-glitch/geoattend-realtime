const express = require("express");
const path = require("path");
const Database = require("better-sqlite3");
const jwt = require("jsonwebtoken");
const QRCode = require("qrcode");

const app = express();
const PORT = process.env.PORT || 3000;
const SECRET = process.env.JWT_SECRET || "change-this-secret";

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(__dirname));

const db = new Database(path.join(__dirname, "data.sqlite"));

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  role TEXT NOT NULL,
  course TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token TEXT UNIQUE NOT NULL,
  course TEXT,
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  radius REAL DEFAULT 100,
  expires INTEGER NOT NULL,
  active INTEGER DEFAULT 1,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS attendance (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  lat REAL,
  lng REAL,
  distance REAL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(session_id, user_id)
);
`);

const count = db.prepare("SELECT COUNT(*) AS c FROM users").get().c;

if (count === 0) {
  const insert = db.prepare(
    "INSERT INTO users (name,email,role,course) VALUES (?,?,?,?)"
  );

  insert.run(
    "Admin User",
    "admin@geoattend.demo",
    "Admin",
    "Administration"
  );

  insert.run(
    "Dr. Priya",
    "faculty@geoattend.demo",
    "Faculty",
    "CSE"
  );

  insert.run(
    "Rahul Kumar",
    "student@geoattend.demo",
    "Student",
    "CSE"
  );
}

const otpStore = new Map();

function auth(req, res, next) {
  try {
    const header = req.headers.authorization || "";
    const token = header.replace("Bearer ", "");

    if (!token) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    req.user = jwt.verify(token, SECRET);
    next();
  } catch (error) {
    return res.status(401).json({ error: "Unauthorized" });
  }
}

function distanceMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000;

  const p1 = Number(lat1) * Math.PI / 180;
  const p2 = Number(lat2) * Math.PI / 180;

  const dp = (Number(lat2) - Number(lat1)) * Math.PI / 180;
  const dl = (Number(lng2) - Number(lng1)) * Math.PI / 180;

  const a =
    Math.sin(dp / 2) ** 2 +
    Math.cos(p1) *
      Math.cos(p2) *
      Math.sin(dl / 2) ** 2;

  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/* ---------- OTP ---------- */

app.post("/api/auth/send-otp", (req, res) => {
  const { email, role } = req.body || {};

  if (!email || !role) {
    return res
      .status(400)
      .json({ error: "Email and role are required" });
  }

  const user = db
    .prepare("SELECT id,name,email,role,course FROM users WHERE email = ?")
    .get(email);

  if (!user || user.role.toLowerCase() !== String(role).toLowerCase()) {
    return res.status(401).json({
      error: "User not found or role mismatch"
    });
  }

  const otp =
    process.env.OTP_MODE === "production"
      ? String(Math.floor(100000 + Math.random() * 900000))
      : "123456";

  otpStore.set(email, {
    otp,
    expires: Date.now() + 5 * 60 * 1000
  });

  console.log(`OTP for ${email}: ${otp}`);

  return res.json({
    success: true,
    message: "OTP sent successfully",
    demoOtp: process.env.OTP_MODE === "production" ? undefined : otp
  });
});

app.post("/api/auth/verify-otp", (req, res) => {
  const { email, otp } = req.body || {};

  const saved = otpStore.get(email);

  if (
    !saved ||
    saved.otp !== String(otp) ||
    Date.now() > saved.expires
  ) {
    return res.status(401).json({
      error: "Invalid or expired OTP"
    });
  }

  const user = db
    .prepare("SELECT id,name,email,role,course FROM users WHERE email = ?")
    .get(email);

  otpStore.delete(email);

  const token = jwt.sign(
    {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      course: user.course
    },
    SECRET,
    { expiresIn: "8h" }
  );

  return res.json({
    success: true,
    token,
    user
  });
});

/* ---------- Users ---------- */

app.get("/api/users", auth, (req, res) => {
  if (req.user.role !== "Admin") {
    return res.status(403).json({ error: "Admin only" });
  }

  const users = db
    .prepare(
      "SELECT id,name,email,role,course FROM users ORDER BY id DESC"
    )
    .all();

  res.json(users);
});

app.post("/api/users", auth, (req, res) => {
  if (req.user.role !== "Admin") {
    return res.status(403).json({ error: "Admin only" });
  }

  const { name, email, role, course } = req.body || {};

  if (!name || !email || !role) {
    return res.status(400).json({
      error: "Name, email and role are required"
    });
  }

  try {
    const result = db
      .prepare(
        "INSERT INTO users (name,email,role,course) VALUES (?,?,?,?)"
      )
      .run(name, email, role, course || "");

    res.json({
      success: true,
      id: result.lastInsertRowid
    });
  } catch (error) {
    res.status(400).json({
      error: "Email already exists"
    });
  }
});

app.delete("/api/users/:id", auth, (req, res) => {
  if (req.user.role !== "Admin") {
    return res.status(403).json({ error: "Admin only" });
  }

  db.prepare("DELETE FROM users WHERE id = ? AND role != 'Admin'")
    .run(req.params.id);

  res.json({ success: true });
});

/* ---------- QR Sessions ---------- */

app.post("/api/sessions", auth, (req, res) => {
  if (!["Admin", "Faculty"].includes(req.user.role)) {
    return res.status(403).json({
      error: "Faculty/Admin only"
    });
  }

  const {
    course,
    lat,
    lng,
    radius = 100
  } = req.body || {};

  if (
    !course ||
    lat === undefined ||
    lng === undefined
  ) {
    return res.status(400).json({
      error: "Course and location are required"
    });
  }

  const token =
    Date.now().toString(36) +
    Math.random().toString(36).slice(2);

  const expires = Date.now() + 10 * 60 * 1000;

  const result = db
    .prepare(
      `INSERT INTO sessions
      (token,course,lat,lng,radius,expires,active)
      VALUES (?,?,?,?,?,?,1)`
    )
    .run(
      token,
      course,
      Number(lat),
      Number(lng),
      Number(radius),
      expires
    );

  res.json({
    success: true,
    sessionId: result.lastInsertRowid,
    token,
    expires
  });
});

app.get("/api/sessions/active", auth, (req, res) => {
  const sessions = db
    .prepare(
      `SELECT id,course,lat,lng,radius,expires,created_at
       FROM sessions
       WHERE active = 1
       ORDER BY id DESC`
    )
    .all();

  res.json(sessions);
});

app.get("/api/sessions/:id/qr", auth, async (req, res) => {
  const session = db
    .prepare(
      "SELECT id,token,expires,active FROM sessions WHERE id = ?"
    )
    .get(req.params.id);

  if (!session) {
    return res.status(404).json({
      error: "Session not found"
    });
  }

  if (!session.active || Date.now() > session.expires) {
    return res.status(410).json({
      error: "QR expired"
    });
  }

  const qrData = JSON.stringify({
    sessionId: session.id,
    token: session.token
  });

  const qr = await QRCode.toDataURL(qrData);

  res.json({
    success: true,
    qr
  });
});

/* ---------- Attendance ---------- */

app.post("/api/attendance", auth, (req, res) => {
  if (req.user.role !== "Student") {
    return res.status(403).json({
      error: "Students only"
    });
  }

  const {
    sessionId,
    token,
    lat,
    lng
  } = req.body || {};

  const session = db
    .prepare(
      `SELECT *
       FROM sessions
       WHERE id = ? AND token = ? AND active = 1`
    )
    .get(sessionId, token);

  if (!session) {
    return res.status(404).json({
      error: "Invalid QR session"
    });
  }

  if (Date.now() > session.expires) {
    return res.status(410).json({
      error: "QR session expired"
    });
  }

  if (lat === undefined || lng === undefined) {
    return res.status(400).json({
      error: "Location permission is required"
    });
  }

  const distance = distanceMeters(
    session.lat,
    session.lng,
    Number(lat),
    Number(lng)
  );

  if (distance > session.radius) {
    return res.status(403).json({
      error: "You are outside the allowed geofence",
      distance: Math.round(distance),
      allowedRadius: session.radius
    });
  }

  try {
    db.prepare(
      `INSERT INTO attendance
       (session_id,user_id,lat,lng,distance)
       VALUES (?,?,?,?,?)`
    ).run(
      session.id,
      req.user.id,
      Number(lat),
      Number(lng),
      distance
    );

    res.json({
      success: true,
      message: "Attendance marked successfully",
      distance: Math.round(distance)
    });
  } catch (error) {
    res.status(409).json({
      error: "Attendance already marked"
    });
  }
});

/* ---------- Attendance Records ---------- */

app.get("/api/attendance", auth, (req, res) => {
  if (!["Admin", "Faculty"].includes(req.user.role)) {
    return res.status(403).json({
      error: "Faculty/Admin only"
    });
  }

  const records = db
    .prepare(
      `SELECT
        a.id,
        u.name,
        u.email,
        u.course,
        s.course AS session_course,
        a.distance,
        a.created_at
       FROM attendance a
       JOIN users u ON u.id = a.user_id
       JOIN sessions s ON s.id = a.session_id
       ORDER BY a.id DESC`
    )
    .all();

  res.json(records);
});

/* ---------- Stop Session ---------- */

app.post("/api/sessions/:id/stop", auth, (req, res) => {
  if (!["Admin", "Faculty"].includes(req.user.role)) {
    return res.status(403).json({
      error: "Not allowed"
    });
  }

  db.prepare(
    "UPDATE sessions SET active = 0 WHERE id = ?"
  ).run(req.params.id);

  res.json({
    success: true
  });
});

/* ---------- Frontend ---------- */

app.get(/.*/, (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.listen(PORT, () => {
  console.log(`GeoAttend running on port ${PORT}`);
});
