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

// ====== Daftar tamu langsung dari file Excel di repo (tanpa D1, tanpa script import) ======
//
// Cukup upload file Excel ke: /data/daftar-tamu.xlsx (root project, sejajar index.html)
// Kolom yang dibaca (nama kolom tidak case-sensitive, urutan bebas):
//   - "Nama" / "Name"   -> wajib
//   - "Grup" / "Group"  -> opsional
//   - "Kode" / "Code"   -> opsional. Kalau kosong, kode 001, 002, ... dibuat otomatis sesuai urutan baris.
//
// Setiap kali file ini diganti & di-push ke GitHub, Cloudflare Pages otomatis re-deploy
// dan daftar tamu ikut terupdate (tidak perlu jalankan script atau import SQL apa pun).

// Catatan: TIDAK memakai library eksternal (xlsx dll) sengaja, karena Cloudflare Pages
// Functions tidak menjalankan "npm install" sebelum bundling kalau tidak ada build command,
// jadi dependency luar gampang gagal saat deploy. CSV cukup dibaca sebagai teks biasa.

const GUEST_CSV_PATH = "/data/daftar-tamu.csv";

let _guestsCache = null; // bertahan selama isolate worker masih hidup (aman, karena tiap deploy = isolate baru)

// Parser CSV sederhana yang tetap menangani nilai berisi koma kalau dibungkus tanda kutip ("...").
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];

    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += c;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((v) => v.trim() !== ""));
}

function findColumnIndex(header, candidates) {
  for (const c of candidates) {
    const idx = header.findIndex((h) => h.trim().toLowerCase() === c);
    if (idx !== -1) return idx;
  }
  return -1;
}

async function loadGuestsFromCsv(request, env) {
  if (_guestsCache) return _guestsCache;
  if (!env.ASSETS) throw new Error("ASSETS binding tidak tersedia.");

  const assetUrl = new URL(GUEST_CSV_PATH, request.url);
  const res = await env.ASSETS.fetch(new Request(assetUrl.toString()));
  if (!res.ok) {
    throw new Error(
      `File "${GUEST_CSV_PATH}" tidak ditemukan (status ${res.status}). Pastikan file sudah di-upload ke repo & sudah di-deploy.`
    );
  }

  const text = await res.text();
  const rows = parseCsv(text);
  if (rows.length === 0) {
    _guestsCache = new Map();
    return _guestsCache;
  }

  const header = rows[0];
  const nameIdx = findColumnIndex(header, ["nama", "name"]);
  const groupIdx = findColumnIndex(header, ["grup", "group", "kelompok"]);
  const codeIdx = findColumnIndex(header, ["kode", "code"]);

  const map = new Map();
  let autoCounter = 0;

  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (nameIdx === -1) continue;

    const name = String(r[nameIdx] || "").trim();
    if (!name) continue;

    const group = groupIdx !== -1 ? String(r[groupIdx] || "").trim() : "";
    let code = codeIdx !== -1 ? String(r[codeIdx] || "").trim() : "";

    if (!code) {
      do {
        autoCounter += 1;
        code = String(autoCounter).padStart(3, "0");
      } while (map.has(code));
    }

    map.set(code, { code, name, group });
  }

  _guestsCache = map;
  return map;
}

async function handleGetGuest(code, request, env) {
  const cleanCode = sanitize(code);
  if (!cleanCode) return badRequest("Kode tamu tidak valid.");

  let guests;
  try {
    guests = await loadGuestsFromCsv(request, env);
  } catch (err) {
    return json({ error: "Gagal membaca daftar tamu dari CSV: " + err.message }, 500);
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

  if (path.startsWith("/api/guest/")) {
    if (request.method !== "GET") return json({ error: "Method tidak diizinkan." }, 405);
    const code = decodeURIComponent(path.slice("/api/guest/".length));
    return handleGetGuest(code, request, env);
  }

  // Endpoint tak dikenal di bawah /api/*
  if (path.startsWith("/api/")) {
    return json({ error: "Endpoint tidak ditemukan." }, 404);
  }

  // Untuk path lain (asset statis dsb), biarkan Cloudflare Pages menanganinya
  return env.ASSETS ? env.ASSETS.fetch(request) : new Response("Not found", { status: 404 });
}
