// functions/[[catchall]].js
// Cloudflare Pages Function — menangani semua request ke /api/*
// Membutuhkan binding D1 bernama "DB" (lihat wrangler.toml / dashboard Pages > Settings > Functions > D1 bindings)
//
// Skema tabel yang dibutuhkan (jalankan sekali lewat wrangler d1 execute):
//
// CREATE TABLE IF NOT EXISTS wishes (
//   id INTEGER PRIMARY KEY AUTOINCREMENT,
//   name TEXT NOT NULL,
//   attendance TEXT NOT NULL,
//   message TEXT NOT NULL,
//   created_at TEXT NOT NULL DEFAULT (datetime('now'))
// );
//
// CREATE TABLE IF NOT EXISTS guests (
//   code TEXT PRIMARY KEY,      -- contoh: "001", "002", dst (TEXT agar nol di depan tidak hilang)
//   name TEXT NOT NULL,
//   group_name TEXT,
//   created_at TEXT NOT NULL DEFAULT (datetime('now'))
// );
//
// Lihat scripts/import-guests.mjs untuk cara import tamu dari file Excel/CSV ke tabel ini.

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

function badRequest(message) {
  return json({ error: message }, 400);
}

const MAX_NAME = 60;
const MAX_MESSAGE = 500;
const ALLOWED_ATTENDANCE = ["hadir", "tidak", "ragu"];

function sanitize(str) {
  return String(str || "").trim();
}

async function handleGetWishes(env) {
  if (!env.DB) {
    return json({ error: "D1 database belum terhubung (binding 'DB' tidak ditemukan)." }, 500);
  }
  const { results } = await env.DB.prepare(
    "SELECT name, attendance, message, created_at FROM wishes ORDER BY id DESC LIMIT 100"
  ).all();
  return json({ items: results });
}

// ====== Daftar tamu langsung dari Google Spreadsheet (live, tanpa redeploy, tanpa Apps Script) ======
//
// Struktur Sheet (tab bernama sesuai GUEST_SHEET_RANGE, default "Tamu"):
//   Kolom A: Kode   (otomatis diisi Worker ini kalau kosong)
//   Kolom B: Nama   (wajib, kamu isi manual)
//   Kolom C: Grup   (opsional, kamu isi manual)
//   Kolom D: Link   (otomatis diisi Worker ini kalau kosong)
//
// Cara kerja: setiap kali ada yang membuka website ini (atau endpoint /api/guest/:code
// dipanggil), Worker membaca Sheet. Kalau ada baris dengan Nama terisi tapi Kode/Link
// masih kosong, Worker langsung MENULIS BALIK ke Sheet itu juga (kolom A & D), sebelum
// menjawab request. Jadi kamu cukup isi kolom Nama (& Grup kalau mau) di Sheet — kode
// dan link akan muncul sendiri di Sheet begitu ada trafik ke website (atau buka sendiri
// salah satu link tamu / halaman utama untuk memicunya kalau mau instan).
//
// Env vars yang dibutuhkan (Settings > Environment variables di Cloudflare Pages):
//   GOOGLE_SERVICE_ACCOUNT_EMAIL       - email service account
//   GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY - private key PEM dari file JSON service account
//   GUEST_SHEET_ID                     - ID spreadsheet (dari URL sheet)
//   GUEST_SHEET_RANGE                  - opsional, default "Tamu!A:C" (kolom yang dibaca)
//   SITE_BASE_URL                      - contoh: https://undangan-nia-dimas.pages.dev
//
// Sheet harus di-share (Share > klik tombol) ke email service account dengan akses "Editor"
// (bukan cuma Viewer, karena Worker ini menulis balik Kode & Link).

const GUEST_CACHE_TTL_MS = 30 * 1000; // data Sheet di-refresh tiap 30 detik (cukup "live" tanpa bikin quota API jebol)
const TOKEN_CACHE_TTL_MS = 50 * 60 * 1000; // access token Google berlaku 1 jam, kita cache 50 menit

let _guestsCache = null;
let _guestsCacheAt = 0;
let _tokenCache = null;
let _tokenCacheAt = 0;

