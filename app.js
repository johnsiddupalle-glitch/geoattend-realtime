let S = {
  token: localStorage.token || null,
  user: JSON.parse(localStorage.user || "null"),
  role: localStorage.role || "Admin",
  page: "dashboard",
  otpEmail: ""
};

const $ = (x) => document.getElementById(x);

async function api(url, opt = {}) {
  opt.headers = {
    ...(opt.headers || {}),
    ...(S.token ? { Authorization: "Bearer " + S.token } : {})
  };

  if (opt.body && typeof opt.body !== "string") {
    opt.headers["Content-Type"] = "application/json";
    opt.body = JSON.stringify(opt.body);
  }

  const r = await fetch(url, opt);
  const text = await r.text();

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { error: text };
  }

  if (!r.ok) throw new Error(data.error || "Request failed");
  return data;
}

function toast(message) {
  alert(message);
}

function login() {
  document.body.innerHTML = `
    <div class="login">
      <div class="box">
        <div class="brand">GeoAttend</div>
        <p class="muted">Real-time QR Attendance + Geofencing</p>

        <div class="roles">
          <button class="${S.role === "Admin" ? "active" : ""}"
            onclick="S.role='Admin'; login()">Admin</button>

          <button class="${S.role === "Faculty" ? "active" : ""}"
            onclick="S.role='Faculty'; login()">Faculty</button>
        </div>

        <label>Email</label>
        <input
          id="email"
          type="email"
          placeholder="Enter your email"
          autocomplete="email"
        />

        <button class="primary" onclick="sendOtp()">
          Send OTP
        </button>

        <p class="muted">
          Demo mode OTP: <b>123456</b>
        </p>
      </div>
    </div>
  `;
}

async function sendOtp() {
  const email = $("email").value.trim();

  if (!email) {
    toast("Please enter your email");
    return;
  }

  try {
    await api("/api/auth/send-otp", {
      method: "POST",
      body: {
        email,
        role: S.role
      }
    });

    S.otpEmail = email;

    document.querySelector(".box").innerHTML = `
      <div class="brand">GeoAttend</div>
      <p class="muted">
        OTP sent to <b>${email}</b>
      </p>

      <label>Enter OTP</label>
      <input
        id="otp"
        type="text"
        maxlength="6"
        placeholder="Enter 6-digit OTP"
        autocomplete="one-time-code"
      />

      <button class="primary" onclick="verifyOtp()">
        Verify OTP
      </button>

      <button class="secondary" onclick="login()">
        Change Email
      </button>

      <p class="muted">
        Demo mode OTP: <b>123456</b>
      </p>
    `;
  } catch (e) {
    toast(e.message);
  }
}

async function verifyOtp() {
  const otp = $("otp").value.trim();

  if (!otp) {
    toast("Please enter OTP");
    return;
  }

  try {
    const data = await api("/api/auth/verify-otp", {
      method: "POST",
      body: {
        email: S.otpEmail,
        role: S.role,
        otp
      }
    });

    S.token = data.token;
    S.user = data.user;
    S.role = data.user.role;

    localStorage.token = S.token;
    localStorage.user = JSON.stringify(S.user);
    localStorage.role = S.role;

    render();
  } catch (e) {
    toast(e.message);
  }
}

function logout() {
  localStorage.clear();

  S = {
    token: null,
    user: null,
    role: "Admin",
    page: "dashboard",
    otpEmail: ""
  };

  login();
}

function nav(page) {
  S.page = page;
  render();
}

async function render() {
  if (!S.token || !S.user) {
    login();
    return;
  }

  document.body.innerHTML = `
    <header class="top">
      <div class="brand">GeoAttend</div>

      <div class="user">
        <span>${S.user.name || S.user.email}</span>
        <span class="badge">${S.user.role}</span>
        <button onclick="logout()">Logout</button>
      </div>
    </header>

    <div class="layout">

      <aside class="sidebar">
        <button onclick="nav('dashboard')">Dashboard</button>
        <button onclick="nav('attendance')">Attendance</button>

        ${
          S.user.role === "Admin"
            ? `<button onclick="nav('users')">Students & Faculty</button>`
            : ""
        }

        ${
          ["Admin", "Faculty"].includes(S.user.role)
            ? `<button onclick="nav('session')">Create QR Session</button>`
            : ""
        }
      </aside>

      <main class="content" id="main"></main>
    </div>
  `;

  page();
}

