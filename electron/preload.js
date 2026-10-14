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
  onEvent: (callback) => {
    const listener = (_e, data) => callback(data);
    ipcRenderer.on("sipudp:event", listener);
    // retorna funcao para remover o listener
    return () => ipcRenderer.removeListener("sipudp:event", listener);
  },
});
