/* Processo principal do Electron - embrulha o softphone web como app desktop.
   Reaproveita a pasta public/ (mesma UI e logica JsSIP da versao web).
   Sinalizacao continua via WS/WSS e a midia via WebRTC, compativel com FreeSWITCH. */
const { app, BrowserWindow, session, shell, Menu, ipcMain } = require("electron");
const path = require("path");
const { SipUdpClient } = require("./sip-udp");

const isDev = process.argv.includes("--dev");
// Em ambiente de teste do FreeSWITCH e comum usar certificado WSS autoassinado.
// Por padrao aceitamos certificados invalidos; use --secure para exigir cert valido.
const allowInsecureTLS = !process.argv.includes("--secure");

let mainWindow = null;
let sipUdp = null;

// ---------- IPC: stack SIP UDP (cliente/servidor, desktop-only) ----------
function setupSipUdpIpc() {
  const forward = (ev) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("sipudp:event", ev);
    }
  };

  ipcMain.handle("sipudp:start", async (_e, config) => {
    if (!sipUdp) {
      sipUdp = new SipUdpClient(forward);
      // PCM recebido do RTP -> envia ao renderer para reproducao.
      sipUdp.setAudioSink((int16) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          // Envia uma copia do buffer (ArrayBuffer) ao renderer.
          const copy = Buffer.from(int16.buffer, int16.byteOffset, int16.byteLength);
          mainWindow.webContents.send("sipudp:audio-in", copy);
        }
      });
    }
    try {
      const info = await sipUdp.start(config);
      return { ok: true, info };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle("sipudp:stop", async () => {
    if (sipUdp) sipUdp.stop();
    return { ok: true };
  });

  ipcMain.handle("sipudp:register", async () => {
    if (sipUdp) sipUdp.register();
    return { ok: true };
  });

  ipcMain.handle("sipudp:unregister", async () => {
    if (sipUdp) sipUdp.unregister();
    return { ok: true };
  });

  ipcMain.handle("sipudp:options", async (_e, target) => {
    if (sipUdp) sipUdp.sendOptions(target);
    return { ok: true };
  });

  ipcMain.handle("sipudp:message", async (_e, target, text) => {
    if (sipUdp) sipUdp.sendMessage(target, text);
    return { ok: true };
  });

  // ---- Chamadas de audio ----
  ipcMain.handle("sipudp:call", async (_e, target) => {
    if (sipUdp) await sipUdp.makeCall(target);
    return { ok: true };
  });
  ipcMain.handle("sipudp:answer", async () => {
    if (sipUdp) sipUdp.answer();
    return { ok: true };
  });
  ipcMain.handle("sipudp:reject", async () => {
    if (sipUdp) sipUdp.reject();
    return { ok: true };
  });
  ipcMain.handle("sipudp:hangup", async () => {
    if (sipUdp) sipUdp.hangup();
    return { ok: true };
  });

  // ---- Audio: microfone (renderer -> RTP) ----
  // Recebe ArrayBuffer com amostras PCM Int16 do renderer.
  ipcMain.on("sipudp:audio-out", (_e, arrayBuffer) => {
    if (!sipUdp || !arrayBuffer) return;
    try {
      const int16 = new Int16Array(arrayBuffer);
      sipUdp.writeAudioFrame(int16);
    } catch (err) { /* noop */ }
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1024,
    height: 760,
    minWidth: 420,
    minHeight: 600,
    title: "Softphone SIP",
    backgroundColor: "#0f172a",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  // Concede permissao de microfone automaticamente (necessario para getUserMedia).
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    if (permission === "media" || permission === "microphone" || permission === "audioCapture") {
      return callback(true);
    }
    // Demais permissoes ficam negadas por padrao.
    return callback(false);
  });

  // Verificacao sincrona de permissao (algumas versoes do Chromium usam esta via).
  session.defaultSession.setPermissionCheckHandler((webContents, permission) => {
    return permission === "media" || permission === "microphone" || permission === "audioCapture";
  });

  mainWindow.loadFile(path.join(__dirname, "..", "public", "index.html"));

  // Links externos abrem no navegador padrao, nao dentro do app.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  if (isDev) {
    mainWindow.webContents.openDevTools({ mode: "detach" });
  }

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

// Aceita certificados TLS autoassinados (apenas para ambiente de teste do FreeSWITCH).
app.on("certificate-error", (event, webContents, url, error, certificate, callback) => {
  if (allowInsecureTLS) {
    event.preventDefault();
    callback(true);
    console.warn("[TLS] Certificado aceito sem validacao para:", url, "(modo de teste)");
  } else {
    callback(false);
  }
});

function buildMenu() {
  const template = [
    {
      label: "Arquivo",
      submenu: [{ role: "quit", label: "Sair" }],
    },
    {
      label: "Editar",
      submenu: [
        { role: "cut", label: "Recortar" },
        { role: "copy", label: "Copiar" },
        { role: "paste", label: "Colar" },
        { role: "selectAll", label: "Selecionar tudo" },
      ],
    },
    {
      label: "Exibir",
      submenu: [
        { role: "reload", label: "Recarregar" },
        { role: "toggleDevTools", label: "Ferramentas de desenvolvedor" },
        { type: "separator" },
        { role: "resetZoom", label: "Zoom padrao" },
        { role: "zoomIn", label: "Aumentar zoom" },
        { role: "zoomOut", label: "Diminuir zoom" },
        { type: "separator" },
        { role: "togglefullscreen", label: "Tela cheia" },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(() => {
  buildMenu();
  setupSipUdpIpc();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (sipUdp) { try { sipUdp.stop(); } catch (e) { /* noop */ } }
  if (process.platform !== "darwin") app.quit();
});
