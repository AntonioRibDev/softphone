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
    // Chamada
    callTarget: $("udpCallTarget"),
    callBtn: $("udpCallBtn"),
    hangupBtn: $("udpHangupBtn"),
    answerBtn: $("udpAnswerBtn"),
    rejectBtn: $("udpRejectBtn"),
    callStatus: $("udpCallStatus"),
    callTimer: $("udpCallTimer"),
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
    if (!open) showCallState("idle");
    else showCallState("idle");
  }

  // ---------- Estado da UI de chamada ----------
  function showCallState(state) {
    const hide = (el) => el && el.classList.add("hidden");
    const show = (el) => el && el.classList.remove("hidden");
    hide(els.callBtn); hide(els.hangupBtn); hide(els.answerBtn); hide(els.rejectBtn);

    if (state === "idle") {
      show(els.callBtn);
      els.callBtn.disabled = !socketOpen;
    } else if (state === "calling" || state === "ringing") {
      show(els.hangupBtn);
    } else if (state === "incoming") {
      show(els.answerBtn);
      show(els.rejectBtn);
    } else if (state === "established") {
      show(els.hangupBtn);
    }
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
      case "call":
        onCallEvent(ev);
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

  // ======================================================================
  // AUDIO (WebAudio): captura do microfone -> RTP e reproducao do RTP
  // ======================================================================
  const FRAME = 160; // amostras por quadro (20 ms @ 8 kHz)
  let audioCtx = null;
  let micStream = null;
  let micSource = null;
  let micNode = null;
  let muteGain = null;
  let frameBuf = new Float32Array(FRAME);
  let frameFill = 0;
  let playTime = 0;
  let audioActive = false;

  function ensureAudioCtx() {
    if (!audioCtx) {
      const Ctor = window.AudioContext || window.webkitAudioContext;
      audioCtx = new Ctor({ sampleRate: 8000 });
    }
    if (audioCtx.state === "suspended") audioCtx.resume();
    return audioCtx;
  }

  async function startAudio() {
    if (audioActive) return;
    try {
      ensureAudioCtx();
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false,
      });
      micSource = audioCtx.createMediaStreamSource(micStream);
      micNode = audioCtx.createScriptProcessor(512, 1, 1);
      frameFill = 0;
      micNode.onaudioprocess = (e) => {
        if (!audioActive) return;
        const input = e.inputBuffer.getChannelData(0);
        for (let i = 0; i < input.length; i++) {
          frameBuf[frameFill++] = input[i];
          if (frameFill === FRAME) {
            sendFrame(frameBuf);
            frameFill = 0;
          }
        }
      };
      // Conecta a um ganho zero para manter o processor ativo sem retorno de audio.
      muteGain = audioCtx.createGain();
      muteGain.gain.value = 0;
      micSource.connect(micNode);
      micNode.connect(muteGain);
      muteGain.connect(audioCtx.destination);
      playTime = 0;
      audioActive = true;
      addEntry("log", "Áudio ativo (captura + reprodução).", null, "&#128266;");
    } catch (err) {
      addEntry("error", "Falha ao acessar microfone: " + err.message, null, "&#8226;");
    }
  }

  function sendFrame(f32) {
    const i16 = new Int16Array(FRAME);
    for (let i = 0; i < FRAME; i++) {
      let s = f32[i];
      s = s < -1 ? -1 : s > 1 ? 1 : s;
      i16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    api.sendAudio(i16.buffer);
  }

  function stopAudio() {
    audioActive = false;
    try { if (micNode) { micNode.onaudioprocess = null; micNode.disconnect(); } } catch (e) { /* noop */ }
    try { if (micSource) micSource.disconnect(); } catch (e) { /* noop */ }
    try { if (muteGain) muteGain.disconnect(); } catch (e) { /* noop */ }
    try { if (micStream) micStream.getTracks().forEach((t) => t.stop()); } catch (e) { /* noop */ }
    micNode = micSource = muteGain = micStream = null;
    frameFill = 0;
  }

  // Reproducao do PCM recebido (ArrayBuffer de Int16) com jitter buffer simples.
  api.onAudio((ab) => {
    if (!audioActive || !audioCtx) return;
    const int16 = new Int16Array(ab);
    if (int16.length === 0) return;
    const f32 = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) f32[i] = int16[i] / 32768;
    const buf = audioCtx.createBuffer(1, f32.length, 8000);
    buf.copyToChannel(f32, 0);
    const src = audioCtx.createBufferSource();
    src.buffer = buf;
    src.connect(audioCtx.destination);
    const now = audioCtx.currentTime;
    if (playTime < now + 0.02) playTime = now + 0.06; // ~60 ms de buffer
    src.start(playTime);
    playTime += buf.duration;
  });

  // ---------- Timer de chamada ----------
  let callTimerInt = null;
  function startCallTimer() {
    const t0 = Date.now();
    stopCallTimer();
    callTimerInt = setInterval(() => {
      const s = Math.floor((Date.now() - t0) / 1000);
      els.callTimer.textContent =
        String(Math.floor(s / 60)).padStart(2, "0") + ":" + String(s % 60).padStart(2, "0");
    }, 500);
  }
  function stopCallTimer() {
    clearInterval(callTimerInt);
    callTimerInt = null;
    els.callTimer.textContent = "";
  }

  // ---------- Eventos de chamada ----------
  function onCallEvent(ev) {
    switch (ev.state) {
      case "calling":
        els.callStatus.textContent = "Chamando " + (ev.target || "") + "...";
        showCallState("calling");
        break;
      case "ringing":
        els.callStatus.textContent = "Tocando...";
        showCallState("ringing");
        break;
      case "incoming":
        els.callStatus.textContent = "Chamada recebida de " + (ev.from || "desconhecido");
        showCallState("incoming");
        break;
      case "established":
        els.callStatus.textContent = "Em chamada";
        showCallState("established");
        startAudio();
        startCallTimer();
        break;
      case "ended":
        els.callStatus.textContent = ev.reason || "Chamada encerrada";
        showCallState("idle");
        stopAudio();
        stopCallTimer();
        setTimeout(() => { if (!callTimerInt) els.callStatus.textContent = ""; }, 4000);
        break;
    }
  }

  // ---------- Botoes de chamada ----------
  els.callBtn.addEventListener("click", () => {
    const target = els.callTarget.value.trim();
    if (!target) { els.callTarget.focus(); return; }
    ensureAudioCtx(); // gesto do usuario: libera o AudioContext
    api.call(target);
  });
  els.hangupBtn.addEventListener("click", () => api.hangup());
  els.answerBtn.addEventListener("click", () => { ensureAudioCtx(); api.answer(); });
  els.rejectBtn.addEventListener("click", () => api.reject());
  els.callTarget.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !els.callBtn.disabled && !els.callBtn.classList.contains("hidden")) {
      e.preventDefault();
      els.callBtn.click();
    }
  });

  // ---------- Init ----------
  loadConfig();
  setSocketOpen(false);
})();
