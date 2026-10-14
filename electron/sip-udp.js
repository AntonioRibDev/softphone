/* Stack SIP sobre UDP minima para o processo principal do Electron.
   Suporta: REGISTER (com digest MD5), OPTIONS, MESSAGE e atua como UAS
   respondendo a requisicoes recebidas (OPTIONS/MESSAGE/INVITE/ACK/BYE).
   Apenas sinalizacao - nao trata midia RTP.

   Emite eventos via callback onEvent({ type, ... }):
     - { type: 'status', state, text }
     - { type: 'sip', direction: 'out'|'in', message, summary }
     - { type: 'log', level, text }
     - { type: 'message', from, body }   (SIP MESSAGE recebido)
*/
const dgram = require("dgram");
const crypto = require("crypto");
const os = require("os");

function md5(str) {
  return crypto.createHash("md5").update(str).digest("hex");
}

function randHex(len) {
  return crypto.randomBytes(len).toString("hex");
}

function getLocalIPv4() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name]) {
      if (iface.family === "IPv4" && !iface.internal) {
        return iface.address;
      }
    }
  }
  return "127.0.0.1";
}

class SipUdpClient {
  constructor(onEvent) {
    this.onEvent = onEvent || (() => {});
    this.socket = null;
    this.config = null;
    this.localIp = getLocalIPv4();
    this.callId = randHex(12) + "@" + this.localIp;
    this.fromTag = randHex(6);
    this.cseq = 1;
    this.registered = false;
    this.reRegisterTimer = null;
    // transacoes pendentes aguardando resposta: branch -> { onResponse, request, retries }
    this.pending = new Map();
    // dialogos recebidos simples para responder BYE etc.
    this.serverDialogs = new Map();
  }

  emit(ev) {
    try { this.onEvent(ev); } catch (e) { /* noop */ }
  }

  status(state, text) {
    this.emit({ type: "status", state, text });
  }

  log(level, text) {
    this.emit({ type: "log", level, text });
  }

  // ---------- Ciclo de vida ----------
  start(config) {
    if (this.socket) this.stop();

    this.config = {
      host: config.host,
      port: parseInt(config.port, 10) || 5060,
      user: config.user,
      domain: config.domain || config.host,
      password: config.password || "",
      displayName: config.displayName || "",
      localPort: parseInt(config.localPort, 10) || 5070,
      expires: parseInt(config.expires, 10) || 300,
    };
    this.callId = randHex(12) + "@" + this.localIp;
    this.fromTag = randHex(6);
    this.cseq = 1;

    return new Promise((resolve, reject) => {
      const socket = dgram.createSocket("udp4");
      this.socket = socket;

      socket.on("error", (err) => {
        this.log("error", "Erro no socket UDP: " + err.message);
        this.status("error", "Erro: " + err.message);
        try { socket.close(); } catch (e) { /* noop */ }
        this.socket = null;
        reject(err);
      });

      socket.on("message", (msg, rinfo) => this.handleDatagram(msg, rinfo));

      socket.bind(this.config.localPort, () => {
        const addr = socket.address();
        this.log("info", "Socket UDP ativo em " + this.localIp + ":" + addr.port);
        this.status("idle", "Socket aberto (nao registrado)");
        resolve({ localIp: this.localIp, localPort: addr.port });
      });
    });
  }

  stop() {
    if (this.registered) {
      try { this.unregister(); } catch (e) { /* noop */ }
    }
    clearTimeout(this.reRegisterTimer);
    this.reRegisterTimer = null;
    this.pending.clear();
    this.serverDialogs.clear();
    this.registered = false;
    if (this.socket) {
      try { this.socket.close(); } catch (e) { /* noop */ }
      this.socket = null;
    }
    this.status("", "Desconectado");
  }

  // ---------- Envio ----------
  sendRaw(message) {
    if (!this.socket) {
      this.log("error", "Socket nao esta aberto.");
      return;
    }
    const buf = Buffer.from(message, "utf8");
    this.socket.send(buf, 0, buf.length, this.config.port, this.config.host, (err) => {
      if (err) this.log("error", "Falha ao enviar: " + err.message);
    });
    this.emit({
      type: "sip",
      direction: "out",
      message: message,
      summary: this.summarize(message),
    });
  }

  sendResponseTo(rinfo, message) {
    if (!this.socket) return;
    const buf = Buffer.from(message, "utf8");
    this.socket.send(buf, 0, buf.length, rinfo.port, rinfo.address, (err) => {
      if (err) this.log("error", "Falha ao responder: " + err.message);
    });
    this.emit({
      type: "sip",
      direction: "out",
      message: message,
      summary: this.summarize(message),
    });
  }

