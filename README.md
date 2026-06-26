# Undangan Pernikahan — Nia & Dimas

Website undangan pernikahan digital, dengan fitur:
- Halaman undangan statis (cover, profil mempelai, galeri foto/video, cerita, lokasi, hadiah)
- RSVP & ucapan tamu (disimpan ke Cloudflare D1)
- Nama tamu personal otomatis tampil di cover undangan (`?to=001`), **diambil langsung dari file Excel di repo** — tidak perlu database atau script import untuk daftar tamu.

---

## 1. Struktur folder

```
wedding-invitation/
├── index.html                  ← halaman undangan (statis)
├── package.json                ← daftar dependency (wajib, untuk library baca Excel)
├── functions/
│   └── [[catchall]].js         ← Pages Function: endpoint /api/wishes & /api/guest/:code
├── data/
│   └── daftar-tamu.xlsx        ← DAFTAR TAMU — cukup edit & upload file ini untuk update tamu
├── photos/                     ← isi dengan foto/video kamu
│   ├── nia.jpg
│   ├── dimas.jpg
│   ├── cover.jpg                (opsional, background halaman sampul)
│   ├── foto1.jpg, foto2.jpg, ...
│   └── video1.mp4, video2.mp4, ...
└── music.mp3                    ← (opsional) musik latar
```

---

## 2. Format file Excel daftar tamu (`data/daftar-tamu.xlsx`)

Ini **satu-satunya tempat** kamu mengatur siapa saja tamu undangan dan link personalnya. Tidak perlu sentuh kode sama sekali.

### Aturan kolom

| Kolom | Wajib? | Keterangan |
|---|---|---|
| `Kode` | Tidak | Boleh dikosongkan. Kalau kosong, otomatis di-generate `001`, `002`, `003`, ... sesuai urutan baris di Excel. Kalau diisi manual, boleh teks apa saja (misal `vip-budi`), asal tidak ada yang sama persis di baris lain. |
| `Nama` | **Ya** | Nama tamu yang akan muncul di cover undangan. Baris tanpa nama akan dilewati (diabaikan). |
| `Grup` | Tidak | Bebas isi apa saja, misal "Keluarga", "Teman Kantor", "Teman Kuliah". Saat ini belum ditampilkan di halaman, tapi sudah disiapkan kalau suatu saat mau dipakai (misal filter/grouping). |

Catatan penting:
- Nama kolom **tidak case-sensitive** dan boleh diketik dalam Bahasa Inggris juga: `Code`/`Kode`, `Name`/`Nama`, `Group`/`Grup`/`Kelompok` — semua dikenali otomatis.
- Urutan kolom **bebas**, tidak harus Kode-Nama-Grup.
- Sheet yang dibaca adalah **sheet pertama** di file Excel (kalau ada beberapa tab/sheet, pastikan data tamu ada di tab paling kiri).
- Baris pertama harus berisi nama-nama kolom (header), bukan data tamu.

### Contoh isi `data/daftar-tamu.xlsx`

| Kode | Nama | Grup |
|---|---|---|
| 001 | Budi Santoso | Keluarga |
| 002 | Siti Aminah | Teman Kantor |
| *(kosong)* | Andi Wijaya | Teman Kuliah |

Baris ketiga sengaja tanpa Kode → sistem otomatis memberi kode lanjutan (misalnya `003`, mengikuti urutan baris setelah kode-kode yang sudah dipakai).

File contoh siap pakai sudah disediakan — tinggal buka di Excel/Google Sheets, edit isinya, lalu save dengan nama & lokasi yang sama: `data/daftar-tamu.xlsx`.

### Cara dapat link personal per tamu

Link ke setiap tamu mengikuti pola:

```
https://NAMA-PROJECT.pages.dev/?to=KODE
```

Contoh, kalau project Cloudflare Pages kamu bernama `undangan-nia-dimas` dan kode tamu `001`:

```
https://undangan-nia-dimas.pages.dev/?to=001
```

Saat link dibuka, halaman akan otomatis ambil nama tamu dari Excel berdasarkan kode tersebut, dan menampilkannya di cover ("Kepada Bapak/Ibu Budi Santoso").

> Mode tanpa kode tetap didukung sebagai fallback: `?to=Budi+Santoso` (nama langsung ditulis di URL) akan tetap tampil kalau kode tidak ditemukan.

### Cara update daftar tamu setelah website sudah online

1. Buka `data/daftar-tamu.xlsx` di komputer kamu (lewat GitHub: download, atau edit langsung kalau pakai GitHub Desktop/clone lokal).
2. Tambah/ubah/hapus baris tamu.
3. Save file, lalu **upload/push ulang ke GitHub** menimpa file lama di path yang sama.
4. Cloudflare Pages otomatis mendeteksi perubahan dan **re-deploy otomatis** (biasanya selesai dalam 1–2 menit).
5. Selesai — tidak perlu jalankan command apa pun.

---

## 3. Setup database D1 (khusus untuk fitur RSVP & ucapan tamu)

Database ini **hanya** untuk menyimpan ucapan/RSVP yang diisi tamu lewat form di halaman undangan — bukan untuk daftar tamu (daftar tamu sudah dari Excel, lihat bagian 2).

```bash
npx wrangler d1 create undangan-db
```

Catat `database_id` yang muncul di output, lalu buat tabelnya:

