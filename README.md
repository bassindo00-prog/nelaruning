# RunningHub Telegram Bot 🎛️

Bot Telegram yang terhubung ke **RunningHub API** untuk menjalankan workflow **Motion Control (Wan 2.1 SCAIL)**.

Kirim **gambar** + **prompt teks** (video referensi opsional) ke bot → bot mengunggah input ke RunningHub, menjalankan workflow, memantau status job, mengunduh video hasil, lalu mengirimnya kembali ke Telegram.

## Fitur

- 📷 Menerima gambar dari Telegram
- 🎬 Menerima video referensi dari Telegram (opsional)
- ✍️ Menerima prompt teks
- 🚀 Menjalankan workflow RunningHub (`RUNNINGHUB_WORKFLOW_ID`)
- ⏳ Polling status job sampai selesai (dengan progress update via pesan yang diedit)
- ⬇️ Mengunduh video hasil dan mengirimnya kembali ke Telegram
- 🔄 Retry otomatis saat antrian penuh (`TASK_QUEUE_MAXED`, dll.) dengan backoff 30–120s
- ⏱️ Timeout total + cancel otomatis
- ❌ Penanganan error lengkap (termasuk `failedReason` dari server)
- 🧭 **Conversation Flow (Mode Kling Motion Control)** — alur bertahap dengan tombol di `/start`, state machine per-chat (gambar → video → prompt), progress dirender lewat `editMessageText` pada **satu pesan** (status, elapsed time, progress bar), dan logging terminal lengkap (`[IMAGE RECEIVED]` … `[DONE]`)

## Persyaratan

- Node.js 18+ (Node 20+ disarankan)
- Akun RunningHub dengan koin
- Bot Telegram dari [@BotFather](https://t.me/BotFather)

## Setup

```bash
# 1. Install dependencies
npm install

# 2. Salin konfigurasi
cp .env.example .env
# lalu isi:
#   TELEGRAM_BOT_TOKEN   — token dari @BotFather
#   RUNNINGHUB_API_KEY   — API key dari dashboard RunningHub
#   RUNNINGHUB_BASE_URL  — https://www.runninghub.ai/openapi/v2
#   RUNNINGHUB_WORKFLOW_ID — ID workflow Motion Control
```

## Menjalankan

```bash
# Cek konfigurasi + koneksi RunningHub (tanpa token Telegram)
npm run check

# Jalankan bot (mode development, auto-restart saat file berubah)
npm run dev

# Jalankan bot (produksi)
npm start
```

## Cara pakai di Telegram

1. `/start` — lihat panduan
2. Kirim **foto/gambar**
3. (Opsional) Kirim **video** sebagai referensi gerakan
4. Kirim **prompt teks**, mis. `a woman walking on a beach at sunset, cinematic, realistic`
5. Job **otomatis mulai** saat input lengkap — tunggu video hasil dikirim
6. Perintah lain: `/run` (jalankan dengan input tersimpan), `/reset` (bersihkan input), `/seed <angka>` (atur seed)

### Mode Kling Motion Control (Conversation Flow)

1. Ketik `/start` → tekan tombol **🎬 Kling Motion Control**
2. Kirim **gambar utama** 📷
3. Kirim **video referensi** 🎥
4. Kirim **prompt teks** ✍️ (opsional — ketik `/skip` untuk melewati)
5. Bot menjalankan job, lalu memperbarui **satu pesan status** secara bertahap:
   `📤 Uploading files...` → `🚀 Sending request...` → `✅ Job berhasil dibuat (Job ID)` → polling tiap 5 detik (`Status`, `Elapsed Time`, `Progress` bar) → `✅ Generation Complete` → `📤 Sending result...` → video hasil dikirim.

State machine memastikan urutan input tidak bisa dilompati: video ditolak sebelum gambar diterima, dan job tidak berjalan sebelum semua input lengkap.

## Struktur

```
runninghub-telegram-bot/
├── src/
│   ├── index.ts              # Entry point: inisialisasi & graceful shutdown
│   ├── check.ts              # Pemeriksaan konfigurasi + smoke test RunningHub
│   ├── config.ts             # Baca & validasi environment variable
│   ├── runninghub/
│   │   ├── client.ts         # Client RunningHub OpenAPI v2 (upload binary, run workflow, query)
│   │   ├── workflow.ts       # Orkestrasi: upload → run → poll → download (+ retry)
│   │   └── types.ts          # Tipe respons API v1/v2
│   ├── bot/
│   │   ├── handlers.ts       # Handler Telegram (foto, video, teks, perintah)
│   │   └── session.ts        # State session per chat
│   └── utils/
│       ├── telegram.ts       # Unduh file dari Telegram
│       └── wait.ts           # sleep, timeout, format durasi
├── .env.example              # Template konfigurasi
├── package.json
└── tsconfig.json
```

## Catatan

- **Integrasi OpenAPI v2** — semua endpoint relatif ke `RUNNINGHUB_BASE_URL` dari `.env` (tidak ada URL hardcode):
  - Upload gambar/video: `POST {BASE}/media/upload/binary` (multipart, `Authorization: Bearer <API key>`)
  - Jalankan workflow: `POST {BASE}/run/workflow/{RUNNINGHUB_WORKFLOW_ID}` → `taskId` dari respons
  - Polling status: `POST {BASE}/query` dengan body `{ "taskId": "<taskId>" }` tiap 5 detik
  - Sukses: unduh video dari `results[].url` lalu kirim ke Telegram
  - Gagal: tampilkan `errorMessage` dari RunningHub
- Workflow default: Motion Control **2001253005766914050** (50 node). Node yang di-override: `106` (LoadImage), `130` (VHS_LoadVideo), `16` (positive_prompt), `348` (seed).
- Jika task gagal `OOM_KILLED`, model terlalu berat untuk instance yang dipakai — coba atur `RUNNINGHUB_INSTANCE_TYPE` (mis. `plus`) di `.env`.
- Hasil video hanya disimpan `RUNNINGHUB_RETAIN_SECONDS` (default 1 jam) di server.
