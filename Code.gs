// ============================================================
// KONFIGURASI — Isi sesuai repo kamu
// ============================================================
const CONFIG = {
  GITHUB_TOKEN: 'ghp_xxxxxxxxxxxxxxxxxxxx',   // GitHub Personal Access Token (repo scope)
  GITHUB_OWNER: 'username-kamu',              // GitHub username / org
  GITHUB_REPO: 'api-stress-test',             // Nama repo
  SHEET_RESULT_TAB: 'Results',                // Nama tab untuk hasil
  SHEET_CONFIG_TAB: 'Config',                 // Nama tab untuk config input
};

// ============================================================
// MENU — Tambah menu custom di Google Sheet
// ============================================================
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('🔥 Stress Test')
    .addItem('▶️ Run Stress Test', 'runStressTest')
    .addItem('📊 Lihat Hasil Terakhir', 'openLatestRun')
    .addSeparator()
    .addItem('⚙️ Setup Webhook URL', 'setupWebhook')
    .addToUi();
}

// ============================================================
// TRIGGER STRESS TEST — Baca config dari sheet, kirim ke GitHub Actions
// ============================================================
function runStressTest() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const configSheet = ss.getSheetByName(CONFIG.SHEET_CONFIG_TAB);

  if (!configSheet) {
    SpreadsheetApp.getUi().alert('❌ Tab "Config" tidak ditemukan. Jalankan setupSheet() dulu.');
    return;
  }

  // Baca config dari sheet (kolom B, baris 2-6)
  const targetUrl    = configSheet.getRange('B2').getValue();
  const virtualUsers = configSheet.getRange('B3').getValue();
  const duration     = configSheet.getRange('B4').getValue();
  const rampDuration = configSheet.getRange('B5').getValue();
  const notifySheet  = configSheet.getRange('B6').getValue();

  if (!targetUrl) {
    SpreadsheetApp.getUi().alert('❌ Target URL kosong. Isi dulu di tab Config.');
    return;
  }

  // Payload ke GitHub Actions via repository_dispatch
  const payload = {
    event_type: 'run-stress-test',
    client_payload: {
      target_url: targetUrl,
      virtual_users: String(virtualUsers || 100),
      duration: duration || '1m',
      ramp_duration: rampDuration || '30s',
      notify_sheet: String(notifySheet !== false),
    },
  };

  const options = {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${CONFIG.GITHUB_TOKEN}`,
      Accept: 'application/vnd.github.v3+json',
      'Content-Type': 'application/json',
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  };

  const url = `https://api.github.com/repos/${CONFIG.GITHUB_OWNER}/${CONFIG.GITHUB_REPO}/dispatches`;
  const response = UrlFetchApp.fetch(url, options);
  const code = response.getResponseCode();

  if (code === 204) {
    // Log di sheet Config bahwa test sudah di-trigger
    configSheet.getRange('B8').setValue(new Date().toLocaleString('id-ID'));
    configSheet.getRange('B9').setValue('⏳ Running...');

    SpreadsheetApp.getUi().alert(
      '✅ Stress test berhasil di-trigger!\n\n' +
      `Target: ${targetUrl}\n` +
      `VU: ${virtualUsers} | Durasi: ${duration}\n\n` +
      'Hasil akan masuk otomatis ke tab Results setelah selesai.'
    );
  } else {
    SpreadsheetApp.getUi().alert(
      `❌ Gagal trigger (HTTP ${code})\n\n` +
      response.getContentText()
    );
  }
}