  // ---------- Construcao de requisicoes ----------
  buildVia(branch) {
    return `SIP/2.0/UDP ${this.localIp}:${this.config.localPort};branch=${branch};rport`;
  }

  contactUri() {
    return `<sip:${this.config.user}@${this.localIp}:${this.config.localPort}>`;
  }

  aor() {
    return `sip:${this.config.user}@${this.config.domain}`;
  }

  displayFrom() {
    const dn = this.config.displayName ? `"${this.config.displayName}" ` : "";
    return `${dn}<${this.aor()}>;tag=${this.fromTag}`;
  }

  buildRequest(method, requestUri, opts) {
    opts = opts || {};
    const branch = "z9hG4bK" + randHex(8);
    const cseq = opts.cseq != null ? opts.cseq : this.cseq;
    const lines = [];
    lines.push(`${method} ${requestUri} SIP/2.0`);
    lines.push(`Via: ${this.buildVia(branch)}`);
    lines.push(`Max-Forwards: 70`);
    lines.push(`From: ${this.displayFrom()}`);
    lines.push(`To: ${opts.to || "<" + requestUri + ">"}`);
    lines.push(`Call-ID: ${opts.callId || this.callId}`);
    lines.push(`CSeq: ${cseq} ${method}`);
    lines.push(`Contact: ${this.contactUri()}`);
    if (opts.authHeader) lines.push(opts.authHeader);
    if (opts.extraHeaders) opts.extraHeaders.forEach((h) => lines.push(h));
    lines.push(`User-Agent: Softphone-SIP-UDP/1.0`);
    const body = opts.body || "";
    if (body) {
      lines.push(`Content-Type: ${opts.contentType || "text/plain"}`);
    }
    lines.push(`Content-Length: ${Buffer.byteLength(body, "utf8")}`);
    lines.push("");
    lines.push(body);
    return { message: lines.join("\r\n"), branch, cseq };
  }

  // ---------- Acoes publicas ----------
  register() {
    if (!this.socket) { this.log("error", "Inicie a conexao primeiro."); return; }
    this.status("connecting", "Registrando...");
    this._sendRegister(this.config.expires);
  }

  unregister() {
    if (!this.socket) return;
    this.status("connecting", "Removendo registro...");
    this._sendRegister(0);
  }

  _sendRegister(expires) {
    const uri = `sip:${this.config.domain}`;
    this.cseq += 1;
    const req = this.buildRequest("REGISTER", uri, {
      to: `<${this.aor()}>`,
      cseq: this.cseq,
      extraHeaders: [`Expires: ${expires}`, `Allow: INVITE, ACK, CANCEL, BYE, OPTIONS, MESSAGE`],
    });
    this.pending.set(req.branch, {
      method: "REGISTER",
      request: req,
      expires: expires,
      authed: false,
      uri: uri,
    });
    this.sendRaw(req.message);
  }

  sendOptions(target) {
    if (!this.socket) { this.log("error", "Inicie a conexao primeiro."); return; }
    const uri = this._targetUri(target);
    this.cseq += 1;
    const req = this.buildRequest("OPTIONS", uri, {
      to: `<${uri}>`,
      cseq: this.cseq,
    });
    this.pending.set(req.branch, { method: "OPTIONS", request: req, authed: false, uri });
    this.log("info", "Enviando OPTIONS para " + uri);
    this.sendRaw(req.message);
  }

  sendMessage(target, text) {
    if (!this.socket) { this.log("error", "Inicie a conexao primeiro."); return; }
    const uri = this._targetUri(target);
    this.cseq += 1;
    const req = this.buildRequest("MESSAGE", uri, {
      to: `<${uri}>`,
      cseq: this.cseq,
      body: text,
      contentType: "text/plain",
    });
    this.pending.set(req.branch, {
      method: "MESSAGE", request: req, authed: false, uri, body: text,
    });
    this.log("info", "Enviando MESSAGE para " + uri);
    this.sendRaw(req.message);
  }

  _targetUri(target) {
    if (!target) return `sip:${this.config.domain}`;
    if (target.startsWith("sip:")) return target;
    if (target.includes("@")) return "sip:" + target;
    return `sip:${target}@${this.config.domain}`;
  }

