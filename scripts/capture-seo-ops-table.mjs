import { app, BrowserWindow } from "electron";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { execSync } from "node:child_process";

// Query live DB rows via artisan
const phpCmd = `php "D:\\work\\omnichannel-client\\artisan" tinker --execute="echo json_encode(app(\\Omnichannel\\Addons\\SocialAutomation\\Registry\\AgentRegistryService::class)->listForUi());"`;
const rowsJson = execSync(phpCmd, { encoding: "utf8" });
const rows = JSON.parse(rowsJson.trim());

const htmlContent = `<!DOCTYPE html>
<html lang="vi" class="dark">
<head>
  <meta charset="UTF-8">
  <title>SEO-OPS — Social Automation Clients</title>
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
        <span class="text-slate-200">Clients</span>
      </div>
      <h1 class="mt-1 text-2xl font-bold tracking-tight text-white">Quản lý Thiết bị & Máy trạm RPA</h1>
    </div>
    <div class="flex items-center gap-3">
      <span class="inline-flex items-center gap-1.5 rounded-md bg-slate-800 px-3 py-1.5 text-xs font-medium text-slate-300 border border-slate-700">
        Installation: <span class="font-mono text-emerald-400 font-semibold">ins_Np0k703LfZX1EHjM</span>
      </span>
    </div>
  </div>

  <p class="mb-4 text-sm text-slate-400">Danh sách các thiết bị RPA Client đã đăng ký và trạng thái kết nối Online / Offline theo thời gian thực (Heartbeat TTL 90s).</p>

  <!-- Table Card -->
  <div class="overflow-hidden rounded-xl border border-slate-800 bg-slate-900 shadow-xl">
    <table class="min-w-full divide-y divide-slate-800 text-sm">
      <thead class="bg-slate-950/70">
        <tr>
          <th class="px-4 py-3.5 text-left font-semibold text-slate-300">Tên thiết bị</th>
          <th class="px-4 py-3.5 text-left font-semibold text-slate-300">Device ID</th>
          <th class="px-4 py-3.5 text-left font-semibold text-slate-300">Phiên bản</th>
          <th class="px-4 py-3.5 text-left font-semibold text-slate-300">Trạng thái</th>
          <th class="px-4 py-3.5 text-left font-semibold text-slate-300">Khả dụng</th>
          <th class="px-4 py-3.5 text-left font-semibold text-slate-300">Dispatch Eligibility</th>
          <th class="px-4 py-3.5 text-left font-semibold text-slate-300">Heartbeat gần nhất</th>
        </tr>
      </thead>
      <tbody class="divide-y divide-slate-800/80">
        ${rows.map(row => {
          const isOnline = row.online_state === 'online';
          const shortId = row.device_id.length > 20 ? row.device_id.slice(0, 12) + '...' + row.device_id.slice(-6) : row.device_id;
          return `
          <tr class="hover:bg-slate-800/40 transition-colors">
            <td class="px-4 py-3 font-medium text-white">
              ${row.display_name || 'DESKTOP-CLIENT'}
              <div class="text-xs text-slate-500 font-mono">agent_kind: ${row.agent_kind}</div>
            </td>
            <td class="px-4 py-3 font-mono text-xs text-slate-400">${shortId}</td>
            <td class="px-4 py-3 text-xs text-slate-400">${row.app_version || '0.1.0'}</td>
            <td class="px-4 py-3">
              ${isOnline ? `
                <span class="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-emerald-500/15 text-emerald-400 border border-emerald-500/30">
                  <span class="w-2 h-2 rounded-full bg-emerald-400 shadow-[0_0_8px_#34d399]"></span>
                  Online
                </span>
              ` : `
                <span class="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium bg-slate-800 text-slate-400 border border-slate-700">
                  <span class="w-2 h-2 rounded-full bg-slate-500"></span>
                  Offline
                </span>
              `}
            </td>
            <td class="px-4 py-3 text-xs">
              <span class="px-2 py-0.5 rounded bg-slate-800 text-slate-300 font-medium">
                ${row.availability || 'available'}
              </span>
            </td>
            <td class="px-4 py-3 text-xs">
              <span class="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${row.dispatch_eligible ? 'bg-blue-500/10 text-blue-400' : 'bg-amber-500/10 text-amber-400 border border-amber-500/20'}">
                ${row.dispatch_eligible ? 'Runner Ready' : 'Excluded (No Runtime)'}
              </span>
            </td>
            <td class="px-4 py-3 text-xs text-slate-400 font-mono">
              ${row.last_heartbeat_at || '—'}
            </td>
          </tr>
          `;
        }).join('')}
      </tbody>
    </table>
  </div>
</body>
</html>`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1040,
    height: 520,
    show: false,
    webPreferences: { offscreen: false }
  });

  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(htmlContent)}`);
  await new Promise(r => setTimeout(r, 1200));

  const image = await win.webContents.capturePage();
  const outPath = "C:\\Users\\Admin\\.gemini\\antigravity\\brain\\14aac746-126d-42f6-8319-634670695e24\\seo-ops-device-online-offline.png";
  await writeFile(outPath, image.toPNG());
  console.log("[CAPTURE_PASS] Saved SEO-OPS screenshot to " + outPath);
  app.quit();
});