// ============================================================
// WEBHOOK RECEIVER — GitHub Actions POST hasil ke sini
// Deploy sebagai Web App (Execute as: Me, Access: Anyone)
// ============================================================
function doPost(e) {
  try {
    const data = JSON.parse(e.postData.contents);
    appendResult(data);

    return ContentService
      .createTextOutput(JSON.stringify({ status: 'ok' }))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService
      .createTextOutput(JSON.stringify({ status: 'error', message: err.message }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

// ============================================================
// APPEND HASIL KE SHEET — Dipanggil oleh doPost
// ============================================================
function appendResult(data) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let resultSheet = ss.getSheetByName(CONFIG.SHEET_RESULT_TAB);

  if (!resultSheet) {
    resultSheet = ss.insertSheet(CONFIG.SHEET_RESULT_TAB);
    // Header row
    resultSheet.appendRow([
      'Timestamp', 'Status', 'Target URL', 'VU',
      'Total Req', 'Req/s', 'Avg (ms)', 'P95 (ms)', 'P99 (ms)',
      'Min (ms)', 'Max (ms)', 'Error %', 'Success', 'Fail',
      'Run ID', 'Run URL',
    ]);
    resultSheet.getRange(1, 1, 1, 16).setFontWeight('bold').setBackground('#1a1a2e').setFontColor('#ffffff');
  }

  const row = [
    data.timestamp || new Date().toISOString(),
    data.status || '-',
    data.target_url || '-',
    data.virtual_users || '-',
    data.total_requests || 0,
    data.req_per_second || 0,
    data.avg_response_ms || 0,
    data.p95_response_ms || 0,
    data.p99_response_ms || 0,
    data.min_response_ms || 0,
    data.max_response_ms || 0,
    data.error_rate_pct + '%' || '0%',
    data.success_count || 0,
    data.fail_count || 0,
    data.run_id || '-',
    data.run_url || '-',
  ];

  resultSheet.appendRow(row);

  // Warnai baris berdasarkan status PASS/FAIL
  const lastRow = resultSheet.getLastRow();
  const statusCell = resultSheet.getRange(lastRow, 2);
  if (data.status === 'PASS') {
    statusCell.setBackground('#d4edda').setFontColor('#155724');
  } else {
    statusCell.setBackground('#f8d7da').setFontColor('#721c24');
  }

  // Update status di Config sheet
  const configSheet = ss.getSheetByName(CONFIG.SHEET_CONFIG_TAB);
  if (configSheet) {
    configSheet.getRange('B9').setValue(data.status === 'PASS' ? '✅ PASS' : '❌ FAIL');
  }
}

// ============================================================
// SETUP — Buat tab Config dengan template
// ============================================================
function setupSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  // Buat/reset tab Config
  let configSheet = ss.getSheetByName(CONFIG.SHEET_CONFIG_TAB);
  if (configSheet) ss.deleteSheet(configSheet);
  configSheet = ss.insertSheet(CONFIG.SHEET_CONFIG_TAB);

  const configData = [
    ['⚙️ STRESS TEST CONFIG', ''],
    ['Target API URL', 'https://your-dev-api.com/endpoint'],
    ['Virtual Users (concurrent)', 100],
    ['Duration', '1m'],
    ['Ramp Duration', '30s'],
    ['Notify Sheet', true],
    ['', ''],
    ['Last Triggered', ''],
    ['Last Status', ''],
  ];

  configSheet.getRange(1, 1, configData.length, 2).setValues(configData);

  // Styling header
  configSheet.getRange('A1').setFontSize(14).setFontWeight('bold');
  configSheet.getRange('A2:A9').setFontWeight('bold');
  configSheet.setColumnWidth(1, 220);
  configSheet.setColumnWidth(2, 350);

  // Tambah tombol Run (menggunakan drawing)
  SpreadsheetApp.getUi().alert(
    '✅ Sheet "Config" berhasil dibuat!\n\n' +
    'Langkah selanjutnya:\n' +
    '1. Isi Target URL di B2\n' +
    '2. Deploy script ini sebagai Web App (untuk webhook)\n' +
    '3. Copy Webhook URL ke GitHub Secret: GOOGLE_SHEET_WEBHOOK_URL\n' +
    '4. Copy GitHub PAT ke CONFIG.GITHUB_TOKEN di script\n\n' +
    'Setelah itu, gunakan menu 🔥 Stress Test → ▶️ Run Stress Test'
  );
}

// ============================================================
// HELPER — Buka GitHub Actions run terakhir
// ============================================================
function openLatestRun() {
  const url = `https://github.com/${CONFIG.GITHUB_OWNER}/${CONFIG.GITHUB_REPO}/actions`;
  const html = `<script>window.open('${url}', '_blank');google.script.host.close();</script>`;
  const ui = HtmlService.createHtmlOutput(html).setWidth(10).setHeight(10);
  SpreadsheetApp.getUi().showModalDialog(ui, 'Opening...');
}

// ============================================================
// HELPER — Tampilkan Webhook URL setelah deploy
// ============================================================
function setupWebhook() {
  const scriptId = ScriptApp.getScriptId();
  SpreadsheetApp.getUi().alert(
    '📋 Webhook Setup\n\n' +
    'Setelah deploy sebagai Web App, URL-nya format:\n\n' +
    'https://script.google.com/macros/s/[DEPLOYMENT_ID]/exec\n\n' +
    'Simpan URL ini di GitHub repo:\n' +
    'Settings → Secrets → GOOGLE_SHEET_WEBHOOK_URL\n\n' +
    `Script ID kamu: ${scriptId}`
  );
}
