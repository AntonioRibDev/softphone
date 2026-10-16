# Softphone SIP (Web + Desktop)

Softphone que usa **JsSIP** (SIP sobre WebSocket + WebRTC). Roda de duas formas com o **mesmo código**:

- **Web**: aberto no navegador, servido por um servidor estático.
- **Desktop**: empacotado com **Electron** (ideal para testar aplicações no FreeSWITCH).

Permite registrar uma conta SIP, fazer e receber chamadas de voz, com dialpad, mudo, espera (hold), envio de DTMF e histórico de chamadas.

## Como funciona

```
Web      :  Navegador (WebRTC + JsSIP)        --- WS/WSS --->  FreeSWITCH / Asterisk / Kamailio
Desktop  :  Electron (Chromium + JsSIP)       --- WS/WSS --->  FreeSWITCH / Asterisk / Kamailio
```

- A sinalização SIP trafega por **WebSocket (WS/WSS)**.
- O áudio trafega por **WebRTC** (com STUN/TURN quando necessário).
- Não há backend próprio: a interface é a mesma pasta `public/` nas duas formas.

### Sobre SIP via UDP

Tanto no navegador quanto no Electron, por baixo é o **Chromium**, que **não fala SIP sobre UDP** diretamente: a sinalização é sempre **WebSocket** e a mídia é **WebRTC**. Isso não é problema para o FreeSWITCH, que suporta WebSocket nativamente (mod_sofia) e trata o endpoint WebRTC como um ramal normal — o comportamento das aplicações/dialplan é idêntico ao de um ramal UDP. O "UDP clássico" continua existindo do servidor para frente (troncos, gateways).

## Requisitos

- **Node.js** (para servir a versão web e para rodar/empacotar o Electron).
- Um servidor SIP com **SIP over WebSocket** habilitado:
  - **FreeSWITCH**: `mod_sofia` com `ws-binding`/`wss-binding` (ver abaixo).
  - **Asterisk**: `res_http_websocket` + `chan_pjsip` com transporte `wss`.
  - **Kamailio**: módulo `websocket`.

> Microfone (getUserMedia) exige contexto seguro. Na web, use **HTTPS** ou **localhost**. No desktop (Electron), a permissão de microfone já é concedida automaticamente pelo app.

## Como rodar

Instale as dependências uma vez:

```bash
npm install
```

### Versão web

```bash
npm start
```

Abre `http://localhost:8080` no navegador.

### Versão desktop (Electron)

```bash
npm run desktop
```

Abre a janela do app. Para abrir com as ferramentas de desenvolvedor:

```bash
npm run desktop:dev
```

Para gerar um instalador/binário distribuível (Windows `nsis`, macOS `dmg`, Linux `AppImage`):

```bash
npm run dist
```

O resultado vai para a pasta `dist/`.

> **Certificado WSS autoassinado**: em ambiente de teste do FreeSWITCH é comum usar certificado autoassinado. O app desktop **aceita** esses certificados por padrão (modo de teste). Para exigir certificado válido, rode `electron . --secure`.

## Configuração da conta SIP

Na tela "Conta SIP", preencha:

| Campo | Exemplo | Descrição |
|-------|---------|-----------|
| Servidor WebSocket (WSS) | `wss://freeswitch.local:7443` | Endpoint WebSocket do seu servidor |
| Usuário SIP | `1001` | Ramal / usuário de autenticação |
| Domínio / Realm | `freeswitch.local` | Domínio SIP |
| Senha | `••••••` | Senha do ramal |
| Nome de exibição | `João Silva` | Opcional |
| STUN/TURN | `stun:stun.l.google.com:19302` | Um por linha. Para TURN use `turn:host:porta\|usuario\|senha` |

Clique em **Conectar**. Quando o status ficar verde ("Registrado"), você pode discar.

### Configuração no FreeSWITCH (mod_sofia)

No perfil SIP (ex.: `conf/sip_profiles/internal.xml`), habilite os bindings WebSocket:

```xml
<!-- WebSocket (ws) e WebSocket seguro (wss) -->
<param name="ws-binding"  value=":5066"/>
<param name="wss-binding" value=":7443"/>
```

Pontos importantes:

