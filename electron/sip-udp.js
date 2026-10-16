/* Stack SIP sobre UDP para o processo principal do Electron.
   Suporta: REGISTER (digest MD5), OPTIONS, MESSAGE e chamadas de audio
   (INVITE/ACK/BYE/CANCEL) com midia RTP G.711 via rtp-session.js.
   Atua como UAC e UAS (faz e recebe chamadas).

   Emite eventos via callback onEvent({ type, ... }):
     - { type: 'status', state, text }
     - { type: 'sip', direction: 'out'|'in', message, summary }
     - { type: 'log', level, text }
     - { type: 'message', from, body }            (SIP MESSAGE recebido)
     - { type: 'call', state, ... }               (ciclo de vida da chamada)
         state: 'calling'|'ringing'|'incoming'|'established'|'ended'
*/
const dgram = require("dgram");
const crypto = require("crypto");
const os = require("os");
const { RtpSession, buildSdp, parseSdp } = require("./rtp-session");

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

    // ---- Chamada / midia ----
    this.rtp = null;          // RtpSession ativa
    this.activeCall = null;   // estado da chamada corrente
    this.audioSink = null;    // callback(pcmInt16) para PCM recebido do RTP
    this.callTimer = null;
  }

  // Define para onde vai o audio recebido (PCM Int16) - usado pelo main para
  // encaminhar ao renderer.
  setAudioSink(fn) { this.audioSink = fn; }

  // Recebe um quadro PCM Int16 do renderer (microfone) e envia como RTP.
  writeAudioFrame(int16) {
    if (this.rtp && this.activeCall && this.activeCall.state === "established") {
      this.rtp.sendFrame(int16);
    }
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
    if (this.activeCall) {
      try { this.hangup(); } catch (e) { /* noop */ }
    }
    this._teardownMedia();
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

  // ========================================================================
  // CHAMADAS DE AUDIO (INVITE/ACK/BYE/CANCEL + RTP)
  // ========================================================================

  // Faz uma chamada de saida para o destino.
  async makeCall(target) {
    if (!this.socket) { this.log("error", "Inicie a conexao primeiro."); return; }
    if (this.activeCall) { this.log("error", "Ja existe uma chamada em andamento."); return; }
    const uri = this._targetUri(target);

    // Abre a sessao RTP e monta a oferta SDP.
    this.rtp = new RtpSession(
      (pcm) => { if (this.audioSink) this.audioSink(pcm); },
      (lvl, txt) => this.log(lvl, txt)
    );
    let rtpInfo;
    try {
      rtpInfo = await this.rtp.start();
    } catch (e) {
      this.log("error", "Nao foi possivel abrir RTP: " + e.message);
      this.rtp = null;
      return;
    }

    const sdp = buildSdp(this.localIp, rtpInfo.localPort);
    this.cseq += 1;
    const callId = randHex(12) + "@" + this.localIp;
    const fromTag = randHex(6);

    this.activeCall = {
      direction: "out",
      state: "calling",
      callId: callId,
      fromTag: fromTag,
      toTag: null,
      cseq: this.cseq,
      uri: uri,
      target: target,
      remoteTarget: uri,
      inviteBranch: null,
      localRtpPort: rtpInfo.localPort,
      startTime: null,
    };

    const req = this._buildCallRequest("INVITE", uri, {
      callId: callId,
      fromTag: fromTag,
      cseq: this.cseq,
      body: sdp,
      contentType: "application/sdp",
      extraHeaders: ["Allow: INVITE, ACK, CANCEL, BYE, OPTIONS, MESSAGE"],
    });
    this.activeCall.inviteBranch = req.branch;
    this.pending.set(req.branch, {
      method: "INVITE", request: req, authed: false, uri, body: sdp, isCall: true,
      callId: callId, fromTag: fromTag, cseq: this.cseq, branch: req.branch,
    });

    this.status("connecting", "Chamando " + target + "...");
    this.emit({ type: "call", state: "calling", target: target, direction: "out" });
    this.log("info", "INVITE para " + uri);
    this.sendRaw(req.message);
  }

  // Monta uma requisicao de dialogo (INVITE/BYE/ACK) com tags de chamada.
  _buildCallRequest(method, requestUri, opts) {
    opts = opts || {};
    const branch = opts.branch || ("z9hG4bK" + randHex(8));
    const call = this.activeCall || {};
    const fromTag = opts.fromTag || call.fromTag || this.fromTag;
    const toHeader = opts.toHeader ||
      (call.toTag ? `<${call.remoteTarget || requestUri}>;tag=${call.toTag}` : `<${requestUri}>`);
    const dn = this.config.displayName ? `"${this.config.displayName}" ` : "";

    const lines = [];
    lines.push(`${method} ${requestUri} SIP/2.0`);
    lines.push(`Via: SIP/2.0/UDP ${this.localIp}:${this.config.localPort};branch=${branch};rport`);
    lines.push(`Max-Forwards: 70`);
    lines.push(`From: ${dn}<${this.aor()}>;tag=${fromTag}`);
    lines.push(`To: ${toHeader}`);
    lines.push(`Call-ID: ${opts.callId || call.callId}`);
    lines.push(`CSeq: ${opts.cseq} ${method}`);
    lines.push(`Contact: ${this.contactUri()}`);
    if (opts.authHeader) lines.push(opts.authHeader);
    if (opts.extraHeaders) opts.extraHeaders.forEach((h) => lines.push(h));
    lines.push(`User-Agent: Softphone-SIP-UDP/1.0`);
    const body = opts.body || "";
    if (body) lines.push(`Content-Type: ${opts.contentType || "application/sdp"}`);
    lines.push(`Content-Length: ${Buffer.byteLength(body, "utf8")}`);
    lines.push("");
    lines.push(body);
    return { message: lines.join("\r\n"), branch };
  }

  // Atende uma chamada recebida.
  answer() {
    const call = this.activeCall;
    if (!call || call.direction !== "in" || call.state !== "ringing") {
      this.log("error", "Nao ha chamada para atender.");
      return;
    }
    const sdp = buildSdp(this.localIp, call.localRtpPort);
    this._respondToInvite(call, 200, "OK", sdp);
    call.state = "established";
    call.startTime = Date.now();
    this.status("connected", "Em chamada");
    this.emit({ type: "call", state: "established", direction: "in", target: call.target });
  }

  // Recusa uma chamada recebida.
  reject() {
    const call = this.activeCall;
    if (!call || call.direction !== "in") { return; }
    this._respondToInvite(call, 486, "Busy Here");
    this.log("info", "Chamada recusada.");
    this._endCall("Chamada recusada");
  }

  // Encerra a chamada atual (CANCEL se ainda chamando, BYE se estabelecida).
  hangup() {
    const call = this.activeCall;
    if (!call) return;

    if (call.direction === "out" && call.state === "calling") {
      // CANCEL para a transacao INVITE (mesmo branch/CSeq).
      const cancel = this._buildCallRequest("CANCEL", call.uri, {
        branch: call.inviteBranch,
        callId: call.callId,
        fromTag: call.fromTag,
        cseq: call.cseq,
        toHeader: `<${call.uri}>`,
      });
      this.log("info", "Enviando CANCEL.");
      this.sendRaw(cancel.message);
      // Aguarda 487; encerramos a midia ja.
      this._endCall("Chamada cancelada");
    } else if (call.state === "established") {
      this.cseq += 1;
      const bye = this._buildCallRequest("BYE", call.remoteTarget, {
        callId: call.callId,
        fromTag: call.fromTag,
        cseq: this.cseq,
      });
      this.log("info", "Enviando BYE.");
      this.sendRaw(bye.message);
      this._endCall("Chamada encerrada");
    } else if (call.direction === "in" && call.state === "ringing") {
      this.reject();
    } else {
      this._endCall("Chamada encerrada");
    }
  }

  // Responde a um INVITE recebido (com SDP opcional no 2xx).
  _respondToInvite(call, code, reason, sdp) {
    const req = call.inviteReq;
    if (!req) return;
    const lines = [];
    lines.push(`SIP/2.0 ${code} ${reason}`);
    (req.viaList || []).forEach((v) => lines.push("Via: " + v));
    lines.push("From: " + this.headerValue(req.headers["from"]));
    let to = this.headerValue(req.headers["to"]);
    if (to && !/;tag=/.test(to)) to += ";tag=" + call.toTag;
    lines.push("To: " + to);
    lines.push("Call-ID: " + this.headerValue(req.headers["call-id"]));
    lines.push("CSeq: " + this.headerValue(req.headers["cseq"]));
    lines.push("Contact: " + this.contactUri());
    const body = sdp || "";
    if (body) lines.push("Content-Type: application/sdp");
    lines.push("Content-Length: " + Buffer.byteLength(body, "utf8"));
    lines.push("");
    lines.push(body);
    this.sendResponseTo(call.rinfo, lines.join("\r\n"));
  }

  // ACK para resposta 2xx de INVITE (nova transacao, vai ao Contact remoto).
  _sendAck2xx(call) {
    this.sendRaw(this._buildCallRequest("ACK", call.remoteTarget, {
      callId: call.callId,
      fromTag: call.fromTag,
      cseq: call.cseq, // mesmo numero do INVITE
    }).message);
  }

  // ACK para resposta nao-2xx (mesmo branch do INVITE).
  _sendAckNon2xx(call, res) {
    const toHeader = this.headerValue(res.headers["to"]);
    const msg = this._buildCallRequest("ACK", call.uri, {
      branch: call.inviteBranch,
      callId: call.callId,
      fromTag: call.fromTag,
      cseq: call.cseq,
      toHeader: toHeader,
    }).message;
    this.sendRaw(msg);
  }

  _teardownMedia() {
    if (this.rtp) {
      try { this.rtp.stop(); } catch (e) { /* noop */ }
      this.rtp = null;
    }
  }

  _endCall(reason) {
    this._teardownMedia();
    const call = this.activeCall;
    this.activeCall = null;
    this.emit({ type: "call", state: "ended", reason: reason || "", target: call ? call.target : "" });
    if (this.registered) this.status("connected", "Registrado como " + this.config.user);
    else this.status("idle", "Socket aberto (nao registrado)");
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

    // Respostas de INVITE tem tratamento proprio (1xx/2xx/ACK/auth).
    if (tx && tx.method === "INVITE") {
      this._handleInviteResponse(res, tx, branch);
      return;
    }

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

  _handleInviteResponse(res, tx, branch) {
    const code = res.statusCode;
    const call = this.activeCall;

    // 1xx provisorio.
    if (code >= 100 && code < 200) {
      if (code === 180 || code === 183) {
        if (call) call.state = "ringing";
        this.status("connecting", "Tocando...");
        this.emit({ type: "call", state: "ringing", direction: "out" });
      }
      return; // mantem a transacao pendente
    }

    // 2xx: chamada atendida.
    if (code >= 200 && code < 300) {
      this.pending.delete(branch);
      if (!call) { return; }
      // Captura tag remoto e Contact para ACK/BYE.
      const toTag = this._extractTag(res.headers["to"]);
      if (toTag) call.toTag = toTag;
      const contact = this._extractContactUri(res.headers["contact"]);
      if (contact) call.remoteTarget = contact;

      // Negocia midia pelo SDP da resposta.
      const sdp = parseSdp(res.body);
      if (sdp && this.rtp) {
        this.rtp.setRemote(sdp.ip, sdp.port, sdp.payloadType);
      } else {
        this.log("error", "Resposta sem SDP de audio valido.");
      }

      this._sendAck2xx(call);
      call.state = "established";
      call.startTime = Date.now();
      this.status("connected", "Em chamada");
      this.emit({ type: "call", state: "established", direction: "out", target: call.target });
      return;
    }

    // 401/407: autentica e reenvia o INVITE (apos ACK da resposta).
    if ((code === 401 || code === 407) && !tx.authed) {
      this.pending.delete(branch);
      this._sendAckNon2xx(call || { uri: tx.uri, inviteBranch: tx.branch, callId: tx.callId, fromTag: tx.fromTag, cseq: tx.cseq }, res);
      this._reinviteWithAuth(res, tx);
      return;
    }

    // Outros finais (>=300): ACK e encerra.
    this.pending.delete(branch);
    this._sendAckNon2xx(call || { uri: tx.uri, inviteBranch: tx.branch, callId: tx.callId, fromTag: tx.fromTag, cseq: tx.cseq }, res);
    this.log("error", `Chamada falhou: ${code} ${res.reason}`);
    if (this.activeCall) this._endCall(`Falha: ${code} ${res.reason}`);
    else this._teardownMedia();
  }

  _reinviteWithAuth(res, tx) {
    const isProxy = res.statusCode === 407;
    const headerName = isProxy ? "proxy-authenticate" : "www-authenticate";
    const challenge = this.parseAuth(res.headers[headerName]);
    const call = this.activeCall;
    if (!challenge || !call) { if (call) this._endCall("Falha de autenticacao"); return; }

    const uri = tx.uri;
    const authHeader = this._buildAuthHeader("INVITE", uri, challenge, isProxy);

    this.cseq += 1;
    call.cseq = this.cseq;
    const req = this._buildCallRequest("INVITE", uri, {
      callId: call.callId,
      fromTag: call.fromTag,
      cseq: this.cseq,
      authHeader: authHeader,
      body: tx.body,
      contentType: "application/sdp",
      toHeader: `<${uri}>`,
      extraHeaders: ["Allow: INVITE, ACK, CANCEL, BYE, OPTIONS, MESSAGE"],
    });
    call.inviteBranch = req.branch;
    this.pending.set(req.branch, {
      method: "INVITE", request: req, authed: true, uri, body: tx.body, isCall: true,
      callId: call.callId, fromTag: call.fromTag, cseq: this.cseq, branch: req.branch,
    });
    this.log("info", "Reenviando INVITE autenticado.");
    this.sendRaw(req.message);
  }

  // Monta o header Authorization/Proxy-Authorization para um metodo/uri.
  _buildAuthHeader(method, uri, challenge, isProxy) {
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
    return (isProxy ? "Proxy-Authorization: " : "Authorization: ") + auth;
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
        this._handleIncomingInvite(req, rinfo);
        break;
      case "ACK":
        // ACK confirma nosso 200 OK (chamada de entrada estabelecida).
        if (this.activeCall && this.activeCall.direction === "in" && this.activeCall.state === "established") {
          this.log("info", "ACK recebido, midia ativa.");
        }
        break;
      case "BYE":
        this.respond(req, rinfo, 200, "OK");
        this.log("info", "BYE recebido, chamada encerrada.");
        if (this.activeCall) this._endCall("Encerrada pelo outro lado");
        break;
      case "CANCEL":
        this.respond(req, rinfo, 200, "OK");
        // Cancela um INVITE de entrada ainda tocando: responde 487 ao INVITE.
        if (this.activeCall && this.activeCall.direction === "in" && this.activeCall.state === "ringing") {
          this._respondToInvite(this.activeCall, 487, "Request Terminated");
          this.log("info", "CANCEL recebido, chamada cancelada pelo chamador.");
          this._endCall("Cancelada pelo chamador");
        }
        break;
      default:
        this.respond(req, rinfo, 501, "Not Implemented");
    }
  }

  async _handleIncomingInvite(req, rinfo) {
    // Ja ha chamada ativa? Ocupado.
    if (this.activeCall) {
      this._respondRawInvite(req, rinfo, 486, "Busy Here");
      return;
    }

    const sdp = parseSdp(req.body);
    if (!sdp) {
      this.log("error", "INVITE recebido sem SDP de audio valido.");
      this._respondRawInvite(req, rinfo, 488, "Not Acceptable Here");
      return;
    }

    // Abre RTP e aponta para o ofertante.
    this.rtp = new RtpSession(
      (pcm) => { if (this.audioSink) this.audioSink(pcm); },
      (lvl, txt) => this.log(lvl, txt)
    );
    let rtpInfo;
    try {
      rtpInfo = await this.rtp.start();
    } catch (e) {
      this.log("error", "Nao foi possivel abrir RTP: " + e.message);
      this.rtp = null;
      this._respondRawInvite(req, rinfo, 500, "Server Internal Error");
      return;
    }
    this.rtp.setRemote(sdp.ip, sdp.port, sdp.payloadType);

    const fromHeader = this.headerValue(req.headers["from"]);
    const caller = this._callerId(fromHeader);

    this.activeCall = {
      direction: "in",
      state: "ringing",
      callId: this.headerValue(req.headers["call-id"]),
      fromTag: this._extractTag(fromHeader),   // tag do chamador
      toTag: randHex(6),                        // nosso tag
      remoteTarget: this._extractContactUri(req.headers["contact"]) || sdp.ip,
      inviteReq: req,
      rinfo: rinfo,
      localRtpPort: rtpInfo.localPort,
      target: caller,
    };

    this._respondRawInvite(req, rinfo, 100, "Trying");
    this._respondToInvite(this.activeCall, 180, "Ringing");
    this.status("connecting", "Chamada recebida de " + caller);
    this.emit({ type: "call", state: "incoming", direction: "in", from: caller });
    this.log("info", "INVITE recebido de " + caller);
  }

  // Resposta simples a um INVITE (sem SDP) usando o req cru.
  _respondRawInvite(req, rinfo, code, reason) {
    const lines = [];
    lines.push(`SIP/2.0 ${code} ${reason}`);
    (req.viaList || []).forEach((v) => lines.push("Via: " + v));
    lines.push("From: " + this.headerValue(req.headers["from"]));
    let to = this.headerValue(req.headers["to"]);
    if (to && !/;tag=/.test(to)) to += ";tag=" + randHex(6);
    lines.push("To: " + to);
    lines.push("Call-ID: " + this.headerValue(req.headers["call-id"]));
    lines.push("CSeq: " + this.headerValue(req.headers["cseq"]));
    lines.push("Content-Length: 0");
    lines.push("");
    lines.push("");
    this.sendResponseTo(rinfo, lines.join("\r\n"));
  }

  _callerId(fromHeader) {
    if (!fromHeader) return "desconhecido";
    const dn = fromHeader.match(/^"?([^"<]*?)"?\s*</);
    const uri = fromHeader.match(/sips?:([^@>;]+)/i);
    const user = uri ? uri[1] : "";
    const name = dn && dn[1].trim() ? dn[1].trim() : "";
    if (name && user) return `${name} (${user})`;
    return user || name || "desconhecido";
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

  _extractTag(headerValue) {
    if (!headerValue) return null;
    const m = headerValue.match(/;tag=([^;,\s>]+)/i);
    return m ? m[1] : null;
  }

  // Extrai a URI de um header Contact (ex.: "<sip:1001@1.2.3.4:5060>" -> sip:1001@1.2.3.4:5060)
  _extractContactUri(headerValue) {
    if (!headerValue) return null;
    const m = headerValue.match(/<([^>]+)>/);
    if (m) return m[1];
    const m2 = headerValue.match(/(sips?:[^;,\s]+)/i);
    return m2 ? m2[1] : null;
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