function base64UrlEncode(bytes) {
  let str = typeof bytes === "string" ? btoa(bytes) : btoa(String.fromCharCode(...new Uint8Array(bytes)));
  return str.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function pemToArrayBuffer(pem) {
  const clean = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\\n/g, "")
    .replace(/\s+/g, "");
  const binary = atob(clean);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function getGoogleAccessToken(env) {
  const now = Date.now();
  if (_tokenCache && now - _tokenCacheAt < TOKEN_CACHE_TTL_MS) return _tokenCache;

  if (!env.GOOGLE_SERVICE_ACCOUNT_EMAIL || !env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY) {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_EMAIL / GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY belum diset.");
  }

  const iat = Math.floor(now / 1000);
  const exp = iat + 3600;
  const header = { alg: "RS256", typ: "JWT" };
  const claim = {
    iss: env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    scope: "https://www.googleapis.com/auth/spreadsheets",
    aud: "https://oauth2.googleapis.com/token",
    iat,
    exp,
  };

  const enc = (obj) => base64UrlEncode(JSON.stringify(obj));
  const unsigned = `${enc(header)}.${enc(claim)}`;

  const keyData = pemToArrayBuffer(env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY);
  const cryptoKey = await crypto.subtle.importKey(
    "pkcs8",
    keyData,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    cryptoKey,
    new TextEncoder().encode(unsigned)
  );
  const jwt = `${unsigned}.${base64UrlEncode(signature)}`;

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=${encodeURIComponent("urn:ietf:params:oauth:grant-type:jwt-bearer")}&assertion=${jwt}`,
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Gagal ambil access token Google (${res.status}): ${errText}`);
  }

  const data = await res.json();
  _tokenCache = data.access_token;
  _tokenCacheAt = now;
  return _tokenCache;
}

function findColumnIndex(header, candidates) {
  for (const c of candidates) {
    const idx = header.findIndex((h) => String(h || "").trim().toLowerCase() === c);
    if (idx !== -1) return idx;
  }
  return -1;
}

async function loadGuestsFromSheet(env) {
  const now = Date.now();
  if (_guestsCache && now - _guestsCacheAt < GUEST_CACHE_TTL_MS) return _guestsCache;

  if (!env.GUEST_SHEET_ID) {
    throw new Error("GUEST_SHEET_ID belum diset.");
  }

  const token = await getGoogleAccessToken(env);
  const range = env.GUEST_SHEET_RANGE || "Tamu!A:C";
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${env.GUEST_SHEET_ID}/values/${encodeURIComponent(range)}`;

  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Sheets API error (${res.status}): ${errText}`);
  }

  const data = await res.json();
  const rows = data.values || [];
  if (rows.length === 0) {
    _guestsCache = new Map();
    _guestsCacheAt = now;
    return _guestsCache;
  }

  const header = rows[0];
  const nameIdx = findColumnIndex(header, ["nama", "name"]);
  const groupIdx = findColumnIndex(header, ["grup", "group", "kelompok"]);
  const codeIdx = findColumnIndex(header, ["kode", "code"]);

  const map = new Map();
  let autoCounter = 0;
  const pendingUpdates = []; // baris yang perlu ditulis balik (Kode dan/atau Link)

  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (nameIdx === -1) continue;

    const name = String(r[nameIdx] || "").trim();
    if (!name) continue;

    const group = groupIdx !== -1 ? String(r[groupIdx] || "").trim() : "";
    let code = codeIdx !== -1 ? String(r[codeIdx] || "").trim() : "";
    let needsCodeWrite = false;

    if (!code) {
      do {
        autoCounter += 1;
        code = String(autoCounter).padStart(3, "0");
      } while (map.has(code));
      needsCodeWrite = true;
    }

    map.set(code, { code, name, group });

    if (needsCodeWrite) {
      // sheetRow = nomor baris asli di Sheet (i adalah index array yang sudah dipotong header, +2 karena baris 1 = header)
      pendingUpdates.push({ sheetRow: i + 1, code });
    }
  }

  if (pendingUpdates.length > 0) {
    try {
      await writeBackCodesAndLinks(env, token, pendingUpdates);
    } catch (err) {
      // jangan gagalkan pembacaan tamu kalau tulis-balik gagal (misal akses Editor belum diberikan)
      console.error("Gagal menulis balik Kode/Link ke Sheet:", err.message);
    }
  }

  _guestsCache = map;
  _guestsCacheAt = now;
  return map;
}

