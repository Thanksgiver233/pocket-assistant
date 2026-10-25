/**
 * 随身 · 桌面版（Electron 主进程，CJS）
 *
 * 结构：一个窗口包着本地 HTTP 服务。服务就是 `pa-serve` 那一套（consent 内核、
 * 审计账本、连接器），桌面端不是第二套实现，只是壳。
 *
 * 为什么主进程用 CJS：npm 的 `electron` 包在 ESM 下解析到的是"下载器"而不是
 * API（`index.js` 导出的是二进制路径），CJS 的 `require('electron')` 才是运行
 * 时注入的 API。我们的服务本体仍是 ESM，通过 `import()` 动态加载。
 *
 * 数据位置：`%APPDATA%/随身/{ws,home}`。ws 放策略与状态，home 放授权与凭证——
 * 在工作区之外，遵守"仓库不能自我授权"。
 */

const { app, BrowserWindow, shell, dialog } = require('electron');
const { randomBytes } = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { join } = require('node:path');
const fs = require('node:fs');

// ── 黑匣子：GUI 应用双击启动时没有控制台，崩溃是"无声"的。──────────────
// 所有启动里程碑与异常都落到 userData/desktop.log，失败时再弹一个系统对话框。
// 没有这个文件，"点了没反应"永远无法远程诊断。
function logFile() {
  try {
    return join(app.getPath('userData'), 'desktop.log');
  } catch {
    return join(process.env.TEMP || process.env.TMP || '.', 'pocket-desktop.log');
  }
}
function logLine(message) {
  try {
    const file = logFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `[${new Date().toISOString()}] ${message}\n`);
  } catch { /* 连日志都写不进去时，只剩对话框这条路 */ }
}
function fail(title, err) {
  const detail = err instanceof Error ? (err.stack || err.message) : String(err);
  logLine(`FATAL ${title}: ${detail}`);
  try {
    // showErrorBox 允许在 app ready 之前调用——恰好是我们最需要它的时刻。
    dialog.showErrorBox(`随身 · ${title}`, `${detail}\n\n日志文件：${logFile()}`);
  } catch { /* 没有桌面会话时对话框也弹不出，日志仍在 */ }
}

process.on('uncaughtException', (err) => fail('未捕获异常', err));
process.on('unhandledRejection', (reason) => fail('未处理的 Promise 拒绝', reason));

// 部分 Windows 显卡驱动会让 GPU/网络服务进程崩溃并拖死整个应用。
// 这个 UI 是纯 DOM（无视频/无 WebGL），关掉硬件加速几乎无感知损失。
app.disableHardwareAcceleration();

let service = null;
let agent = null;

/** `packages/personal` 的位置：开发态与打包态各不相同。 */
function serverRoot() {
  const appPath = app.getAppPath();
  return app.isPackaged
    ? join(appPath, 'packages', 'personal')
    : join(appPath, '..', '..', 'packages', 'personal');
}

async function importFromServer(relative) {
  return import(pathToFileURL(join(serverRoot(), relative)).href);
}

async function startAgent() {
  const userData = app.getPath('userData');
  const workspaceRoot = join(userData, 'ws');
  const homeDir = join(userData, 'home');

  const { ensureWorkspace } = await importFromServer('src/services/workspace.mjs');
  await ensureWorkspace({ workspaceRoot, persona: { name: '随身' } });

  const { activateMock } = await importFromServer('src/index.mjs');
  agent = await activateMock({
    workspaceRoot,
    homeDir,
    logger: {
      info() {},
      warn() {},
      error(message) { console.error(`[pa] ${message}`); }
    }
  });

  const { createHttpServer } = await importFromServer('src/server/http-server.mjs');
  // 一次性令牌，随窗口 URL 注入并立刻从地址栏清掉；桌面端不需要用户手输。
  const token = randomBytes(18).toString('base64url');
  service = createHttpServer({
    api: agent.api,
    token,
    webRoot: join(serverRoot(), 'web'),
    logger: {
      info() {},
      warn() {},
      error(message) { console.error(`[pa] ${message}`); }
    }
  });

  const address = await service.listen(0, '127.0.0.1');
  logLine(`服务已监听 127.0.0.1:${address.port}`);
  return { port: address.port, token };
}

function createWindow({ port, token }) {
  const window = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: '#070b10',
    title: '随身',
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      spellcheck: false
    }
  });

  window.once('ready-to-show', () => {
    logLine('窗口已就绪并显示');
    window.show();
  });
  window.webContents.on('did-fail-load', (_event, code, desc) => logLine(`页面加载失败: ${code} ${desc}`));

  // 不是自己 origin 的链接交给系统浏览器；个人助理的 UI 不能变成通用浏览器。
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith(`http://127.0.0.1:${port}`)) return { action: 'allow' };
    void shell.openExternal(url);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(`http://127.0.0.1:${port}`)) event.preventDefault();
  });

  void window.loadURL(`http://127.0.0.1:${port}/?token=${token}`);
}

async function main() {
  logLine('启动：electron 主进程');
  await app.whenReady();
  logLine('whenReady 完成，开始装配服务');
  console.log('[desktop] whenReady 完成，开始装配服务');
  const started = await startAgent();
  createWindow(started);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) void main();
  });
}

main().catch((err) => {
  fail('启动失败', err);
  app.exit(1);
});

app.on('window-all-closed', () => {
  app.quit();
});

app.on('quit', () => {
  void service?.close();
  void agent?.dispose();
});
