/* Sessao RTP para chamadas de audio sobre UDP (G.711 PCMU/PCMA).
   - Abre um socket UDP para RTP.
   - Monta/parseia pacotes RTP.
   - Codifica/decodifica G.711 via alawmulaw.
   - Recebe quadros PCM (Int16) do chamador e envia como RTP; emite PCM recebido.

   Trabalha com audio de 8 kHz, mono, quadros de 20 ms (160 amostras).
*/
const dgram = require("dgram");
const crypto = require("crypto");
const { mulaw, alaw } = require("alawmulaw");

const PT_PCMU = 0;
const PT_PCMA = 8;
const SAMPLES_PER_FRAME = 160; // 20 ms @ 8 kHz

class RtpSession {
  constructor(onPcm, onLog) {
    this.onPcm = onPcm || (() => {});
    this.onLog = onLog || (() => {});
    this.socket = null;
    this.localPort = 0;
    this.remoteIp = null;
    this.remotePort = 0;
    this.payloadType = PT_PCMU;
    this.seq = Math.floor(Math.random() * 0xffff);
    this.timestamp = Math.floor(Math.random() * 0xffffffff);
    this.ssrc = crypto.randomBytes(4).readUInt32BE(0);
    this.firstPacket = true;
    this.running = false;
  }

  // Abre o socket RTP. Tenta uma porta par dentro de uma faixa.
  start(preferredPort) {
    return new Promise((resolve, reject) => {
      const socket = dgram.createSocket("udp4");
      this.socket = socket;

      socket.on("error", (err) => {
        this.onLog("error", "Erro no socket RTP: " + err.message);
        try { socket.close(); } catch (e) { /* noop */ }
        if (!this.running) reject(err);
      });

      socket.on("message", (msg, rinfo) => this._onMessage(msg, rinfo));

      const tryBind = (port, attemptsLeft) => {
        socket.once("error", (err) => {
          if (err.code === "EADDRINUSE" && attemptsLeft > 0) {
            tryBind(port + 2, attemptsLeft - 1);
          } else {
            reject(err);
          }
        });
        socket.bind(port, () => {
          this.localPort = socket.address().port;
          this.running = true;
          this.onLog("info", "RTP escutando na porta " + this.localPort);
          resolve({ localPort: this.localPort });
        });
      };

      // Porta par preferencial (RTP usa porta par por convencao).
      let base = preferredPort || (40000 + (Math.floor(Math.random() * 4000) * 2));
      if (base % 2 !== 0) base += 1;
      tryBind(base, 10);
    });
  }

  setRemote(ip, port, payloadType) {
    this.remoteIp = ip;
    this.remotePort = port;
    if (payloadType === PT_PCMU || payloadType === PT_PCMA) {
      this.payloadType = payloadType;
    }
    this.onLog("info", "RTP remoto: " + ip + ":" + port + " (PT " + this.payloadType + ")");
  }

  // Recebe um quadro PCM Int16 (160 amostras) e envia como RTP.
  sendFrame(int16) {
    if (!this.socket || !this.remoteIp || !this.remotePort) return;
    if (!int16 || int16.length === 0) return;

    let payload;
    if (this.payloadType === PT_PCMA) {
      payload = Buffer.from(alaw.encode(int16).buffer);
    } else {
      payload = Buffer.from(mulaw.encode(int16).buffer);
    }

    const header = Buffer.alloc(12);
    header[0] = 0x80; // versao 2, sem padding/extensao
    header[1] = (this.firstPacket ? 0x80 : 0x00) | (this.payloadType & 0x7f); // marker no 1o pacote
    header.writeUInt16BE(this.seq & 0xffff, 2);
    header.writeUInt32BE(this.timestamp >>> 0, 4);
    header.writeUInt32BE(this.ssrc >>> 0, 8);

    const packet = Buffer.concat([header, payload]);
    this.socket.send(packet, this.remotePort, this.remoteIp, (err) => {
      if (err) this.onLog("error", "Falha ao enviar RTP: " + err.message);
    });

    this.seq = (this.seq + 1) & 0xffff;
    this.timestamp = (this.timestamp + SAMPLES_PER_FRAME) >>> 0;
    this.firstPacket = false;
  }