  // ---------- Recepcao ----------
  handleDatagram(msg, rinfo) {
    const text = msg.toString("utf8");
    this.emit({
      type: "sip",
      direction: "in",
      message: text,
      summary: this.summarize(text),
    });

    const parsed = this.parse(text);
    if (!parsed) return;

    if (parsed.isResponse) {
      this.handleResponse(parsed, text, rinfo);
    } else {
      this.handleRequest(parsed, text, rinfo);
    }
  }

  handleResponse(res, raw, rinfo) {
    const branch = this.extractBranch(res.headers["via"]);
    const tx = branch ? this.pending.get(branch) : null;
    const code = res.statusCode;

    if ((code === 401 || code === 407) && tx && !tx.authed) {
      this.handleAuthChallenge(res, tx);
      return;
    }

    if (tx) this.pending.delete(branch);

    if (tx && tx.method === "REGISTER") {
      if (code >= 200 && code < 300) {
        if (tx.expires === 0) {
          this.registered = false;
          this.status("idle", "Registro removido");
          clearTimeout(this.reRegisterTimer);
        } else {
          this.registered = true;
          this.status("connected", "Registrado como " + this.config.user);
          this.scheduleReRegister(tx.expires);
        }
      } else if (code >= 300) {
        this.registered = false;
        this.status("error", `Falha no registro: ${code} ${res.reason}`);
      }
      return;
    }

    if (tx && tx.method === "OPTIONS") {
      this.log(code < 300 ? "ok" : "error", `Resposta OPTIONS: ${code} ${res.reason}`);
      return;
    }
    if (tx && tx.method === "MESSAGE") {
      this.log(code < 300 ? "ok" : "error", `Resposta MESSAGE: ${code} ${res.reason}`);
      return;
    }

    this.log("info", `Resposta ${code} ${res.reason}`);
  }

  handleAuthChallenge(res, tx) {
    const isProxy = res.statusCode === 407;
    const headerName = isProxy ? "proxy-authenticate" : "www-authenticate";
    const challenge = this.parseAuth(res.headers[headerName]);
    if (!challenge) {
      this.log("error", "Desafio de autenticacao invalido.");
      this.pending.delete(tx.request.branch);
      return;
    }

    const method = tx.method;
    const uri = tx.uri;
    const ha1 = md5(`${this.config.user}:${challenge.realm}:${this.config.password}`);
    const ha2 = md5(`${method}:${uri}`);
    let response, cnonce, nc;
    if (challenge.qop && /auth/.test(challenge.qop)) {
      cnonce = randHex(8);
      nc = "00000001";
      response = md5(`${ha1}:${challenge.nonce}:${nc}:${cnonce}:auth:${ha2}`);
    } else {
      response = md5(`${ha1}:${challenge.nonce}:${ha2}`);
    }

    let auth = `Digest username="${this.config.user}", realm="${challenge.realm}", ` +
      `nonce="${challenge.nonce}", uri="${uri}", response="${response}", algorithm=MD5`;
    if (challenge.qop && /auth/.test(challenge.qop)) {
      auth += `, qop=auth, nc=${nc}, cnonce="${cnonce}"`;
    }
    if (challenge.opaque) auth += `, opaque="${challenge.opaque}"`;
    const authHeader = (isProxy ? "Proxy-Authorization: " : "Authorization: ") + auth;

    // Reenvia a mesma requisicao autenticada, novo CSeq e branch.
    this.pending.delete(tx.request.branch);
    this.cseq += 1;
    const opts = {
      to: tx.method === "REGISTER" ? `<${this.aor()}>` : `<${uri}>`,
      cseq: this.cseq,
      authHeader: authHeader,
    };
    if (tx.method === "REGISTER") opts.extraHeaders = [`Expires: ${tx.expires}`];
    if (tx.method === "MESSAGE") { opts.body = tx.body; opts.contentType = "text/plain"; }
    const req = this.buildRequest(method, uri, opts);
    this.pending.set(req.branch, Object.assign({}, tx, { request: req, authed: true }));
    this.sendRaw(req.message);
  }