async function writeBackCodesAndLinks(env, token, updates) {
  const sheetTabName = (env.GUEST_SHEET_RANGE || "Tamu!A:C").split("!")[0];
  const baseUrl = (env.SITE_BASE_URL || "").replace(/\/+$/, "");

  const data = [];
  for (const u of updates) {
    // kolom A = Kode
    data.push({
      range: `${sheetTabName}!A${u.sheetRow}`,
      values: [[u.code]],
    });
    // kolom D = Link (hanya ditulis kalau SITE_BASE_URL sudah diset)
    if (baseUrl) {
      data.push({
        range: `${sheetTabName}!D${u.sheetRow}`,
        values: [[`${baseUrl}/?to=${encodeURIComponent(u.code)}`]],
      });
    }
  }

  const url = `https://sheets.googleapis.com/v4/spreadsheets/${env.GUEST_SHEET_ID}/values:batchUpdate`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ valueInputOption: "USER_ENTERED", data }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`batchUpdate gagal (${res.status}): ${errText}`);
  }
}

// ====== Galeri foto/video & musik latar — auto-detect langsung dari isi folder GitHub ======
//
// Cara kerja: Worker ini memanggil GitHub Contents API untuk membaca daftar file
// yang ADA di folder "photos/" (foto & video) dan "music/" (lagu) di repo kamu,
// apa pun nama filenya. Jadi kamu cukup UPLOAD file ke folder itu lewat GitHub —
// tidak perlu rename ke foto1.jpg / music.mp3 dan tidak perlu edit kode lagi.
//
// Env vars (opsional tapi disarankan, Settings > Environment variables di Cloudflare Pages):
//   GITHUB_OWNER   - default "ProtossDimas"
//   GITHUB_REPO    - default "WeddingInvitation"
//   GITHUB_BRANCH  - default "main"
//   GITHUB_TOKEN   - opsional. Tanpa token, GitHub API dibatasi 60 request/jam per Worker
//                    (biasanya cukup karena hasil di-cache 5 menit). Kalau mau lebih aman
//                    saat hari-H (banyak tamu buka bareng), buat Personal Access Token
//                    (fine-grained, read-only, khusus repo ini) di GitHub > Settings >
//                    Developer settings, lalu isi di sini agar limit naik jadi 5000/jam.

const MEDIA_CACHE_TTL_MS = 5 * 60 * 1000; // daftar file di-refresh tiap 5 menit
const IMAGE_EXTS = ["jpg", "jpeg", "png", "webp", "gif"];
const VIDEO_EXTS = ["mp4", "webm", "mov"];
const AUDIO_EXTS = ["mp3", "m4a", "wav", "ogg"];

const _mediaCache = {}; // { "photos": {data, at}, "music": {data, at} }

function extOf(name) {
  const m = String(name).match(/\.([a-zA-Z0-9]+)$/);
  return m ? m[1].toLowerCase() : "";
}

