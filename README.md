# GeoAttend - Python Backend

QR Attendance + Geofencing using Flask, SQLite and Python QR generation.

## Demo accounts
- Admin: `admin@geoattend.demo`
- Faculty: `faculty@example.com`
- Student: `student@example.com`

In demo mode, clicking **Send OTP** displays the OTP on screen. No SMTP is required.

## Run locally
```bash
pip install -r requirements.txt
python server.py
```
Open http://localhost:10000

## Render
Use the included `render.yaml`. Build: `pip install -r requirements.txt`; start: `gunicorn server:app --bind 0.0.0.0:$PORT --workers 1 --timeout 120`.

## Optional email OTP
Set `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`. Set `SHOW_DEMO_OTP=false` after email is configured.

## Features
- Admin and Faculty OTP login
- Admin can add/delete students and faculty
- Faculty/Admin can create QR sessions
- QR contains a session URL
- Student scan page does not require login
- Student location is checked against session geofence
- Duplicate attendance is blocked
- Faculty sees only their sessions/attendance
- SQLite database
