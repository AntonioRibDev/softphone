/* Preload seguro: contextIsolation ligado.
   Expoe window.softphoneDesktop (info do ambiente) e window.sipUdp (stack SIP UDP). */
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("softphoneDesktop", {
  isDesktop: true,
  platform: process.platform,
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  },
});

// API da aba SIP UDP (somente no desktop). Os metodos chamam o processo principal
// via IPC; eventos (status, mensagens SIP, logs) chegam por onEvent().
contextBridge.exposeInMainWorld("sipUdp", {
  start: (config) => ipcRenderer.invoke("sipudp:start", config),
  stop: () => ipcRenderer.invoke("sipudp:stop"),
  register: () => ipcRenderer.invoke("sipudp:register"),
  unregister: () => ipcRenderer.invoke("sipudp:unregister"),
  options: (target) => ipcRenderer.invoke("sipudp:options", target),
  message: (target, text) => ipcRenderer.invoke("sipudp:message", target, text),

  // Chamadas de audio
  call: (target) => ipcRenderer.invoke("sipudp:call", target),
  answer: () => ipcRenderer.invoke("sipudp:answer"),
  reject: () => ipcRenderer.invoke("sipudp:reject"),
  hangup: () => ipcRenderer.invoke("sipudp:hangup"),

  // Audio do microfone (renderer -> main). Envia ArrayBuffer de Int16.
  sendAudio: (arrayBuffer) => ipcRenderer.send("sipudp:audio-out", arrayBuffer),
  // Audio recebido (main -> renderer). callback recebe um ArrayBuffer de Int16.
  onAudio: (callback) => {
    const listener = (_e, buf) => {
      // buf chega como Uint8Array/Buffer; entrega o ArrayBuffer correspondente.
      const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
      callback(ab);
    };
    ipcRenderer.on("sipudp:audio-in", listener);
    return () => ipcRenderer.removeListener("sipudp:audio-in", listener);
  },

  onEvent: (callback) => {
    const listener = (_e, data) => callback(data);
    ipcRenderer.on("sipudp:event", listener);
    // retorna funcao para remover o listener
    return () => ipcRenderer.removeListener("sipudp:event", listener);
  },
});