- A porta padrão de **WSS** do FreeSWITCH costuma ser **7443**; a de **WS** (sem TLS), **5066**.
- O certificado TLS do WSS fica em `conf/ssl/` (arquivo `wss.pem`). Em teste pode ser autoassinado (o app desktop aceita; o navegador exige confiar no certificado).
- Use codecs compatíveis com WebRTC, principalmente **OPUS** (e `PCMU/PCMA` como fallback). Habilite no perfil/variáveis do dialplan, por ex. `<action application="set" data="absolute_codec_string=opus,PCMU,PCMA"/>`.
- O endpoint WebRTC exige `DTLS/SRTP`. O FreeSWITCH negocia isso automaticamente para clientes WS quando o perfil está com TLS/SRTP configurado.

Depois de editar, recarregue o perfil:

```
sofia profile internal restart reloadxml
```

Verifique os bindings:

```
sofia status
```

### Exemplo de configuração no Asterisk (pjsip.conf)

```ini
[transport-wss]
type = transport
protocol = wss
bind = 0.0.0.0:8089

[1001]
type = endpoint
context = from-internal
disallow = all
allow = opus,ulaw
auth = 1001-auth
aors = 1001
webrtc = yes

[1001-auth]
type = auth
auth_type = userpass
username = 1001
password = senha-forte

[1001]
type = aor
max_contacts = 1
```

E em `http.conf`:

```ini
[general]
enabled = yes
bindaddr = 0.0.0.0
tlsenable = yes
tlsbindaddr = 0.0.0.0:8089
tlscertfile = /etc/asterisk/keys/asterisk.pem
```

## Aba SIP UDP (cliente/servidor) — somente desktop

O app desktop tem uma segunda aba, **SIP UDP**, para falar SIP diretamente sobre **UDP** (a forma "clássica", sem WebSocket). Isso só existe no desktop, porque o navegador não permite abrir sockets UDP. É útil para testar registro, conectividade e fluxo de mensagens com um FreeSWITCH/PBX que escuta SIP em UDP (porta 5060).

Funcionalidades da aba:

- **Abrir socket** UDP em uma porta local (padrão 5070).
- **REGISTER** com autenticação **digest MD5** (trata desafios 401/407) e re-registro automático antes do `expires`.
- **OPTIONS** (ping SIP) para um destino.
- **SIP MESSAGE** (mensagem de texto) para um destino.
- Atua como **servidor (UAS)**: responde automaticamente a `OPTIONS`, `MESSAGE`, `INVITE`, `BYE` e `CANCEL` que chegam.
- **Log ao vivo** das mensagens SIP enviadas/recebidas (com opção de ver o conteúdo bruto).

### Chamadas com áudio (RTP G.711) na aba SIP UDP

A aba SIP UDP faz **chamadas de voz reais sobre UDP**, com mídia RTP:

- **Ligar**: digite o ramal/URI em "Ligar para" e clique em **Ligar** (`INVITE` com SDP, trata `407/401` com digest, `ACK`, e abre o áudio ao receber `200 OK`).
- **Receber**: ao chegar um `INVITE`, aparecem **Atender** / **Recusar**.
- **Encerrar**: `CANCEL` se ainda chamando, `BYE` se a chamada estiver ativa.
- **Codec**: G.711 **PCMU** (µ-law) e **PCMA** (a-law), 8 kHz, quadros de 20 ms.
- O áudio é capturado do microfone, codificado e enviado em RTP; o RTP recebido é decodificado e reproduzido (com um jitter buffer simples de ~60 ms).

Fluxo de mídia:

```
Microfone -> WebAudio (8kHz) -> IPC -> main (G.711 + RTP) -> UDP -> FreeSWITCH
FreeSWITCH -> UDP -> main (RTP + G.711) -> IPC -> WebAudio -> Alto-falante
```

> Observações: é uma implementação de RTP própria (sem DTLS/SRTP), feita para testes com FreeSWITCH/PBX em UDP. Suporta **uma chamada por vez** e **não** envia DTMF por RFC2833 (ainda). Para NAT/internet, o ideal continua sendo a aba WebRTC. Para áudio em LAN com o FreeSWITCH, a aba SIP UDP já funciona.

### Campos da aba SIP UDP

