/* Tela unificada de logs SIP. Reune mensagens SIP das duas origens:
   - WebRTC/WSS (JsSIP) -> alimentado por app.js via SipLog.add
   - SIP UDP (Electron)  -> alimentado por udp.js via SipLog.add
   Expondo window.SipLog. Funciona tanto na web quanto no desktop. */
(function () {
  "use strict";

  const MAX_ENTRIES = 800;
  const entries = [];
  let seq = 0;

  let filterSource = "all"; // all | WSS | UDP
  let search = "";
  let showRaw = false;
  let autoScroll = true;
  let paused = false;

  const el = {};

  function $(id) { return document.getElementById(id); }

  function ready() {
    el.list = $("sipLogList");
    el.count = $("sipLogCount");
    el.source = $("sipLogSource");
    el.search = $("sipLogSearch");
    el.raw = $("sipLogRaw");
    el.auto = $("sipLogAuto");
    el.pause = $("sipLogPause");
    el.copy = $("sipLogCopy");
    el.clear = $("sipLogClear");
    if (!el.list) return false;

    el.source.addEventListener("change", () => { filterSource = el.source.value; rebuild(); });
    el.search.addEventListener("input", () => { search = el.search.value.trim().toLowerCase(); rebuild(); });
    el.raw.addEventListener("change", () => {
      showRaw = el.raw.checked;
      el.list.classList.toggle("show-raw", showRaw);
    });
    el.auto.addEventListener("change", () => { autoScroll = el.auto.checked; });
    el.pause.addEventListener("click", () => {
      paused = !paused;
      el.pause.textContent = paused ? "Retomar" : "Pausar";
      el.pause.classList.toggle("active", paused);
      if (!paused) rebuild();
    });
    el.copy.addEventListener("click", copyAll);
    el.clear.addEventListener("click", clear);
    return true;
  }

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }

  function pad(n) { return String(n).padStart(2, "0"); }
  function timeStr(d) {
    return pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" + pad(d.getSeconds()) +
      "." + String(d.getMilliseconds()).padStart(3, "0");
  }

  function summarize(message) {
    const lines = String(message).split(/\r?\n/);
    const first = (lines[0] || "").trim();
    const cseq = (String(message).match(/^CSeq:\s*(.+)$/im) || [])[1];
    return cseq ? first + "   [CSeq: " + cseq.trim() + "]" : first;
  }

  function matches(entry) {
    if (filterSource !== "all" && entry.source !== filterSource) return false;
    if (search) {
      const hay = (entry.source + " " + entry.summary + " " + entry.message).toLowerCase();
      if (hay.indexOf(search) === -1) return false;
    }
    return true;
  }

  function makeNode(entry) {
    const node = document.createElement("div");
    node.className = "sip-entry " + entry.direction;
    node.dataset.id = entry.id;

    const arrow = entry.direction === "out" ? "&#8594;"
      : entry.direction === "in" ? "&#8592;"
      : entry.direction === "error" ? "&#10006;" : "&#8226;";
    const label = entry.direction === "out" ? "Enviado"
      : entry.direction === "in" ? "Recebido"
      : entry.direction === "error" ? "Erro" : "Info";

    const meta = document.createElement("div");
    meta.className = "meta";
    meta.innerHTML =
      '<span class="left">' +
        '<span class="badge ' + entry.source + '">' + entry.source + "</span>" +
        '<span class="arrow">' + arrow + " " + label + "</span>" +
        '<span class="summary">' + escapeHtml(entry.summary) + "</span>" +
      "</span>" +
      '<span class="time">' + entry.timeText + "</span>";
    node.appendChild(meta);

    if (entry.message) {
      const raw = document.createElement("pre");
      raw.className = "raw";
      raw.textContent = entry.message;
      node.appendChild(raw);
      // clique no cabecalho expande/recolhe individualmente
      meta.style.cursor = "pointer";
      meta.addEventListener("click", () => node.classList.toggle("expanded"));
    }
    return node;
  }

  function updateCount() {
    if (!el.count) return;
    const shown = el.list.childElementCount;
    el.count.textContent = entries.length + " mensagem(ns)" +
      (shown !== entries.length ? "  (" + shown + " exibida(s))" : "");
  }

  function appendNode(entry) {
    const node = makeNode(entry);
    el.list.appendChild(node);
    if (autoScroll) el.list.scrollTop = el.list.scrollHeight;
  }

  function rebuild() {
    if (!el.list) return;
    el.list.innerHTML = "";
    const frag = document.createDocumentFragment();
    entries.forEach((e) => { if (matches(e)) frag.appendChild(makeNode(e)); });
    el.list.appendChild(frag);
    if (autoScroll) el.list.scrollTop = el.list.scrollHeight;
    updateCount();
  }

  // ---------- API publica ----------
  function add(item) {
    if (!item || !item.message && !item.summary) return;
    const now = new Date();
    const entry = {
      id: ++seq,
      source: item.source || "WSS",
      direction: item.direction || "info",
      message: item.message || "",
      summary: item.summary || summarize(item.message || ""),
      time: now.getTime(),
      timeText: timeStr(now),
    };
    entries.push(entry);
    if (entries.length > MAX_ENTRIES) {
      entries.splice(0, entries.length - MAX_ENTRIES);
      if (!paused && el.list) rebuild();
      return;
    }
    if (!paused && el.list && matches(entry)) {
      appendNode(entry);
      updateCount();
    } else if (!paused && el.list) {
      updateCount();
    }
  }

  function clear() {
    entries.length = 0;
    if (el.list) el.list.innerHTML = "";
    updateCount();
  }

  function copyAll() {
    const text = entries.filter(matches).map((e) =>
      "==== [" + e.source + "] " + (e.direction === "out" ? "ENVIADO" : e.direction === "in" ? "RECEBIDO" : e.direction.toUpperCase()) +
      " " + e.timeText + " ====\n" + e.message).join("\n\n");
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(
        () => flashCopy("Copiado!"),
        () => flashCopy("Falha ao copiar")
      );
    } else {
      flashCopy("Sem acesso à área de transferência");
    }
  }

  function flashCopy(msg) {
    if (!el.copy) return;
    const original = el.copy.textContent;
    el.copy.textContent = msg;
    setTimeout(() => { el.copy.textContent = original; }, 1500);
  }

  window.SipLog = { add, clear };

  // Inicializa quando o DOM estiver pronto.
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => { if (ready()) rebuild(); });
  } else {
    if (ready()) rebuild();
  }
})();
