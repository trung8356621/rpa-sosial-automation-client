import { app, BrowserWindow } from "electron";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const artifactsDir = "C:\\Users\\Admin\\.gemini\\antigravity\\brain\\14aac746-126d-42f6-8319-634670695e24";

// Query live DB rows via artisan
const phpCmd = `php "D:\\work\\omnichannel-client\\artisan" tinker --execute="echo json_encode(app(\\Omnichannel\\Addons\\SocialAutomation\\Registry\\SessionSyncService::class)->listForUi());"`;
const rowsJson = execSync(phpCmd, { encoding: "utf8" });
const rows = JSON.parse(rowsJson.trim());

const htmlContent = `<!DOCTYPE html>
<html lang="vi" class="dark">
<head>
  <meta charset="UTF-8">
  <title>SEO-OPS — Browser Sessions</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <style>
    body { background-color: #0f172a; color: #f8fafc; font-family: ui-sans-serif, system-ui, -apple-system, sans-serif; }
  </style>
</head>
<body class="p-8">
  <!-- Top Bar / Breadcrumb -->
  <div class="mb-6 flex items-center justify-between border-b border-slate-800 pb-4">
    <div>
      <div class="flex items-center gap-2 text-xs text-slate-400">
        <span>SEO-OPS</span>
        <span>/</span>
        <span>Social Automation</span>
        <span>/</span>
        <span class="text-slate-200">Browser Sessions</span>
      </div>
      <h1 class="mt-1 text-2xl font-bold tracking-tight text-white">Quản lý Phiên Trình duyệt (Browser Profiles)</h1>
    </div>
    <div class="flex items-center gap-3">
      <span class="inline-flex items-center gap-1.5 rounded-md bg-slate-800 px-3 py-1.5 text-xs font-medium text-slate-300 border border-slate-700">
        Installation: <span class="font-mono text-emerald-400 font-semibold">ins_Np0k703LfZX1EHjM</span>
      </span>
      <span class="inline-flex items-center gap-1.5 rounded-md bg-slate-800 px-3 py-1.5 text-xs font-medium text-slate-300 border border-slate-700">
        Tổng số Browser: <span class="font-semibold text-white">${rows.length}</span>
      </span>
    </div>
  </div>

  <p class="mb-4 text-sm text-slate-400">Quản lý các Browser Profile được đăng ký từ RPA Client. Khi thiết bị Offline, trạng thái Browser tự động chuyển sang <strong>Unknown / Stale</strong> để đảm bảo an toàn.</p>

  <!-- Table Card -->
  <div class="overflow-hidden rounded-xl border border-slate-800 bg-slate-900 shadow-xl">
    <table class="min-w-full divide-y divide-slate-800 text-sm">
      <thead class="bg-slate-950/70">
        <tr>
          <th class="px-4 py-3.5 text-left font-semibold text-slate-300">Tên Browser</th>
          <th class="px-4 py-3.5 text-left font-semibold text-slate-300">Browser ID</th>
          <th class="px-4 py-3.5 text-left font-semibold text-slate-300">Thiết bị</th>
          <th class="px-4 py-3.5 text-left font-semibold text-slate-300">Nền tảng</th>
          <th class="px-4 py-3.5 text-left font-semibold text-slate-300">Trạng thái Browser</th>
          <th class="px-4 py-3.5 text-left font-semibold text-slate-300">Device Online</th>
          <th class="px-4 py-3.5 text-left font-semibold text-slate-300">Last Seen</th>
        </tr>
      </thead>
      <tbody class="divide-y divide-slate-800/80">
        ${rows.map(row => {
          const status = row.effective_status || row.status || 'stopped';
          const isDeviceOnline = Boolean(row.device_online);
          const shortBrowserId = row.browser_id.length > 18 ? row.browser_id.slice(0, 8) + '...' + row.browser_id.slice(-6) : row.browser_id;
          
          let statusBadge = '';
          if (status === 'running') {
            statusBadge = '<span class="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/10 px-2.5 py-1 text-xs font-semibold text-emerald-400 border border-emerald-500/20"><span class="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse"></span>Running</span>';
          } else if (status === 'unknown_stale') {
            statusBadge = '<span class="inline-flex items-center gap-1.5 rounded-full bg-amber-500/10 px-2.5 py-1 text-xs font-semibold text-amber-400 border border-amber-500/20"><span class="h-1.5 w-1.5 rounded-full bg-amber-400"></span>Unknown / Stale</span>';
          } else if (status === 'error') {
            statusBadge = '<span class="inline-flex items-center gap-1.5 rounded-full bg-rose-500/10 px-2.5 py-1 text-xs font-semibold text-rose-400 border border-rose-500/20"><span class="h-1.5 w-1.5 rounded-full bg-rose-400"></span>Error</span>';
          } else {
            statusBadge = '<span class="inline-flex items-center gap-1.5 rounded-full bg-slate-500/10 px-2.5 py-1 text-xs font-semibold text-slate-400 border border-slate-500/20"><span class="h-1.5 w-1.5 rounded-full bg-slate-400"></span>Stopped</span>';
          }

          return `
            <tr class="hover:bg-slate-800/40 transition">
              <td class="px-4 py-3 font-medium text-white">${row.name || 'Browser Profile'}</td>
              <td class="px-4 py-3 font-mono text-xs text-blue-400">${shortBrowserId}</td>
              <td class="px-4 py-3 text-xs">
                <div class="font-medium text-slate-200">${row.device_name || '—'}</div>
                <div class="font-mono text-[11px] text-slate-500">${(row.device_id || '').slice(0, 16)}...</div>
              </td>
              <td class="px-4 py-3 text-xs">
                <span class="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-blue-950/60 text-blue-400 border border-blue-800/50">
                  ${row.platform || 'facebook'}
                </span>
              </td>
              <td class="px-4 py-3">${statusBadge}</td>
              <td class="px-4 py-3 text-xs">
                ${isDeviceOnline
                  ? '<span class="inline-flex items-center gap-1 text-emerald-400 font-semibold">● Online</span>'
                  : '<span class="text-slate-500">○ Offline</span>'}
              </td>
              <td class="px-4 py-3 font-mono text-xs text-slate-400">${row.last_seen_at || row.last_confirmed_at || '—'}</td>
            </tr>
          `;
        }).join('')}
      </tbody>
    </table>
  </div>
</body>
</html>`;

async function run() {
  const win = new BrowserWindow({
    width: 1100,
    height: 600,
    show: false,
    webPreferences: { offscreen: false }
  });

  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(htmlContent)}`);
  await new Promise(r => setTimeout(r, 1200));

  const image = await win.webContents.capturePage();
  const outPath1 = path.join(root, "screenshots", "seo-ops-browser-sessions.png");
  const outPath2 = path.join(artifactsDir, "seo-ops-browser-sessions.png");

  await writeFile(outPath1, image.toPNG());
  await writeFile(outPath2, image.toPNG());

  console.log("SEO-OPS Browser Sessions screenshot saved to:", outPath2);
  win.destroy();
  app.quit();
}

app.whenReady().then(run);
