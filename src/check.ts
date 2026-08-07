import { envIsSet, loadConfig, missingEnvVars } from './config.js';
import { RunningHubClient } from './runninghub/client.js';

/**
 * Pemeriksaan proyek tanpa token Telegram:
 * 1. Validasi semua environment variable.
 * 2. Smoke test koneksi RunningHub (gratis, tanpa memakai koin):
 *    cek akun + ambil struktur workflow.
 *
 * Jalankan: npm run check
 */
async function main(): Promise<void> {
  console.log('🔍 RunningHub Telegram Bot — pemeriksaan konfigurasi\n');

  const vars = [
    'TELEGRAM_BOT_TOKEN',
    'RUNNINGHUB_API_KEY',
    'RUNNINGHUB_BASE_URL',
    'RUNNINGHUB_WORKFLOW_ID',
  ];
  for (const v of vars) {
    console.log(`  ${envIsSet(v) ? '✅' : '❌'} ${v}`);
  }

  const missing = missingEnvVars();
  if (missing.length > 0) {
    console.log(`\n⚠️  Belum diisi: ${missing.join(', ')}`);
    if (missing.includes('TELEGRAM_BOT_TOKEN')) {
      console.log('   → Token bot: buat bot via @BotFather di Telegram, salin token ke .env');
    }
    if (missing.includes('RUNNINGHUB_API_KEY')) {
      console.log('   → API key: dashboard RunningHub → Settings → API, salin ke .env');
    }
    if (missing.includes('RUNNINGHUB_API_KEY')) {
      process.exitCode = 1;
      return;
    }
    console.log('   (lanjut ke smoke test RunningHub — API key tersedia)');
  } else {
    console.log('\n✅ Semua environment variable terisi.');
  }

  const config = loadConfig();
  const client = new RunningHubClient({
    apiKey: config.runningHub.apiKey,
    baseUrl: config.runningHub.baseUrl,
    rootBaseUrl: config.runningHub.rootBaseUrl,
    runPath: config.runningHub.runPath,
  });

  try {
    const account = await client.checkAccount();
    console.log(`✅ Koneksi RunningHub OK (saldo: ${account.remainCoins ?? '?'} coins)`);

    if (config.runningHub.runPath === 'run/ai-app') {
      // AI App: validasi lewat detail webapp (gratis) — bukan getJsonApiFormat
      const info = await client.getAiAppInfo(config.runningHub.workflowId);
      const inputs = (info.inputNodes ?? []).map((n) => n.nodeName).join(', ');
      console.log(`✅ AI App ${config.runningHub.workflowId} valid (input: ${inputs || '-'})`);
    } else {
      const wf = await client.getWorkflowJson(config.runningHub.workflowId);
      const nodeCount = typeof wf === 'object' && wf !== null ? Object.keys(wf).length : 0;
      console.log(`✅ Workflow ${config.runningHub.workflowId} valid (${nodeCount} node)`);
    }

    // Smoke test v2: /query dengan taskId asing harus ditolak validasi (gratis, tanpa task)
    try {
      await client.query('__smoke_probe__');
      console.log('⚠️  /query menerima taskId asing — periksa ulang konfigurasi');
    } catch (err2) {
      const m2 = err2 instanceof Error ? err2.message : String(err2);
      if (/query task/i.test(m2)) {
        console.log('✅ Endpoint v2 /query hidup (validasi berfungsi)');
      } else {
        throw err2;
      }
    }
  } catch (err) {
    console.log(
      `❌ Koneksi RunningHub gagal: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exitCode = 1;
    return;
  }

  console.log('\n✅ Siap dijalankan. Isi TELEGRAM_BOT_TOKEN di .env, lalu: npm start');
}

main().catch((err) => {
  console.error('❌ Pemeriksaan gagal:', err instanceof Error ? err.message : err);
  process.exit(1);
});
