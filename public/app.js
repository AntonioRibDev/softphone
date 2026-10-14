/* Softphone SIP - logica principal usando JsSIP (SIP over WebSocket + WebRTC) */
(function () {
  "use strict";

  if (typeof JsSIP === "undefined") {
    alert("Falha ao carregar a biblioteca JsSIP. Verifique sua conexão com a internet.");
    return;
  }

  // JsSIP.debug.enable('JsSIP:*'); // descomente para logs detalhados

  // ---------- Referencias do DOM ----------
  const $ = (id) => document.getElementById(id);

  const els = {
    regStatus: $("regStatus"),
    regDot: $("regDot"),
    regText: $("regText"),
    configForm: $("configForm"),
    wsUri: $("wsUri"),
    sipUser: $("sipUser"),
    sipDomain: $("sipDomain"),
    sipPassword: $("sipPassword"),
    displayName: $("displayName"),
    rememberMe: $("rememberMe"),
    iceServers: $("iceServers"),
    connectBtn: $("connectBtn"),
    disconnectBtn: $("disconnectBtn"),
    dialInput: $("dialInput"),
    callInfo: $("callInfo"),
    callTimer: $("callTimer"),
    dialpad: $("dialpad"),
    callBtn: $("callBtn"),
    hangupBtn: $("hangupBtn"),
    answerBtn: $("answerBtn"),
    rejectBtn: $("rejectBtn"),
    inCallControls: $("inCallControls"),
    muteBtn: $("muteBtn"),
    holdBtn: $("holdBtn"),
    backspaceBtn: $("backspaceBtn"),
    callLog: $("callLog"),
    clearLogBtn: $("clearLogBtn"),
    remoteAudio: $("remoteAudio"),
  };

  // ---------- Estado ----------
  let ua = null;            // JsSIP.UA
  let currentSession = null; // sessao de chamada ativa
  let timerInterval = null;
  let callStartTime = null;
  const STORAGE_KEY = "sip-softphone-config";
  const LOG_KEY = "sip-softphone-log";

  // ---------- Persistencia de configuracao ----------
  function loadConfig() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
      if (!saved) return;
      els.wsUri.value = saved.wsUri || "";
      els.sipUser.value = saved.sipUser || "";
      els.sipDomain.value = saved.sipDomain || "";
      els.sipPassword.value = saved.sipPassword || "";
      els.displayName.value = saved.displayName || "";
      els.iceServers.value = saved.iceServers || "";
      els.rememberMe.checked = saved.rememberMe !== false;
    } catch (e) {
      console.warn("Não foi possível carregar a configuração salva", e);
    }
  }

  function saveConfig() {
    if (!els.rememberMe.checked) {
      localStorage.removeItem(STORAGE_KEY);
      return;
    }
    const cfg = {
      wsUri: els.wsUri.value.trim(),
      sipUser: els.sipUser.value.trim(),
      sipDomain: els.sipDomain.value.trim(),
      sipPassword: els.sipPassword.value,
      displayName: els.displayName.value.trim(),
      iceServers: els.iceServers.value.trim(),
      rememberMe: true,
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg));
  }

  // ---------- Status de registro ----------
  function setStatus(state, text) {
    els.regStatus.className = "status " + state;
    els.regText.textContent = text;
  }

  // ---------- Construcao das opcoes de ICE ----------
  function buildIceServers() {
    const lines = els.iceServers.value
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    if (lines.length === 0) {
      return [{ urls: "stun:stun.l.google.com:19302" }];
    }
    return lines.map((line) => {
      // formato opcional: url|usuario|senha (para TURN)
      const parts = line.split("|").map((p) => p.trim());
      const server = { urls: parts[0] };
      if (parts[1]) server.username = parts[1];
      if (parts[2]) server.credential = parts[2];
      return server;
    });
  }

  // ---------- Captura de SIP bruto (para a tela de Logs SIP) ----------
  // Envolve o WebSocketInterface do JsSIP: intercepta o envio (send) e a
  // recepcao (ondata) sem depender de logs de debug. Alimenta window.SipLog.
  function hookSipTrace(socket) {
    if (!socket || socket._sipTraceHooked) return;
    socket._sipTraceHooked = true;

    const push = (direction, message) => {
      try {
        if (!window.SipLog) return;
        if (typeof message !== "string") return;
        const trimmed = message.replace(/\r\n/g, "\n");
        // Ignora keep-alives (CRLF).
        if (trimmed.trim() === "") return;
        window.SipLog.add({ source: "WSS", direction: direction, message: message });
      } catch (e) { /* noop */ }
    };

    // Envio.
    const origSend = socket.send.bind(socket);
    socket.send = function (message) {
      push("out", message);
      return origSend(message);
    };

    // Recepcao: o Transport do JsSIP atribui socket.ondata; interceptamos a atribuicao.
    let _ondata = null;
    try {
      Object.defineProperty(socket, "ondata", {
        configurable: true,
        enumerable: true,
        get() { return _ondata; },
        set(fn) {
          _ondata = function (data) {
            let text = data;
            if (typeof text !== "string") {
              try { text = new TextDecoder("utf-8").decode(data); } catch (e) { text = null; }
            }
            if (text) push("in", text);
            return fn.apply(this, arguments);
          };
        },
      });
    } catch (e) {
      console.warn("Não foi possível interceptar recepção SIP:", e);
    }
  }

  // ---------- Conexao / Registro ----------
  function connect() {
    const wsUri = els.wsUri.value.trim();
    const user = els.sipUser.value.trim();
    const domain = els.sipDomain.value.trim();
    const password = els.sipPassword.value;
    const displayName = els.displayName.value.trim();

    if (!wsUri || !user || !domain || !password) {
      alert("Preencha servidor WSS, usuário, domínio e senha.");
      return;
    }

    saveConfig();

    try {
      const socket = new JsSIP.WebSocketInterface(wsUri);
      hookSipTrace(socket);
      const configuration = {
        sockets: [socket],
        uri: `sip:${user}@${domain}`,
        password: password,
        display_name: displayName || undefined,
        register: true,
        session_timers: false,
      };

      ua = new JsSIP.UA(configuration);
      attachUaEvents();
      ua.start();
      setStatus("connecting", "Conectando...");
      els.connectBtn.disabled = true;
      els.disconnectBtn.disabled = false;
    } catch (err) {
      console.error(err);
      setStatus("error", "Erro: " + err.message);
      els.connectBtn.disabled = false;
    }
  }

  function disconnect() {
    if (currentSession) {
      try { currentSession.terminate(); } catch (e) { /* noop */ }
    }
    if (ua) {
      ua.stop();
      ua = null;
    }
    setStatus("", "Desconectado");
    els.connectBtn.disabled = false;
    els.disconnectBtn.disabled = true;
    els.callBtn.disabled = true;
  }

  // ---------- Eventos da UA ----------
  function attachUaEvents() {
    ua.on("connecting", () => setStatus("connecting", "Conectando ao servidor..."));
    ua.on("connected", () => setStatus("connecting", "Conectado, registrando..."));
    ua.on("disconnected", () => {
      setStatus("error", "WebSocket desconectado");
      els.callBtn.disabled = true;
    });
    ua.on("registered", () => {
      setStatus("connected", "Registrado como " + els.sipUser.value.trim());
      els.callBtn.disabled = false;
    });
    ua.on("unregistered", () => {
      setStatus("", "Não registrado");
      els.callBtn.disabled = true;
    });
    ua.on("registrationFailed", (e) => {
      setStatus("error", "Falha no registro: " + (e.cause || "desconhecido"));
      els.callBtn.disabled = true;
    });

    // Chamada recebida ou iniciada
    ua.on("newRTCSession", (data) => {
      const session = data.session;

      // Se ja existe uma chamada ativa, recusa a nova
      if (currentSession && currentSession !== session) {
        session.terminate({ status_code: 486, reason_phrase: "Busy Here" });
        return;
      }

      currentSession = session;
      bindSessionEvents(session);

      if (session.direction === "incoming") {
        handleIncoming(session);
      }
    });
  }

  // ---------- Chamada recebida ----------
  function handleIncoming(session) {
    const from = session.remote_identity.uri.user || "desconhecido";
    const name = session.remote_identity.display_name || from;
    els.callInfo.textContent = "Chamada recebida de " + name + " (" + from + ")";
    showState("incoming");
    setStatus("connecting", "Tocando...");

    session._sp_logged = false;
    session._sp_number = from;
    session._sp_direction = "in";
  }

  // ---------- Liga eventos da sessao ----------
  function bindSessionEvents(session) {
    session.on("peerconnection", (e) => {
      const pc = e.peerconnection;
      pc.addEventListener("track", (ev) => {
        if (ev.streams && ev.streams[0]) {
          els.remoteAudio.srcObject = ev.streams[0];
        }
      });
    });

    session.on("connecting", () => els.callInfo.textContent = "Conectando...");
    session.on("progress", () => {
      els.callInfo.textContent = session.direction === "outgoing" ? "Chamando..." : els.callInfo.textContent;
    });

    session.on("accepted", () => {
      els.callInfo.textContent = "Em chamada";
      startTimer();
      setStatus("connected", "Em chamada");
    });
    session.on("confirmed", () => {
      attachRemoteStream(session);
    });

    session.on("ended", (e) => endCall("Chamada encerrada", e));
    session.on("failed", (e) => endCall("Chamada falhou: " + (e.cause || ""), e));
  }

  function attachRemoteStream(session) {
    try {
      const pc = session.connection;
      if (!pc) return;
      const remoteStream = new MediaStream();
      pc.getReceivers().forEach((receiver) => {
        if (receiver.track) remoteStream.addTrack(receiver.track);
      });
      els.remoteAudio.srcObject = remoteStream;
    } catch (e) {
      console.warn("Falha ao anexar áudio remoto", e);
    }
  }

  // ---------- Acoes de chamada ----------
  function makeCall() {
    const target = els.dialInput.value.trim();
    if (!target) {
      els.dialInput.focus();
      return;
    }
    if (!ua || !ua.isRegistered()) {
      alert("Você precisa estar registrado para fazer chamadas.");
      return;
    }

    const domain = els.sipDomain.value.trim();
    const uri = target.includes("@") ? "sip:" + target : `sip:${target}@${domain}`;

    const options = {
      mediaConstraints: { audio: true, video: false },
      pcConfig: { iceServers: buildIceServers() },
    };

    try {
      const session = ua.call(uri, options);
      session._sp_number = target;
      session._sp_direction = "out";
      els.callInfo.textContent = "Ligando para " + target + "...";
      showState("in-call");
    } catch (err) {
      console.error(err);
      els.callInfo.textContent = "Erro ao ligar: " + err.message;
    }
  }

  function answerCall() {
    if (!currentSession) return;
    currentSession.answer({
      mediaConstraints: { audio: true, video: false },
      pcConfig: { iceServers: buildIceServers() },
    });
    showState("in-call");
  }

  function hangup() {
    if (currentSession) {
      try { currentSession.terminate(); } catch (e) { /* noop */ }
    }
  }

  function rejectCall() {
    if (currentSession) {
      try {
        currentSession.terminate({ status_code: 486, reason_phrase: "Busy Here" });
      } catch (e) { /* noop */ }
    }
  }

  function endCall(message, event) {
    els.callInfo.textContent = message;
    stopTimer();
    logCall(currentSession, event);
    showState("idle");
    if (ua && ua.isRegistered()) {
      setStatus("connected", "Registrado como " + els.sipUser.value.trim());
    }
    currentSession = null;
    resetToggles();
    setTimeout(() => { els.callInfo.textContent = ""; }, 4000);
  }

  // ---------- Mute / Hold ----------
  function toggleMute() {
    if (!currentSession) return;
    const muted = currentSession.isMuted().audio;
    if (muted) {
      currentSession.unmute({ audio: true });
      els.muteBtn.classList.remove("active");
    } else {
      currentSession.mute({ audio: true });
      els.muteBtn.classList.add("active");
    }
  }

  function toggleHold() {
    if (!currentSession) return;
    const onHold = currentSession.isOnHold().local;
    if (onHold) {
      currentSession.unhold();
      els.holdBtn.classList.remove("active");
    } else {
      currentSession.hold();
      els.holdBtn.classList.add("active");
    }
  }

  function resetToggles() {
    els.muteBtn.classList.remove("active");
    els.holdBtn.classList.remove("active");
  }

  // ---------- DTMF ----------
  function sendDtmf(tone) {
    if (currentSession && currentSession.isEstablished()) {
      currentSession.sendDTMF(tone);
    }
  }

  // ---------- Timer ----------
  function startTimer() {
    callStartTime = Date.now();
    timerInterval = setInterval(() => {
      const elapsed = Math.floor((Date.now() - callStartTime) / 1000);
      const m = String(Math.floor(elapsed / 60)).padStart(2, "0");
      const s = String(elapsed % 60).padStart(2, "0");
      els.callTimer.textContent = m + ":" + s;
    }, 1000);
  }

  function stopTimer() {
    clearInterval(timerInterval);
    timerInterval = null;
    els.callTimer.textContent = "";
  }

  // ---------- Controle de UI por estado ----------
  function showState(state) {
    // idle | incoming | in-call
    const hide = (el) => el.classList.add("hidden");
    const show = (el) => el.classList.remove("hidden");

    hide(els.callBtn); hide(els.hangupBtn); hide(els.answerBtn); hide(els.rejectBtn);
    els.inCallControls.style.visibility = "hidden";

    if (state === "idle") {
      show(els.callBtn);
    } else if (state === "incoming") {
      show(els.answerBtn);
      show(els.rejectBtn);
    } else if (state === "in-call") {
      show(els.hangupBtn);
      els.inCallControls.style.visibility = "visible";
    }
  }

  // ---------- Historico de chamadas ----------
  function getLog() {
    try { return JSON.parse(localStorage.getItem(LOG_KEY) || "[]"); }
    catch (e) { return []; }
  }

  function logCall(session, event) {
    if (!session || session._sp_logged) return;
    session._sp_logged = true;

    const established = !!callStartTime;
    let direction = session._sp_direction || "out";
    if (direction === "in" && !established) direction = "missed";

    const entry = {
      number: session._sp_number || "?",
      direction: direction,
      time: Date.now(),
    };
    const log = getLog();
    log.unshift(entry);
    if (log.length > 50) log.length = 50;
    localStorage.setItem(LOG_KEY, JSON.stringify(log));
    renderLog();
  }

  function renderLog() {
    const log = getLog();
    els.callLog.innerHTML = "";
    if (log.length === 0) {
      els.callLog.innerHTML = '<li class="empty">Nenhuma chamada ainda</li>';
      return;
    }
    const icons = { in: "&#8601;", out: "&#8599;", missed: "&#8601;" };
    log.forEach((entry) => {
      const li = document.createElement("li");
      const date = new Date(entry.time);
      const timeStr = date.toLocaleString("pt-BR", {
        day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit",
      });
      li.innerHTML =
        '<span class="dir ' + entry.direction + '">' + (icons[entry.direction] || "") + "</span>" +
        '<span class="num">' + escapeHtml(entry.number) + "</span>" +
        '<span class="time">' + timeStr + "</span>" +
        '<button class="redial" title="Rediscar">&#8635;</button>';
      li.querySelector(".redial").addEventListener("click", () => {
        els.dialInput.value = entry.number;
      });
      els.callLog.appendChild(li);
    });
  }

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }

  // ---------- Listeners da UI ----------
  els.configForm.addEventListener("submit", (e) => {
    e.preventDefault();
    connect();
  });
  els.disconnectBtn.addEventListener("click", disconnect);
  els.callBtn.addEventListener("click", makeCall);
  els.hangupBtn.addEventListener("click", hangup);
  els.answerBtn.addEventListener("click", answerCall);
  els.rejectBtn.addEventListener("click", rejectCall);
  els.muteBtn.addEventListener("click", toggleMute);
  els.holdBtn.addEventListener("click", toggleHold);
  els.backspaceBtn.addEventListener("click", () => {
    els.dialInput.value = els.dialInput.value.slice(0, -1);
  });
  els.clearLogBtn.addEventListener("click", () => {
    localStorage.removeItem(LOG_KEY);
    renderLog();
  });

  // Dialpad: digita no campo e envia DTMF se em chamada
  els.dialpad.addEventListener("click", (e) => {
    const key = e.target.closest(".key");
    if (!key) return;
    const digit = key.dataset.key;
    if (currentSession && currentSession.isEstablished()) {
      sendDtmf(digit);
    }
    els.dialInput.value += digit;
  });

  // Enter no campo de discagem liga
  els.dialInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !els.callBtn.disabled) {
      e.preventDefault();
      makeCall();
    }
  });

  // Teclado fisico durante chamada estabelecida envia DTMF
  document.addEventListener("keydown", (e) => {
    if (document.activeElement === els.dialInput) return;
    if (currentSession && currentSession.isEstablished() && /^[0-9*#]$/.test(e.key)) {
      sendDtmf(e.key);
    }
  });

  // ---------- Deteccao de ambiente desktop (Electron) ----------
  function setupDesktopBadge() {
    if (!window.softphoneDesktop || !window.softphoneDesktop.isDesktop) return;
    const brand = document.querySelector(".brand");
    if (!brand) return;
    const badge = document.createElement("span");
    badge.className = "desktop-badge";
    badge.textContent = "Desktop";
    badge.title = "Electron " + (window.softphoneDesktop.versions.electron || "");
    brand.appendChild(badge);
  }

  // ---------- Inicializacao ----------
  loadConfig();
  renderLog();
  showState("idle");
  setStatus("", "Desconectado");
  setupDesktopBadge();
})();