  handleRequest(req, raw, rinfo) {
    const method = req.method;
    this.log("info", `Requisicao recebida: ${method} de ${rinfo.address}:${rinfo.port}`);

    switch (method) {
      case "OPTIONS":
        this.respond(req, rinfo, 200, "OK", ["Allow: INVITE, ACK, CANCEL, BYE, OPTIONS, MESSAGE"]);
        break;
      case "MESSAGE": {
        const from = this.headerValue(req.headers["from"]);
        this.emit({ type: "message", from: from, body: req.body || "" });
        this.log("ok", "MESSAGE recebido: " + (req.body || "").slice(0, 200));
        this.respond(req, rinfo, 200, "OK");
        break;
      }
      case "INVITE":
        // Sinalizacao apenas: respondemos 200 OK sem midia real (sem RTP).
        this.log("info", "INVITE recebido (sinalizacao apenas, sem RTP).");
        this.respond(req, rinfo, 200, "OK");
        break;
      case "ACK":
        // Sem acao.
        break;
      case "BYE":
        this.respond(req, rinfo, 200, "OK");
        this.log("info", "BYE recebido, chamada encerrada.");
        break;
      case "CANCEL":
        this.respond(req, rinfo, 200, "OK");
        break;
      default:
        this.respond(req, rinfo, 501, "Not Implemented");
    }
  }

  respond(req, rinfo, code, reason, extraHeaders) {
    const lines = [];
    lines.push(`SIP/2.0 ${code} ${reason}`);
    // Espelha Via, From, Call-ID, CSeq; adiciona tag no To.
    (req.viaList || []).forEach((v) => lines.push("Via: " + v));
    lines.push("From: " + this.headerValue(req.headers["from"]));
    let to = this.headerValue(req.headers["to"]);
    if (to && !/;tag=/.test(to)) to += ";tag=" + randHex(6);
    lines.push("To: " + to);
    lines.push("Call-ID: " + this.headerValue(req.headers["call-id"]));
    lines.push("CSeq: " + this.headerValue(req.headers["cseq"]));
    if (extraHeaders) extraHeaders.forEach((h) => lines.push(h));
    lines.push("Content-Length: 0");
    lines.push("");
    lines.push("");
    this.sendResponseTo(rinfo, lines.join("\r\n"));
  }

  scheduleReRegister(expires) {
    clearTimeout(this.reRegisterTimer);
    const ms = Math.max(10, expires - 15) * 1000;
    this.reRegisterTimer = setTimeout(() => {
      if (this.socket) this._sendRegister(this.config.expires);
    }, ms);
  }

  // ---------- Parsing ----------
  parse(text) {
    const idx = text.indexOf("\r\n\r\n");
    const headPart = idx >= 0 ? text.slice(0, idx) : text;
    const body = idx >= 0 ? text.slice(idx + 4) : "";
    const lines = headPart.split("\r\n");
    if (lines.length === 0) return null;
    const first = lines[0];

    const headers = {};
    const viaList = [];
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      const c = line.indexOf(":");
      if (c < 0) continue;
      const name = line.slice(0, c).trim().toLowerCase();
      const value = line.slice(c + 1).trim();
      if (name === "via" || name === "v") viaList.push(value);
      if (headers[name] === undefined) headers[name] = value;
      else headers[name] += ", " + value;
    }

    if (/^SIP\/2\.0/i.test(first)) {
      const m = first.match(/^SIP\/2\.0\s+(\d+)\s*(.*)$/i);
      return {
        isResponse: true,
        statusCode: m ? parseInt(m[1], 10) : 0,
        reason: m ? m[2] : "",
        headers,
        viaList,
        body,
      };
    } else {
      const m = first.match(/^(\w+)\s+(\S+)\s+SIP\/2\.0/i);
      return {
        isResponse: false,
        method: m ? m[1].toUpperCase() : "",
        uri: m ? m[2] : "",
        headers,
        viaList,
        body,
      };
    }
  }

  headerValue(v) { return v || ""; }

  extractBranch(viaValue) {
    if (!viaValue) return null;
    const m = viaValue.match(/branch=([^;,\s]+)/i);
    return m ? m[1] : null;
  }

  parseAuth(value) {
    if (!value) return null;
    const scheme = value.replace(/^(\w+)\s+/, "$1|").split("|");
    const params = {};
    const re = /(\w+)\s*=\s*(?:"([^"]*)"|([^,]+))/g;
    let m;
    while ((m = re.exec(value)) !== null) {
      params[m[1].toLowerCase()] = (m[2] !== undefined ? m[2] : m[3]).trim();
    }
    if (!params.nonce || !params.realm) return null;
    return params;
  }

  summarize(message) {
    const firstLine = message.split("\r\n")[0] || "";
    const cseqMatch = message.match(/^CSeq:\s*(.+)$/im);
    const cseq = cseqMatch ? cseqMatch[1].trim() : "";
    return cseq ? `${firstLine}  [CSeq: ${cseq}]` : firstLine;
  }
}

module.exports = { SipUdpClient };