| Campo | Exemplo | Descrição |
|-------|---------|-----------|
| Servidor (host/IP) | `192.168.0.10` | Endereço do PBX/FreeSWITCH |
| Porta | `5060` | Porta SIP UDP do servidor |
| Usuário SIP | `1001` | Ramal / usuário |
| Domínio / Realm | `192.168.0.10` | Domínio SIP (usa o host se vazio) |
| Senha | `••••••` | Senha do ramal |
| Porta local | `5070` | Porta UDP local de escuta (evite 5060 se já houver um FreeSWITCH na máquina) |
| Expires (s) | `300` | Validade do registro |

### Teste com FreeSWITCH via UDP

O perfil `internal` do FreeSWITCH já escuta UDP na **5060** por padrão (`<param name="sip-port" value="5060"/>`). Basta apontar a aba SIP UDP para o IP do FreeSWITCH, usar as credenciais de um ramal e clicar em **Abrir socket** → **Registrar**. Verifique no console do FreeSWITCH com `sofia status profile internal reg`.

## Tela de Logs SIP

A aba **Logs SIP** exibe, em tempo real e num só lugar, as mensagens SIP capturadas das duas origens:

- **WebRTC (WSS)**: capturadas diretamente do transporte do JsSIP (envio e recepção), sem depender de logs de debug.
- **SIP UDP**: as mesmas mensagens da aba SIP UDP, também encaminhadas para cá.

Recursos:

- Filtro por **origem** (todas / WebRTC / UDP) e **busca** por texto (método, ramal, cabeçalho...).
- **Bruto**: expande o conteúdo completo de todas as mensagens (ou clique numa linha para expandir só ela).
- **Auto-scroll**, **Pausar** (congela a exibição sem perder histórico), **Copiar** (o que está filtrado) e **Limpar**.
- Cada linha mostra origem, direção (enviado/recebido), a linha de request/status, o CSeq e o horário com milissegundos.

## Funcionalidades

- Registro SIP via WS/WSS com status em tempo real.
- Chamadas de saída (digitação ou dialpad, Enter para ligar).
- Chamadas de entrada (atender / recusar).
- Controles em chamada: **Mudo**, **Espera (hold)**, **Encerrar**.
- Envio de **DTMF** durante a chamada (dialpad ou teclado físico).
- Histórico das últimas 50 chamadas (recebidas, feitas, perdidas) com rediscagem.
- Credenciais salvas localmente (opcional) via `localStorage`.
- Selo "Desktop" no cabeçalho quando rodando via Electron.

## Estrutura

```
softphone/
├── package.json        # scripts web (start/serve) e desktop (desktop/dist)
├── README.md
├── electron/
│   ├── main.js         # processo principal (janela, permissões, TLS de teste, IPC do SIP UDP)
│   ├── preload.js      # ponte segura (window.softphoneDesktop, window.sipUdp)
│   ├── sip-udp.js      # stack SIP sobre UDP (REGISTER/OPTIONS/MESSAGE/INVITE + UAS)
│   └── rtp-session.js  # mídia RTP + codec G.711 (PCMU/PCMA) e helpers de SDP
└── public/             # interface compartilhada web + desktop
    ├── index.html      # abas WebRTC e SIP UDP
    ├── styles.css
    ├── app.js          # lógica WebRTC/WSS (JsSIP)
    ├── udp.js          # lógica da aba SIP UDP (fala com window.sipUdp via IPC)
    ├── siplog.js       # tela unificada de Logs SIP (window.SipLog)
    └── lib/
        └── jssip.min.js  # JsSIP empacotado localmente (funciona offline)
```

> O **JsSIP** é embutido localmente em `public/lib/jssip.min.js` (não usa CDN), então o app funciona **offline** e no desktop sem depender de internet. Para regenerar esse arquivo após atualizar a dependência `jssip`, rode `npm run vendor`.

## Observações de segurança

- As credenciais SIP, se "Lembrar" estiver marcado, ficam em `localStorage` em texto. Use apenas em máquinas confiáveis.
- O app desktop aceita certificados TLS autoassinados por padrão (conveniente para teste). Em uso sério, rode com `--secure` e use um certificado válido.
- Para produção web, sirva sob HTTPS e considere TURN para atravessar NAT/firewall.
