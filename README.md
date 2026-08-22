# GeoAttend Real-Time Starter

Deployable Node.js + SQLite QR attendance system.

## Demo logins
Admin: admin@geoattend.demo
Faculty: faculty@geoattend.demo
Demo OTP: 123456

## Render
Push this folder to GitHub and create a Render Web Service.
Build: npm install
Start: npm start

## Production OTP
Set OTP_MODE=production and replace the console OTP generation in `/api/auth/send-otp` with Twilio, MSG91, AWS SES, Resend, etc. Never expose provider secrets in frontend.

## Student scan
The backend endpoint `/api/attendance` accepts a QR session token and GPS coordinates and performs server-side distance validation. A production mobile/PWA scanner should parse the QR JSON and call this endpoint.