  _onMessage(msg, rinfo) {
    if (!msg || msg.length < 12) return;
    const version = (msg[0] >> 6) & 0x03;
    if (version !== 2) return;

    const cc = msg[0] & 0x0f; // CSRC count
    const hasExt = (msg[0] & 0x10) !== 0;
    const pt = msg[1] & 0x7f;

    let offset = 12 + cc * 4;
    if (hasExt) {
      if (msg.length < offset + 4) return;
      const extLen = msg.readUInt16BE(offset + 2); // em palavras de 32 bits
      offset += 4 + extLen * 4;
    }
    if (offset >= msg.length) return;

    const payload = msg.subarray(offset);
    const u8 = new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength);

    let pcm;
    try {
      if (pt === PT_PCMA) pcm = alaw.decode(u8);
      else if (pt === PT_PCMU) pcm = mulaw.decode(u8);
      else return; // payload nao suportado (ex.: DTMF telephone-event)
    } catch (e) {
      return;
    }
    this.onPcm(pcm);
  }

  stop() {
    this.running = false;
    if (this.socket) {
      try { this.socket.close(); } catch (e) { /* noop */ }
      this.socket = null;
    }
    this.remoteIp = null;
    this.remotePort = 0;
    this.firstPacket = true;
  }
}

// ---------- Helpers de SDP ----------

// Monta uma oferta/resposta SDP para audio G.711.
function buildSdp(localIp, rtpPort) {
  const sessId = Math.floor(Date.now() / 1000);
  return [
    "v=0",
    `o=- ${sessId} ${sessId} IN IP4 ${localIp}`,
    "s=Softphone",
    `c=IN IP4 ${localIp}`,
    "t=0 0",
    `m=audio ${rtpPort} RTP/AVP 0 8 101`,
    "a=rtpmap:0 PCMU/8000",
    "a=rtpmap:8 PCMA/8000",
    "a=rtpmap:101 telephone-event/8000",
    "a=fmtp:101 0-16",
    "a=ptime:20",
    "a=sendrecv",
    "",
  ].join("\r\n");
}

// Extrai IP, porta e payload-type de audio preferido de um corpo SDP.
function parseSdp(sdp) {
  if (!sdp) return null;
  const lines = sdp.split(/\r?\n/);
  let sessionIp = null;
  let audioPort = 0;
  let payloads = [];
  let inAudio = false;

  for (const line of lines) {
    if (line.startsWith("c=IN IP4 ")) {
      const ip = line.substring(9).trim().split("/")[0];
      if (!inAudio || !sessionIp) sessionIp = ip;
      if (inAudio) sessionIp = ip; // c= dentro da midia tem prioridade
    } else if (line.startsWith("m=audio ")) {
      inAudio = true;
      const parts = line.split(/\s+/);
      audioPort = parseInt(parts[1], 10) || 0;
      payloads = parts.slice(3).map((p) => parseInt(p, 10)).filter((n) => !isNaN(n));
    } else if (line.startsWith("m=") && !line.startsWith("m=audio")) {
      inAudio = false;
    }
  }

  // Escolhe PCMU (0) se oferecido, senao PCMA (8), senao o primeiro payload.
  let pt = null;
  if (payloads.includes(PT_PCMU)) pt = PT_PCMU;
  else if (payloads.includes(PT_PCMA)) pt = PT_PCMA;
  else if (payloads.length) pt = payloads[0];

  if (!sessionIp || !audioPort || pt === null) return null;
  return { ip: sessionIp, port: audioPort, payloadType: pt, payloads };
}

module.exports = { RtpSession, buildSdp, parseSdp, PT_PCMU, PT_PCMA, SAMPLES_PER_FRAME };