```bash
npx wrangler d1 execute undangan-db --remote --command="
CREATE TABLE IF NOT EXISTS wishes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  attendance TEXT NOT NULL,
  message TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
"
```

(Tabel `guests` dari versi sebelumnya **tidak diperlukan lagi** — boleh dihapus kalau masih ada: `DROP TABLE IF EXISTS guests;`)

---

## 4. Deploy ke Cloudflare Pages

### Lewat dashboard (disarankan, paling mudah)

1. Push seluruh folder project ini ke repository GitHub.
2. Di Cloudflare dashboard → **Pages → Create a project → Connect to Git** → pilih repo ini.
3. Build settings:
   - **Framework preset:** None
   - **Build command:** (kosongkan)
   - **Build output directory:** `/` (root)
4. Klik **Save and Deploy**. Cloudflare akan otomatis menjalankan `npm install` (membaca `package.json`) sebelum deploy, sehingga library `xlsx` ikut terpasang.
5. Setelah project pertama kali jadi, masuk ke **Settings → Functions → D1 database bindings** → tambahkan:
   - Variable name: `DB`
   - D1 database: `undangan-db`
6. **Re-deploy** (trigger deployment baru, misalnya lewat tombol "Retry deployment" atau push commit kosong) agar binding D1 aktif.

### Lewat CLI (alternatif)

```bash
npx wrangler pages deploy . --project-name=undangan-nia-dimas
```

Binding D1 untuk Pages tetap perlu diatur lewat dashboard (langkah 5–6 di atas), karena binding Pages tidak otomatis terbaca dari `wrangler.toml` seperti di Workers biasa.

---

## 5. Kustomisasi konten undangan

Semua teks ada langsung di `index.html`. Cari dan ganti bagian:

- Nama orang tua mempelai (`[Nama Ayah]`, `[Nama Ibu]`)
- Tanggal & jam acara — cari teks `12 September 2026`, dan baris `target = new Date('2026-09-12T08:00:00+07:00')` di bagian script (untuk countdown)
- Alamat lokasi acara + link Google Maps (`https://maps.google.com/?q=Bandung`)
- Nomor rekening & nama bank di bagian `#gift`
- Cerita di bagian `#story`

### Foto & video galeri

Upload ke folder `photos/` dengan penamaan berurutan:

- Foto: `foto1.jpg`, `foto2.jpg`, `foto3.png`, dst (boleh campur `.jpg` / `.jpeg` / `.png` / `.webp`)
- Video: `video1.mp4`, `video2.mp4`, dst (boleh `.mp4` / `.webm` / `.mov`)
- Penomoran **harus berurutan** mulai dari 1. Galeri berhenti mencari setelah 3 nomor berturut-turut tidak ditemukan — jangan ada nomor yang dilompati.
- Klik foto/video di galeri akan membuka tampilan besar (lightbox).

Foto profil mempelai pakai nama tetap: `photos/nia.jpg` dan `photos/dimas.jpg`. Kalau belum ada, otomatis fallback ke placeholder huruf inisial.

Foto background sampul: `photos/cover.jpg` (atau `.jpeg`/`.png`/`.webp`). Kalau belum diupload, fallback ke gradient maroon polos.

---

## 6. Cara kerja teknis (untuk referensi)

- `GET /api/guest/:code` → Function membaca `data/daftar-tamu.xlsx` lewat `env.ASSETS.fetch()`, parse dengan library `xlsx` (SheetJS), cari baris dengan kode yang cocok, lalu kembalikan nama & grupnya sebagai JSON.
- Hasil parse Excel di-cache di memory selama "isolate" worker tersebut masih hidup — supaya tidak parse ulang di setiap request. Cache otomatis ter-refresh setiap kali ada deployment baru (termasuk saat kamu update file Excel), karena deployment baru = isolate baru.
- `POST /api/wishes` & `GET /api/wishes` → tetap pakai D1, menyimpan dan menampilkan ucapan/RSVP tamu.
- Tanpa binding D1 yang benar, form ucapan akan menampilkan pesan error yang jelas (bukan crash diam-diam).
- Tanpa file `data/daftar-tamu.xlsx` (belum diupload), endpoint `/api/guest/:code` akan mengembalikan error yang jelas, dan halaman tetap fallback ke mode `?to=Nama` biasa.

---

## 7. Troubleshooting

| Masalah | Kemungkinan sebab & solusi |
|---|---|
| Nama tamu tidak muncul, hanya nama generik | Pastikan path file persis `data/daftar-tamu.xlsx`, dan kode di URL (`?to=001`) sama persis dengan kolom Kode di Excel (termasuk angka nol di depan). |
| Error "File tidak ditemukan" di endpoint `/api/guest/...` | File Excel belum ke-push ke GitHub, atau salah lokasi folder. Cek lagi struktur folder di bagian 1. |
| Build gagal di Cloudflare Pages terkait library `xlsx` | Pastikan `package.json` ada di **root** project (sejajar `index.html`), bukan di dalam folder `functions/`. |
| Ucapan/RSVP tidak tersimpan | Cek binding D1 `DB` sudah ditambahkan di Settings → Functions, lalu lakukan re-deploy. |
| Update Excel tidak langsung kelihatan | Tunggu deployment baru selesai (cek tab Deployments di dashboard Pages). Cache hanya refresh kalau ada deployment baru. |

---

## Desain

Mobile-first, lebar maksimal 520px (di-tengah di layar besar) — cocok dibagikan lewat WhatsApp.
