# 🔥 API Stress Test — GSheet + GitHub Actions + k6

Stress test otomatis yang bisa di-trigger langsung dari Google Sheet.

## Arsitektur

```
Google Sheet (Config + Results)
       ↓  trigger via GitHub API
GitHub Actions
       ↓  jalankan
k6 Stress Test → Dev Environment API
       ↓  POST hasil via webhook
Google Sheet (Results tab)
```

---

## Setup (Sekali Aja)

### 1. Buat GitHub Repo
- Buat repo baru (misal: `api-stress-test`)
- Upload file `k6-script.js` dan folder `.github/` ke root repo

### 2. Tambah GitHub Secrets
Masuk ke **repo → Settings → Secrets and variables → Actions**, tambah:

| Secret Name | Isi |
|---|---|
| `DEV_BEARER_TOKEN` | Bearer token dev environment API kamu |
| `GOOGLE_SHEET_WEBHOOK_URL` | URL webhook Apps Script (dari langkah 4) |

### 3. Setup Google Sheet
- Buat Google Sheet baru
- Buka **Extensions → Apps Script**
- Copy-paste isi `Code.gs` ke editor
- Isi bagian `CONFIG` di atas script:
  ```js
  const CONFIG = {
    GITHUB_TOKEN: 'ghp_xxx',     // GitHub PAT (scope: repo)
    GITHUB_OWNER: 'username',
    GITHUB_REPO: 'api-stress-test',
    ...
  };
  ```
- Klik **Save**, lalu jalankan fungsi `setupSheet()` sekali

### 4. Deploy Apps Script sebagai Web App
- Di Apps Script: **Deploy → New deployment**
- Type: **Web app**
- Execute as: **Me**
- Who has access: **Anyone** *(perlu untuk GitHub Actions bisa POST)*
- Copy URL deployment → simpan ke GitHub Secret `GOOGLE_SHEET_WEBHOOK_URL`

### 5. Buat GitHub Personal Access Token (PAT)
- GitHub → Settings → Developer Settings → Personal Access Tokens → Fine-grained
- Permission: **Actions** (Read & Write), **Contents** (Read)
- Copy token → paste ke `CONFIG.GITHUB_TOKEN` di Apps Script

---

## Cara Pakai (Sehari-hari)

1. Buka Google Sheet
2. Tab **Config** → isi parameter:
   - Target URL
   - Virtual Users (concurrent)
   - Duration
3. Menu **🔥 Stress Test → ▶️ Run Stress Test**
4. Tunggu — hasil otomatis masuk ke tab **Results**

---

## Kolom di Tab Results

| Kolom | Keterangan |
|---|---|
| Timestamp | Waktu test selesai |
| Status | PASS / FAIL |
| Target URL | API yang ditest |
| VU | Jumlah concurrent user |
| Total Req | Total request selama test |
| Req/s | Request per detik |
| Avg (ms) | Rata-rata response time |
| P95 (ms) | 95% request selesai dalam X ms |
| P99 (ms) | 99% request selesai dalam X ms |
| Error % | Persentase error |
| Run URL | Link langsung ke GitHub Actions run |

---

## Threshold Default (Edit di k6-script.js)

```js
thresholds: {
  http_req_duration: ['p(95)<2000', 'p(99)<5000'],  // P95 < 2s, P99 < 5s
  error_rate: ['rate<0.05'],                           // Error < 5%
},
```

---

## Struktur File

```
repo/
├── k6-script.js                        # Script stress test k6
├── .github/
│   └── workflows/
│       └── stress-test.yml             # GitHub Actions workflow
└── README.md

google-sheet/
└── Code.gs                             # Apps Script (paste ke GSheet)
```
