/* Renderer da aba SIP UDP. Conversa com o processo principal via window.sipUdp
   (exposto pelo preload do Electron). No navegador, window.sipUdp nao existe e
   a aba mostra um aviso de indisponibilidade. */
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);

  // ---------- Troca de abas (funciona em web e desktop) ----------
  const tabs = document.getElementById("tabs");
  if (tabs) {
    tabs.addEventListener("click", (e) => {
      const btn = e.target.closest(".tab");
      if (!btn) return;
      const target = btn.dataset.tab;
      document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t === btn));
      document.querySelectorAll(".tab-panel").forEach((p) => {
        p.classList.toggle("active", p.id === "tab-" + target);
      });
    });
  }

  const api = window.sipUdp;
  const els = {
    unavailable: $("udpUnavailable"),
    grid: $("udpGrid"),
    form: $("udpForm"),
    host: $("udpHost"),
    port: $("udpPort"),
    user: $("udpUser"),
    domain: $("udpDomain"),
    password: $("udpPassword"),
    displayName: $("udpDisplayName"),
    localPort: $("udpLocalPort"),
    expires: $("udpExpires"),
    startBtn: $("udpStartBtn"),
    stopBtn: $("udpStopBtn"),
    registerBtn: $("udpRegisterBtn"),
    unregisterBtn: $("udpUnregisterBtn"),
    target: $("udpTarget"),
    optionsBtn: $("udpOptionsBtn"),
    messageText: $("udpMessageText"),
    messageBtn: $("udpMessageBtn"),
    log: $("udpLog"),
    rawToggle: $("udpRawToggle"),
    clearLogBtn: $("udpClearLogBtn"),
  };

  // Sem suporte a UDP (rodando no navegador): mostra aviso e encerra.
  if (!api) {
    if (els.unavailable) els.unavailable.classList.remove("hidden");
    if (els.grid) els.grid.classList.add("hidden");
    return;
  }

  const STORAGE_KEY = "sip-softphone-udp-config";
  let socketOpen = false;

  // ---------- Persistencia ----------
  function loadConfig() {
    try {
      const s = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
      if (!s) return;
      els.host.value = s.host || "";
      els.port.value = s.port || "5060";
      els.user.value = s.user || "";
      els.domain.value = s.domain || "";
      els.password.value = s.password || "";
      els.displayName.value = s.displayName || "";
      els.localPort.value = s.localPort || "5070";
      els.expires.value = s.expires || "300";
    } catch (e) { /* noop */ }
  }

  function saveConfig() {
    const cfg = {
      host: els.host.value.trim(),
      port: els.port.value.trim(),
      user: els.user.value.trim(),
      domain: els.domain.value.trim(),
      password: els.password.value,
      displayName: els.displayName.value.trim(),
      localPort: els.localPort.value.trim(),
      expires: els.expires.value.trim(),
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg));
  }

  function gatherConfig() {
    return {
      host: els.host.value.trim(),
      port: els.port.value.trim(),
      user: els.user.value.trim(),
      domain: els.domain.value.trim() || els.host.value.trim(),
      password: els.password.value,
      displayName: els.displayName.value.trim(),
      localPort: els.localPort.value.trim(),
      expires: els.expires.value.trim(),
    };
  }

  // ---------- Estado dos botoes ----------
  function setSocketOpen(open) {
    socketOpen = open;
    els.startBtn.disabled = open;
    els.stopBtn.disabled = !open;
    els.registerBtn.disabled = !open;
    els.unregisterBtn.disabled = !open;
    els.optionsBtn.disabled = !open;
    els.messageBtn.disabled = !open;
    [els.host, els.port, els.user, els.domain, els.password, els.localPort, els.expires]
      .forEach((el) => { el.disabled = open; });
  }

  // ---------- Status (reusa o indicador do topo) ----------
  function setStatus(state, text) {
    const reg = $("regStatus");
    const regText = $("regText");
    if (reg) reg.className = "status " + (state || "");
    if (regText) regText.textContent = text;
  }

  // ---------- Log ----------
  function pad(n) { return String(n).padStart(2, "0"); }
  function nowStr() {
    const d = new Date();
    return pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" + pad(d.getSeconds());
  }

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }

  function addEntry(cls, headerText, rawText, arrow) {
    const entry = document.createElement("div");
    entry.className = "entry " + cls;
    const meta = document.createElement("div");
    meta.className = "meta";
    meta.innerHTML = '<span class="arrow">' + (arrow || "") + " " + escapeHtml(headerText) + "</span>" +
      "<span>" + nowStr() + "</span>";
    entry.appendChild(meta);
    if (rawText) {
      const raw = document.createElement("div");
      raw.className = "raw";
      raw.textContent = rawText;
      raw.style.display = els.rawToggle.checked ? "block" : "none";
      entry.appendChild(raw);
    }
    els.log.appendChild(entry);
    els.log.scrollTop = els.log.scrollHeight;
  }

  els.rawToggle.addEventListener("change", () => {
    const show = els.rawToggle.checked;
    els.log.querySelectorAll(".raw").forEach((r) => { r.style.display = show ? "block" : "none"; });
  });

  els.clearLogBtn.addEventListener("click", () => { els.log.innerHTML = ""; });

  // ---------- Eventos vindos do processo principal ----------
  api.onEvent((ev) => {
    if (!ev) return;
    // Encaminha tambem para a tela unificada de Logs SIP.
    try {
      if (window.SipLog) {
        if (ev.type === "sip") {
          window.SipLog.add({ source: "UDP", direction: ev.direction, message: ev.message, summary: ev.summary });
        } else if (ev.type === "message") {
          window.SipLog.add({ source: "UDP", direction: "in", summary: "MESSAGE de " + (ev.from || "?") + ": " + (ev.body || "") });
        } else if (ev.type === "log" && ev.level === "error") {
          window.SipLog.add({ source: "UDP", direction: "error", summary: ev.text });
        }
      }
    } catch (e) { /* noop */ }

    switch (ev.type) {
      case "status":
        setStatus(ev.state, ev.text);
        break;
      case "sip": {
        const arrow = ev.direction === "out" ? "&#8594;" : "&#8592;";
        addEntry(ev.direction, ev.summary || "(mensagem SIP)", ev.message, arrow);
        break;
      }
      case "message":
        addEntry("in", "MESSAGE de " + (ev.from || "?") + ": " + (ev.body || ""), null, "&#9993;");
        break;
      case "log":
        addEntry(ev.level === "error" ? "error" : "log", ev.text, null, "&#8226;");
        break;
    }
  });

  // ---------- Acoes ----------
  els.form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!els.host.value.trim() || !els.user.value.trim()) {
      alert("Informe ao menos host e usuário.");
      return;
    }
    saveConfig();
    addEntry("log", "Abrindo socket UDP...", null, "&#8226;");
    const res = await api.start(gatherConfig());
    if (res && res.ok) {
      setSocketOpen(true);
      addEntry("log", "Socket aberto em " + res.info.localIp + ":" + res.info.localPort, null, "&#8226;");
    } else {
      addEntry("error", "Falha ao abrir socket: " + (res && res.error), null, "&#8226;");
    }
  });

  els.stopBtn.addEventListener("click", async () => {
    await api.stop();
    setSocketOpen(false);
    addEntry("log", "Socket fechado.", null, "&#8226;");
  });

  els.registerBtn.addEventListener("click", () => api.register());
  els.unregisterBtn.addEventListener("click", () => api.unregister());
  els.optionsBtn.addEventListener("click", () => api.options(els.target.value.trim()));
  els.messageBtn.addEventListener("click", () => {
    const text = els.messageText.value;
    if (!text) { els.messageText.focus(); return; }
    api.message(els.target.value.trim(), text);
    els.messageText.value = "";
  });

  // ---------- Init ----------
  loadConfig();
  setSocketOpen(false);
})();