async function listGithubDir(env, dirPath) {
  const now = Date.now();
  const cached = _mediaCache[dirPath];
  if (cached && now - cached.at < MEDIA_CACHE_TTL_MS) return cached.data;

  const owner = env.GITHUB_OWNER || "ProtossDimas";
  const repo = env.GITHUB_REPO || "WeddingInvitation";
  const branch = env.GITHUB_BRANCH || "main";
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${dirPath}?ref=${branch}`;

  const headers = {
    "User-Agent": "wedding-invitation-worker",
    Accept: "application/vnd.github+json",
  };
  if (env.GITHUB_TOKEN) headers.Authorization = `Bearer ${env.GITHUB_TOKEN}`;

  const res = await fetch(url, { headers });
  if (!res.ok) {
    // Folder belum ada / kosong / rate limit — anggap kosong daripada bikin error ke user.
    if (res.status === 404) {
      _mediaCache[dirPath] = { data: [], at: now };
      return [];
    }
    throw new Error(`GitHub API error (${res.status}): ${await res.text()}`);
  }

  const data = await res.json();
  const files = Array.isArray(data) ? data.filter((f) => f.type === "file").map((f) => f.name) : [];

  _mediaCache[dirPath] = { data: files, at: now };
  return files;
}

async function handleGetGallery(env) {
  // Tidak dipakai lagi — galeri sekarang diatur manual lewat GALLERY_FILES di index.html
  // agar Dimas & Nia bisa memilih sendiri foto mana yang tampil dan urutannya.
  // Fungsi ini disimpan (tidak dipanggil) kalau suatu saat mode auto-detect ingin dipakai lagi.
  let files;
  try {
    files = await listGithubDir(env, "photos");
  } catch (err) {
    return json({ error: "Gagal membaca folder photos dari GitHub: " + err.message }, 500);
  }

  const items = files
    .filter((name) => IMAGE_EXTS.includes(extOf(name)) || VIDEO_EXTS.includes(extOf(name)))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }))
    .map((name) => ({
      type: VIDEO_EXTS.includes(extOf(name)) ? "video" : "image",
      url: `/photos/${encodeURIComponent(name)}`,
    }));

  return json({ items });
}

async function handleGetMusic(env) {
  let files;
  try {
    files = await listGithubDir(env, "music");
  } catch (err) {
    return json({ error: "Gagal membaca folder music dari GitHub: " + err.message }, 500);
  }

  const tracks = files
    .filter((name) => AUDIO_EXTS.includes(extOf(name)))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }));

  const track = tracks[0] || null;
  return json({ url: track ? `/music/${encodeURIComponent(track)}` : null });
}

async function handleGetGuest(code, env) {
  const cleanCode = sanitize(code);
  if (!cleanCode) return badRequest("Kode tamu tidak valid.");

  let guests;
  try {
    guests = await loadGuestsFromSheet(env);
  } catch (err) {
    return json({ error: "Gagal membaca daftar tamu dari Spreadsheet: " + err.message }, 500);
  }

  const row = guests.get(cleanCode);
  if (!row) return json({ error: "Tamu tidak ditemukan." }, 404);
  return json({ code: row.code, name: row.name, group: row.group || null });
}

async function handlePostWish(request, env) {
  if (!env.DB) {
    return json({ error: "D1 database belum terhubung (binding 'DB' tidak ditemukan)." }, 500);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return badRequest("Body harus berupa JSON.");
  }

  const name = sanitize(body.name);
  const attendance = sanitize(body.attendance);
  const message = sanitize(body.message);

  if (!name || name.length > MAX_NAME) {
    return badRequest("Nama tidak valid.");
  }
  if (!ALLOWED_ATTENDANCE.includes(attendance)) {
    return badRequest("Status kehadiran tidak valid.");
  }
  if (!message || message.length > MAX_MESSAGE) {
    return badRequest("Ucapan tidak valid.");
  }

  await env.DB.prepare(
    "INSERT INTO wishes (name, attendance, message) VALUES (?, ?, ?)"
  ).bind(name, attendance, message).run();

  return json({ ok: true });
}

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const path = url.pathname;

  // CORS preflight
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      },
    });
  }

  if (path === "/api/wishes") {
    if (request.method === "GET") return handleGetWishes(env);
    if (request.method === "POST") return handlePostWish(request, env);
    return json({ error: "Method tidak diizinkan." }, 405);
  }

  if (path === "/api/music") {
    if (request.method !== "GET") return json({ error: "Method tidak diizinkan." }, 405);
    return handleGetMusic(env);
  }

  if (path.startsWith("/api/guest/")) {
    if (request.method !== "GET") return json({ error: "Method tidak diizinkan." }, 405);
    const code = decodeURIComponent(path.slice("/api/guest/".length));
    return handleGetGuest(code, env);
  }

  // Endpoint tak dikenal di bawah /api/*
  if (path.startsWith("/api/")) {
    return json({ error: "Endpoint tidak ditemukan." }, 404);
  }

  // Untuk path lain (asset statis dsb), biarkan Cloudflare Pages menanganinya
  return env.ASSETS ? env.ASSETS.fetch(request) : new Response("Not found", { status: 404 });
}