async function page() {
  const main = $("main");

  if (S.page === "dashboard") {
    main.innerHTML = `
      <h1>Welcome, ${S.user.name || "User"} 👋</h1>

      <div class="cards">
        <div class="card">
          <h3>Role</h3>
          <strong>${S.user.role}</strong>
        </div>

        <div class="card">
          <h3>Email</h3>
          <strong>${S.user.email}</strong>
        </div>

        <div class="card">
          <h3>System</h3>
          <strong>QR + Geofencing</strong>
        </div>
      </div>
    `;
    return;
  }

  if (S.page === "attendance") {
    try {
      const rows = await api("/api/attendance");

      main.innerHTML = `
        <h1>Attendance</h1>

        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Student</th>
                <th>Course</th>
                <th>Distance</th>
                <th>Date & Time</th>
              </tr>
            </thead>

            <tbody>
              ${
                rows.map(r => `
                  <tr>
                    <td>${r.name || "-"}</td>
                    <td>${r.course || "-"}</td>
                    <td>${r.distance ? r.distance + " m" : "-"}</td>
                    <td>${r.created_at || "-"}</td>
                  </tr>
                `).join("")
              }
            </tbody>
          </table>
        </div>
      `;
    } catch (e) {
      main.innerHTML = `<div class="card">${e.message}</div>`;
    }

    return;
  }

  if (S.page === "users") {
    await usersPage();
    return;
  }

  if (S.page === "session") {
    sessionPage();
    return;
  }
}

async function usersPage() {
  const main = $("main");

  try {
    const users = await api("/api/users");

    main.innerHTML = `
      <h1>Students & Faculty</h1>

      <button class="primary" onclick="addUser()">
        + Add User
      </button>

      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Email</th>
              <th>Role</th>
              <th>Action</th>
            </tr>
          </thead>

          <tbody>
            ${
              users.map(u => `
                <tr>
                  <td>${u.name}</td>
                  <td>${u.email}</td>
                  <td>${u.role}</td>
                  <td>
                    ${
                      u.role !== "Admin"
                        ? `<button onclick="delUser(${u.id})">Delete</button>`
                        : ""
                    }
                  </td>
                </tr>
              `).join("")
            }
          </tbody>
        </table>
      </div>
    `;
  } catch (e) {
    main.innerHTML = `<div class="card">${e.message}</div>`;
  }
}

async function addUser() {
  const name = prompt("Name");
  if (!name) return;

  const email = prompt("Email");
  if (!email) return;

  const role = prompt("Role: Student or Faculty", "Student");
  if (!role) return;

  try {
    await api("/api/users", {
      method: "POST",
      body: {
        name,
        email,
        role
      }
    });

    toast("User added successfully");
    usersPage();
  } catch (e) {
    toast(e.message);
  }
}

async function delUser(id) {
  if (!confirm("Delete this user?")) return;

  try {
    await api("/api/users/" + id, {
      method: "DELETE"
    });

    toast("User deleted");
    usersPage();
  } catch (e) {
    toast(e.message);
  }
}

function sessionPage() {
  $("main").innerHTML = `
    <h1>Create QR Session</h1>

    <div class="card">
      <label>Course / Class Name</label>

      <input
        id="course"
        placeholder="Example: CSE-A Data Structures"
      />

      <button class="primary" onclick="startSession()">
        Start QR Session
      </button>
    </div>
  `;
}

async function startSession() {
  const course = $("course").value.trim();

  if (!course) {
    toast("Enter course name");
    return;
  }

  if (!navigator.geolocation) {
    toast("Geolocation is not supported");
    return;
  }

  navigator.geolocation.getCurrentPosition(
    async pos => {
      try {
        const lat = pos.coords.latitude;
        const lng = pos.coords.longitude;

        const data = await api("/api/sessions", {
          method: "POST",
          body: {
            course,
            lat,
            lng,
            radius: 100
          }
        });

        $("main").innerHTML = `
          <h1>QR Session Active</h1>

          <div class="card center">
            <h2>${course}</h2>

            <div class="qr">
              <img
                src="${data.qr || data.qrCode || ""}"
                alt="QR Code"
              />
            </div>

            <p>
              Students can scan this QR code
              inside the geofence.
            </p>

            <button class="secondary"
              onclick="stopSession(${data.id})">
              Stop Session
            </button>
          </div>
        `;
      } catch (e) {
        toast(e.message);
      }
    },
    () => toast("Please allow location access")
  );
}

async function stopSession(id) {
  try {
    await api("/api/sessions/" + id + "/stop", {
      method: "POST"
    });

    toast("Session stopped");
    nav("dashboard");
  } catch (e) {
    toast(e.message);
  }
}

render();
