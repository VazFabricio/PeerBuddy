'use strict';

const els = {
  connBadge: document.getElementById('connBadge'),
  sasBadge: document.getElementById('sasBadge'),
  statRtt: document.getElementById('statRtt'),
  statJitter: document.getElementById('statJitter'),
  statLoss: document.getElementById('statLoss'),
  statBitrate: document.getElementById('statBitrate'),
  statRoute: document.getElementById('statRoute'),
  screenPreset: document.getElementById('screenPreset'),
  screenMode: document.getElementById('screenMode'),
  screenCodec: document.getElementById('screenCodec'),
  screenAudioToggle: document.getElementById('screenAudioToggle'),
  btnShareScreen: document.getElementById('btnShareScreen'),
  btnStopScreen: document.getElementById('btnStopScreen'),
  screenStatus: document.getElementById('screenStatus'),
  remoteScreenBox: document.getElementById('remoteScreenBox'),
  remoteVideo: document.getElementById('remoteVideo'),
  videoStatsText: document.getElementById('videoStatsText'),
  screenVolume: document.getElementById('screenVolume'),
  btnFullscreen: document.getElementById('btnFullscreen'),
  micSelect: document.getElementById('micSelect'),
  speakerSelect: document.getElementById('speakerSelect'),
  micMeter: document.getElementById('micMeter'),
  remoteVolume: document.getElementById('remoteVolume'),
  rawAudioToggle: document.getElementById('rawAudioToggle'),
  ptime10Toggle: document.getElementById('ptime10Toggle'),
  btnStartMic: document.getElementById('btnStartMic'),
  btnMute: document.getElementById('btnMute'),
  btnHangup: document.getElementById('btnHangup'),
  audioStatus: document.getElementById('audioStatus'),
  btnCreateOffer: document.getElementById('btnCreateOffer'),
  btnCopyOffer: document.getElementById('btnCopyOffer'),
  offerOut: document.getElementById('offerOut'),
  answerIn: document.getElementById('answerIn'),
  btnAcceptAnswer: document.getElementById('btnAcceptAnswer'),
  offerIn: document.getElementById('offerIn'),
  btnCreateAnswer: document.getElementById('btnCreateAnswer'),
  btnCopyAnswer: document.getElementById('btnCopyAnswer'),
  answerOut: document.getElementById('answerOut'),
  turnUrl: document.getElementById('turnUrl'),
  turnUser: document.getElementById('turnUser'),
  turnPass: document.getElementById('turnPass'),
  remoteAudio: document.getElementById('remoteAudio'),
};

let localStream = null;
let screenStream = null;
let screenSenders = [];
let voiceSender = null;
let remoteVoiceTrack = null;
let remoteScreenStream = null;
let wasapiAudioCtx = null;
let wasapiTrack = null;
let pc = null;
let signalChannel = null;
let isPolite = false;
let makingOffer = false;
let isMuted = false;
let statsTimer = null;
let meterRaf = null;
let audioCtx = null;
let prevAudioBytes = 0;
let prevVideoBytes = 0;
let prevStatsTime = 0;

function setBadge(text, type = '') {
  els.connBadge.textContent = text;
  els.connBadge.className = 'badge' + (type ? ' ' + type : '');
}

// Compactação deflate-raw + Base64url para reduzir o tamanho do convite em ~75%
function toBase64Url(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(str) {
  const b64 = str.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((str.length + 3) % 4);
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// Remove codecs de áudio não usados (mantém apenas Opus) e candidatos TCP para reduzir o tamanho do CV1
function compactSdp(sdp) {
  const opusMatch = sdp.match(/a=rtpmap:(\d+)\s+opus\/48000/i);
  const opusPt = opusMatch ? opusMatch[1] : null;
  const lines = sdp.split(/\r?\n/);
  const out = [];

  for (const line of lines) {
    if (!line) continue;
    // Remove candidatos TCP (usamos apenas UDP P2P)
    if (line.startsWith('a=candidate:') && /\s+tcp\s+/i.test(line)) continue;

    if (opusPt) {
      if (line.startsWith('m=audio ')) {
        const parts = line.split(' ');
        if (parts.length >= 4) {
          out.push(`${parts[0]} ${parts[1]} ${parts[2]} ${opusPt}`);
          continue;
        }
      }
      const ptMatch = line.match(/^a=(?:rtpmap|fmtp|rtcp-fb):(\d+)\s/);
      if (ptMatch && ptMatch[1] !== opusPt) continue;
    }
    out.push(line);
  }
  return out.join('\r\n') + '\r\n';
}

async function encodeSignal(desc) {
  const sdp = compactSdp(desc.sdp);
  const compact = JSON.stringify({ t: desc.type === 'offer' ? 'o' : 'a', s: sdp });
  const rawBytes = new TextEncoder().encode(compact);
  if (typeof CompressionStream !== 'undefined') {
    const cs = new CompressionStream('deflate-raw');
    const writer = cs.writable.getWriter();
    writer.write(rawBytes);
    writer.close();
    const compressed = new Uint8Array(await new Response(cs.readable).arrayBuffer());
    return 'CV1:' + toBase64Url(compressed);
  }
  return 'CV0:' + toBase64Url(rawBytes);
}

async function decodeSignal(input) {
  const str = input.trim();
  if (str.startsWith('CV1:')) {
    const bytes = fromBase64Url(str.slice(4));
    const ds = new DecompressionStream('deflate-raw');
    const writer = ds.writable.getWriter();
    writer.write(bytes);
    writer.close();
    const text = await new Response(ds.readable).text();
    const obj = JSON.parse(text);
    return { type: obj.t === 'o' ? 'offer' : 'answer', sdp: obj.s };
  }
  if (str.startsWith('CV0:')) {
    const text = new TextDecoder().decode(fromBase64Url(str.slice(4)));
    const obj = JSON.parse(text);
    return { type: obj.t === 'o' ? 'offer' : 'answer', sdp: obj.s };
  }
  throw new Error('Formato inválido. O código deve começar com CV1:');
}

// Código curto de verificação (SAS) derivado das impressões digitais DTLS dos dois lados
function extractFingerprint(sdp) {
  const m = sdp.match(/a=fingerprint:[^\s]+\s+([A-Fa-f0-9:]+)/);
  return m ? m[1].toUpperCase() : '';
}

async function updateSasCode() {
  if (!pc?.localDescription?.sdp || !pc?.remoteDescription?.sdp) return;
  const f1 = extractFingerprint(pc.localDescription.sdp);
  const f2 = extractFingerprint(pc.remoteDescription.sdp);
  if (!f1 || !f2) return;
  const sorted = [f1, f2].sort().join('|');
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(sorted));
  const hex = Array.from(new Uint8Array(hash).slice(0, 3))
    .map((b) => b.toString(16).padStart(2, '0').toUpperCase())
    .join('');
  els.sasBadge.textContent = `Segurança: ${hex.slice(0, 3)}-${hex.slice(3)}`;
  els.sasBadge.style.display = 'inline-block';
}

// Opus em modo de alta fidelidade: estéreo + até 192 kbps para o áudio da tela.
// O microfone (mono) é limitado a 32 kbps no sender, então não consome banda extra.
// DTX desligado para nunca cortar início/fim de sons do vídeo/jogo.
function tuneOpusSdp(sdp) {
  const ptime = els.ptime10Toggle.checked ? 10 : 20;
  return sdp.replace(
    /a=fmtp:(\d+) (.*minptime=.*)/g,
    `a=fmtp:$1 minptime=${ptime};useinbandfec=1;usedtx=0;stereo=1;sprop-stereo=1;maxaveragebitrate=192000`
  );
}

// Ordem de codecs de vídeo: H.264 (encoder por hardware em Intel/AMD/NVIDIA, cai p/ CPU se não houver),
// VP9 (mais qualidade por bit, mais CPU) ou AV1 (melhor qualidade, só vale com hardware moderno).
function preferVideoCodec(sender, choice) {
  try {
    const tr = pc.getTransceivers().find((t) => t.sender === sender);
    if (!tr || !tr.setCodecPreferences) return;
    const codecs = RTCRtpSender.getCapabilities('video').codecs;
    const want = { h264: 'video/H264', vp9: 'video/VP9', av1: 'video/AV1' }[choice] || 'video/H264';
    const first = codecs.filter((c) => c.mimeType.toLowerCase() === want.toLowerCase());
    if (!first.length) return;
    const rest = codecs.filter((c) => !first.includes(c));
    tr.setCodecPreferences([...first, ...rest]);
  } catch {
    // Mantém ordem padrão do navegador
  }
}

// Receptor: buffer de jitter moderado favorece imagem/áudio contínuos (sem engasgos)
function tuneReceiver(receiver, kind) {
  try {
    if ('jitterBufferTarget' in receiver) {
      receiver.jitterBufferTarget = kind === 'video' ? 60 : 80;
    }
  } catch {}
}

async function applySenderPriority(sender, priority, extra = {}) {
  if (!sender) return;
  try {
    const params = sender.getParameters();
    if (!params.encodings || params.encodings.length === 0) params.encodings = [{}];
    params.encodings[0].priority = priority;
    params.encodings[0].networkPriority = priority;
    Object.assign(params.encodings[0], extra);
    if (extra.degradationPreference) {
      params.degradationPreference = extra.degradationPreference;
    }
    await sender.setParameters(params);
  } catch {
    // Alguns navegadores ignoram campos opcionais como networkPriority
  }
}

async function loadDevices() {
  const devices = await navigator.mediaDevices.enumerateDevices();
  const prevMic = els.micSelect.value;
  const prevSpk = els.speakerSelect.value;
  els.micSelect.innerHTML = '';
  els.speakerSelect.innerHTML = '';

  devices.forEach((d) => {
    const opt = document.createElement('option');
    opt.value = d.deviceId;
    opt.textContent = d.label || `${d.kind} (${d.deviceId.slice(0, 6)})`;
    if (d.kind === 'audioinput') els.micSelect.appendChild(opt);
    if (d.kind === 'audiooutput') els.speakerSelect.appendChild(opt);
  });

  if (prevMic) els.micSelect.value = prevMic;
  if (prevSpk) els.speakerSelect.value = prevSpk;
}

function startMicMeter(stream) {
  if (meterRaf) cancelAnimationFrame(meterRaf);
  if (audioCtx) audioCtx.close().catch(() => {});
  audioCtx = new AudioContext();
  const src = audioCtx.createMediaStreamSource(stream);
  const analyser = audioCtx.createAnalyser();
  analyser.fftSize = 256;
  src.connect(analyser);
  const data = new Uint8Array(analyser.frequencyBinCount);

  const tick = () => {
    analyser.getByteFrequencyData(data);
    let sum = 0;
    for (let i = 0; i < data.length; i++) sum += data[i];
    const pct = Math.min(100, ((sum / data.length) / 90) * 100);
    els.micMeter.style.width = (isMuted ? 0 : pct) + '%';
    meterRaf = requestAnimationFrame(tick);
  };
  tick();
}

async function startMicrophone() {
  try {
    if (localStream) localStream.getTracks().forEach((t) => t.stop());
    const raw = els.rawAudioToggle.checked;
    localStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: els.micSelect.value ? { exact: els.micSelect.value } : undefined,
        echoCancellation: !raw,
        noiseSuppression: !raw,
        autoGainControl: !raw,
        latency: 0.02,
      },
      video: false,
    });
    await loadDevices();
    startMicMeter(localStream);

    if (pc && voiceSender) {
      await voiceSender.replaceTrack(localStream.getAudioTracks()[0]);
    }

    isMuted = false;
    els.btnMute.textContent = 'Mutar (M)';
    els.btnMute.className = 'secondary';
    els.btnMute.disabled = false;
    els.btnCreateOffer.disabled = false;
    els.btnCreateAnswer.disabled = false;
    els.audioStatus.textContent = raw
      ? 'Microfone ativo em Modo Ultra-Baixa Latência (prioridade baixa na rede).'
      : 'Microfone ativo com cancelamento de eco/ruído (prioridade baixa na rede).';
  } catch (err) {
    els.audioStatus.textContent = 'Erro ao acessar microfone: ' + err.message;
  }
}

function setupDataChannel(ch) {
  signalChannel = ch;
  ch.onopen = () => {
    els.btnShareScreen.disabled = false;
    els.screenStatus.textContent = 'Pronto! Você pode compartilhar a tela com prioridade máxima.';
  };
  ch.onmessage = async (ev) => {
    try {
      const msg = JSON.parse(ev.data);
      if (msg.type === 'screen-stopped') {
        els.remoteVideo.srcObject = null;
        remoteScreenStream = null;
        els.remoteScreenBox.classList.remove('active');
        return;
      }
      if (msg.description) {
        const offerCollision =
          msg.description.type === 'offer' &&
          (makingOffer || pc.signalingState !== 'stable');
        if (offerCollision && !isPolite) return;

        await pc.setRemoteDescription(msg.description);
        if (msg.description.type === 'offer') {
          const answer = await pc.createAnswer();
          answer.sdp = tuneOpusSdp(answer.sdp);
          await pc.setLocalDescription(answer);
          ch.send(JSON.stringify({ description: pc.localDescription }));
        }
      } else if (msg.candidate) {
        await pc.addIceCandidate(msg.candidate).catch(() => {});
      }
    } catch (err) {
      console.error('Erro na renegociação:', err);
    }
  };
}

function createPeerConnection(polite) {
  if (pc) pc.close();
  isPolite = polite;

  const iceServers = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun.cloudflare.com:3478' },
  ];
  if (els.turnUrl.value.trim()) {
    iceServers.push({
      urls: els.turnUrl.value.trim(),
      username: els.turnUser.value.trim(),
      credential: els.turnPass.value,
    });
  }

  pc = new RTCPeerConnection({ iceServers });

  // Voz do microfone recebe prioridade BAIXA para nunca atrapalhar vídeo + áudio da tela
  const micTrack = localStream.getAudioTracks()[0];
  voiceSender = pc.addTrack(micTrack, localStream);
  applySenderPriority(voiceSender, 'low', { maxBitrate: 32_000 });

  if (!polite) {
    setupDataChannel(pc.createDataChannel('signal'));
  } else {
    pc.ondatachannel = (ev) => {
      if (ev.channel.label === 'signal') setupDataChannel(ev.channel);
    };
  }

  pc.onnegotiationneeded = async () => {
    if (!signalChannel || signalChannel.readyState !== 'open') return;
    try {
      makingOffer = true;
      const offer = await pc.createOffer();
      offer.sdp = tuneOpusSdp(offer.sdp);
      await pc.setLocalDescription(offer);
      signalChannel.send(JSON.stringify({ description: pc.localDescription }));
    } finally {
      makingOffer = false;
    }
  };

  pc.onicecandidate = (ev) => {
    if (ev.candidate && signalChannel && signalChannel.readyState === 'open') {
      signalChannel.send(JSON.stringify({ candidate: ev.candidate }));
    }
  };

  pc.ontrack = (event) => {
    const track = event.track;
    tuneReceiver(event.receiver, track.kind);

    if (track.kind === 'video') {
      if (!remoteScreenStream) remoteScreenStream = new MediaStream();
      remoteScreenStream.getVideoTracks().forEach((t) => remoteScreenStream.removeTrack(t));
      remoteScreenStream.addTrack(track);

      els.remoteVideo.srcObject = remoteScreenStream;
      els.remoteVideo.volume = parseFloat(els.screenVolume.value);
      els.remoteScreenBox.classList.add('active');
      if (els.speakerSelect.value && typeof els.remoteVideo.setSinkId === 'function') {
        els.remoteVideo.setSinkId(els.speakerSelect.value).catch(() => {});
      }
      track.onended = () => {
        els.remoteVideo.srcObject = null;
        remoteScreenStream = null;
        els.remoteScreenBox.classList.remove('active');
      };
    } else if (track.kind === 'audio') {
      // O primeiro áudio recebido na conexão é sempre a voz do microfone;
      // áudios extras que chegam depois são da transmissão de tela e nunca sobrescrevem a voz.
      if (!remoteVoiceTrack || remoteVoiceTrack.id === track.id || remoteVoiceTrack.readyState === 'ended') {
        remoteVoiceTrack = track;
        els.remoteAudio.srcObject = new MediaStream([track]);
        els.remoteAudio.volume = parseFloat(els.remoteVolume.value);
        if (els.speakerSelect.value && typeof els.remoteAudio.setSinkId === 'function') {
          els.remoteAudio.setSinkId(els.speakerSelect.value).catch(() => {});
        }
      } else {
        if (!remoteScreenStream) remoteScreenStream = new MediaStream();
        remoteScreenStream.getAudioTracks().forEach((t) => remoteScreenStream.removeTrack(t));
        remoteScreenStream.addTrack(track);
        els.remoteVideo.srcObject = remoteScreenStream;
        els.remoteVideo.volume = parseFloat(els.screenVolume.value);
      }
    }
  };

  pc.oniceconnectionstatechange = () => {
    const s = pc.iceConnectionState;
    if (s === 'checking') setBadge('Conectando P2P...', 'warn');
    else if (s === 'connected' || s === 'completed') {
      setBadge('Conectado P2P', 'ok');
      els.btnHangup.disabled = false;
      updateSasCode().catch(() => {});
      startStatsLoop();
    } else if (s === 'disconnected' || s === 'failed') {
      setBadge('Conexão perdida / Falhou', 'err');
    } else if (s === 'closed') {
      setBadge('Desconectado', '');
    }
  };

  return pc;
}

function waitForIceGathering(peer, timeoutMs = 3000) {
  return new Promise((resolve) => {
    if (peer.iceGatheringState === 'complete') return resolve();
    const timer = setTimeout(resolve, timeoutMs);
    peer.addEventListener('icegatheringstatechange', () => {
      if (peer.iceGatheringState === 'complete') {
        clearTimeout(timer);
        resolve();
      }
    });
  });
}

async function startWasapiLoopbackAudio() {
  const tauriCore = window.__TAURI__?.core;
  if (!tauriCore?.invoke || !tauriCore?.Channel) return null;

  const ctx = new AudioContext({ sampleRate: 48000, latencyHint: 'playback' });
  await ctx.audioWorklet.addModule('loopback-worklet.js');
  const node = new AudioWorkletNode(ctx, 'wasapi-loopback-processor', {
    numberOfInputs: 0,
    numberOfOutputs: 1,
    outputChannelCount: [2],
  });
  const dest = ctx.createMediaStreamDestination();
  node.connect(dest);

  const ch = new tauriCore.Channel();
  ch.onmessage = (rawBytes) => {
    const u8 = rawBytes instanceof Uint8Array ? rawBytes : new Uint8Array(rawBytes);
    if (u8.byteLength >= 8) {
      const f32 = new Float32Array(u8.buffer, u8.byteOffset, Math.floor(u8.byteLength / 4));
      node.port.postMessage(f32);
    }
  };

  await tauriCore.invoke('start_screen_audio', { onAudio: ch });
  wasapiAudioCtx = ctx;
  wasapiTrack = dest.stream.getAudioTracks()[0];
  return wasapiTrack;
}

function stopWasapiLoopbackAudio() {
  if (wasapiTrack) {
    try { wasapiTrack.stop(); } catch {}
    wasapiTrack = null;
  }
  if (wasapiAudioCtx) {
    wasapiAudioCtx.close().catch(() => {});
    wasapiAudioCtx = null;
  }
  const tauriCore = window.__TAURI__?.core;
  if (tauriCore?.invoke) {
    tauriCore.invoke('stop_screen_audio').catch(() => {});
  }
}

async function shareScreen() {
  try {
    const preset = els.screenPreset.value;
    const videoConstraints =
      preset === '720p60'
        ? { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 60 } }
        : preset === '1080p60'
        ? { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 60 } }
        : preset === '1440p60'
        ? { width: { ideal: 2560 }, height: { ideal: 1440 }, frameRate: { ideal: 60 } }
        : { frameRate: { ideal: 60 } };

    // Tenta captura WASAPI nativa (exclui o áudio do próprio PeerBuddy para não dar eco no colega)
    let nativeAudioTrack = null;
    if (els.screenAudioToggle.checked) {
      try {
        nativeAudioTrack = await startWasapiLoopbackAudio();
      } catch {
        stopWasapiLoopbackAudio();
      }
    }

    const audioConstraints =
      els.screenAudioToggle.checked && !nativeAudioTrack
        ? { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
        : false;

    screenStream = await navigator.mediaDevices.getDisplayMedia({
      video: videoConstraints,
      audio: audioConstraints,
    });

    if (nativeAudioTrack) {
      screenStream.addTrack(nativeAudioTrack);
    }

    // Modo "detail" prioriza nitidez (texto/código); "motion" prioriza fluidez (jogo/vídeo)
    const mode = els.screenMode.value;
    const videoTrack = screenStream.getVideoTracks()[0];
    if ('contentHint' in videoTrack) videoTrack.contentHint = mode === 'detail' ? 'detail' : 'motion';
    videoTrack.onended = stopScreenShare;

    const maxBitrate =
      preset === '720p60' ? 6_000_000
      : preset === '1080p60' ? 12_000_000
      : preset === '1440p60' ? 20_000_000
      : 25_000_000;

    screenSenders = [];
    for (const track of screenStream.getTracks()) {
      const sender = pc.addTrack(track, screenStream);
      if (track.kind === 'video') {
        preferVideoCodec(sender, els.screenCodec.value);
        await applySenderPriority(sender, 'high', {
          maxBitrate,
          maxFramerate: mode === 'detail' ? 30 : 60,
          scaleResolutionDownBy: 1.0, // nunca reduzir resolução por conta própria
          degradationPreference: mode === 'detail' ? 'maintain-resolution' : 'maintain-framerate',
        });
      } else if (track.kind === 'audio') {
        await applySenderPriority(sender, 'high', { maxBitrate: 192_000 });
      }
      screenSenders.push(sender);
    }

    els.btnShareScreen.disabled = true;
    els.btnStopScreen.disabled = false;
    els.screenStatus.textContent = 'Transmitindo tela com prioridade máxima (Vídeo + Áudio da Tela).';
  } catch (err) {
    stopWasapiLoopbackAudio();
    if (err.name !== 'NotAllowedError') {
      els.screenStatus.textContent = 'Erro ao compartilhar tela: ' + err.message;
    }
  }
}

function stopScreenShare() {
  stopWasapiLoopbackAudio();
  if (screenStream) {
    screenStream.getTracks().forEach((t) => t.stop());
    screenStream = null;
  }
  if (pc && screenSenders.length) {
    screenSenders.forEach((s) => {
      try { pc.removeTrack(s); } catch {}
    });
    screenSenders = [];
  }
  if (signalChannel && signalChannel.readyState === 'open') {
    signalChannel.send(JSON.stringify({ type: 'screen-stopped' }));
  }
  els.btnShareScreen.disabled = !(signalChannel && signalChannel.readyState === 'open');
  els.btnStopScreen.disabled = true;
  els.screenStatus.textContent = 'Transmissão encerrada.';
}

function startStatsLoop() {
  if (statsTimer) clearInterval(statsTimer);
  prevAudioBytes = 0;
  prevVideoBytes = 0;
  prevStatsTime = performance.now();

  statsTimer = setInterval(async () => {
    if (!pc) return;
    const stats = await pc.getStats();
    let activePair = null;
    const candidates = {};
    const now = performance.now();
    const dt = Math.max(0.1, (now - prevStatsTime) / 1000);
    let sawVideo = false;

    stats.forEach((r) => {
      if (r.type === 'local-candidate' || r.type === 'remote-candidate') {
        candidates[r.id] = r;
      }
      if (r.type === 'candidate-pair' && r.state === 'succeeded' && (r.nominated || !activePair)) {
        activePair = r;
      }
      if (r.type === 'inbound-rtp' && r.kind === 'audio') {
        const jitterMs = r.jitter != null ? (r.jitter * 1000).toFixed(1) : '--';
        els.statJitter.textContent = `${jitterMs} ms`;

        const lost = r.packetsLost || 0;
        const recv = r.packetsReceived || 0;
        const total = lost + recv;
        const pct = total > 0 ? ((lost / total) * 100).toFixed(1) : '0.0';
        els.statLoss.textContent = `${pct}% (${lost})`;

        if (prevAudioBytes > 0 && r.bytesReceived != null) {
          const kbps = (((r.bytesReceived - prevAudioBytes) * 8) / 1000 / dt).toFixed(0);
          els.statBitrate.textContent = `${kbps} kbps`;
        }
        prevAudioBytes = r.bytesReceived || 0;
      }
      if (r.type === 'outbound-rtp' && r.kind === 'video' && screenStream) {
        // Diz por que a qualidade enviada está abaixo do máximo (cpu, bandwidth ou none)
        const why = { none: 'sem limitação', cpu: 'limitado pela CPU', bandwidth: 'limitado pela rede', other: 'outro' }[r.qualityLimitationReason] || '--';
        const sw = r.frameWidth || '--';
        const sh = r.frameHeight || '--';
        const sfps = r.framesPerSecond != null ? Math.round(r.framesPerSecond) : '--';
        const enc = r.encoderImplementation || '--';
        els.screenStatus.textContent = `Enviando ${sw}x${sh} • ${sfps} fps • ${r.codecId ? '' : ''}encoder: ${enc} • ${why}`;
      }
      if (r.type === 'inbound-rtp' && r.kind === 'video') {
        sawVideo = true;
        const fps = r.framesPerSecond != null ? Math.round(r.framesPerSecond) : '--';
        const w = r.frameWidth || '--';
        const h = r.frameHeight || '--';
        const vLost = r.packetsLost || 0;
        let vKbps = '--';
        if (prevVideoBytes > 0 && r.bytesReceived != null) {
          vKbps = (((r.bytesReceived - prevVideoBytes) * 8) / 1000 / dt).toFixed(0);
        }
        prevVideoBytes = r.bytesReceived || 0;
        els.videoStatsText.textContent = `${w}x${h} • ${fps} fps • ${vKbps} kbps • Perda vídeo: ${vLost}`;
      }
    });

    if (!sawVideo && els.remoteScreenBox.classList.contains('active')) {
      els.videoStatsText.textContent = 'Recebendo vídeo...';
    }
    prevStatsTime = now;

    if (activePair) {
      const rttMs = activePair.currentRoundTripTime != null
        ? Math.round(activePair.currentRoundTripTime * 1000)
        : '--';
      els.statRtt.textContent = `${rttMs} ms`;

      const local = candidates[activePair.localCandidateId];
      const remote = candidates[activePair.remoteCandidateId];
      if (local && remote) {
        const isRelay = local.candidateType === 'relay' || remote.candidateType === 'relay';
        const isLan = local.candidateType === 'host' && remote.candidateType === 'host';
        els.statRoute.textContent = isRelay
          ? 'Relay (TURN)'
          : isLan
          ? 'Rede Local (LAN)'
          : 'Direto P2P (UDP)';
      }
    }
  }, 1000);
}

function hangup() {
  stopScreenShare();
  if (statsTimer) clearInterval(statsTimer);
  statsTimer = null;
  if (pc) {
    pc.close();
    pc = null;
  }
  signalChannel = null;
  voiceSender = null;
  remoteVoiceTrack = null;
  remoteScreenStream = null;
  els.remoteAudio.srcObject = null;
  els.remoteVideo.srcObject = null;
  els.remoteScreenBox.classList.remove('active');
  els.sasBadge.style.display = 'none';
  els.btnHangup.disabled = true;
  els.btnShareScreen.disabled = true;
  els.btnStopScreen.disabled = true;
  els.btnCopyOffer.disabled = true;
  els.btnCopyAnswer.disabled = true;
  els.btnAcceptAnswer.disabled = true;
  els.offerOut.value = '';
  els.answerIn.value = '';
  els.offerIn.value = '';
  els.answerOut.value = '';
  els.statRtt.textContent = '-- ms';
  els.statJitter.textContent = '-- ms';
  els.statLoss.textContent = '--';
  els.statBitrate.textContent = '-- kbps';
  els.statRoute.textContent = '--';
  els.screenStatus.textContent = 'Conecte-se primeiro para compartilhar ou assistir a tela.';
  setBadge('Desconectado', '');
}

// Eventos UI
els.btnStartMic.addEventListener('click', startMicrophone);
els.rawAudioToggle.addEventListener('change', () => {
  if (localStream) startMicrophone();
});
els.micSelect.addEventListener('change', () => {
  if (localStream) startMicrophone();
});
els.speakerSelect.addEventListener('change', () => {
  if (typeof els.remoteAudio.setSinkId === 'function') {
    els.remoteAudio.setSinkId(els.speakerSelect.value).catch(() => {});
  }
  if (typeof els.remoteVideo.setSinkId === 'function') {
    els.remoteVideo.setSinkId(els.speakerSelect.value).catch(() => {});
  }
});
els.remoteVolume.addEventListener('input', () => {
  els.remoteAudio.volume = parseFloat(els.remoteVolume.value);
});
els.screenVolume.addEventListener('input', () => {
  els.remoteVideo.volume = parseFloat(els.screenVolume.value);
});

function toggleMute() {
  if (!localStream) return;
  isMuted = !isMuted;
  localStream.getAudioTracks().forEach((t) => (t.enabled = !isMuted));
  els.btnMute.textContent = isMuted ? 'Desmutar (M)' : 'Mutar (M)';
  els.btnMute.className = isMuted ? 'danger' : 'secondary';
}
els.btnMute.addEventListener('click', toggleMute);
window.addEventListener('keydown', (e) => {
  if (e.key.toLowerCase() === 'm' && !['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName)) {
    toggleMute();
  }
});

els.btnShareScreen.addEventListener('click', shareScreen);
els.btnStopScreen.addEventListener('click', stopScreenShare);
els.btnFullscreen.addEventListener('click', () => {
  if (els.remoteVideo.requestFullscreen) els.remoteVideo.requestFullscreen();
});
els.btnHangup.addEventListener('click', hangup);

// Lado A: Criar Convite
els.btnCreateOffer.addEventListener('click', async () => {
  els.btnCreateOffer.disabled = true;
  setBadge('Gerando convite...', 'warn');
  const peer = createPeerConnection(false);
  const offer = await peer.createOffer();
  offer.sdp = tuneOpusSdp(offer.sdp);
  await peer.setLocalDescription(offer);
  await waitForIceGathering(peer);

  els.offerOut.value = await encodeSignal(peer.localDescription);
  els.btnCopyOffer.disabled = false;
  els.btnAcceptAnswer.disabled = false;
  els.btnCreateOffer.disabled = false;
  setBadge('Aguardando resposta...', 'warn');
});

els.btnCopyOffer.addEventListener('click', async () => {
  await navigator.clipboard.writeText(els.offerOut.value);
  els.btnCopyOffer.textContent = 'Copiado!';
  setTimeout(() => (els.btnCopyOffer.textContent = 'Copiar Convite'), 1500);
});

els.btnAcceptAnswer.addEventListener('click', async () => {
  try {
    if (!pc || pc.signalingState !== 'have-local-offer') {
      alert('Gere um convite novo (passo 1) antes de conectar.');
      return;
    }
    const answer = await decodeSignal(els.answerIn.value);
    await pc.setRemoteDescription(answer);
    els.btnAcceptAnswer.disabled = true;
    setBadge('Conectando P2P...', 'warn');
  } catch (err) {
    alert('Código de resposta inválido: ' + err.message);
  }
});

// Lado B: Aceitar Convite e Gerar Resposta
els.btnCreateAnswer.addEventListener('click', async () => {
  try {
    els.btnCreateAnswer.disabled = true;
    setBadge('Gerando resposta...', 'warn');
    const offer = await decodeSignal(els.offerIn.value);
    const peer = createPeerConnection(true);
    await peer.setRemoteDescription(offer);

    const answer = await peer.createAnswer();
    answer.sdp = tuneOpusSdp(answer.sdp);
    await peer.setLocalDescription(answer);
    await waitForIceGathering(peer);

    els.answerOut.value = await encodeSignal(peer.localDescription);
    els.btnCopyAnswer.disabled = false;
    els.btnCreateAnswer.disabled = false;
    setBadge('Resposta pronta — envie ao colega', 'warn');
  } catch (err) {
    els.btnCreateAnswer.disabled = false;
    alert('Convite inválido: ' + err.message);
  }
});

els.btnCopyAnswer.addEventListener('click', async () => {
  await navigator.clipboard.writeText(els.answerOut.value);
  els.btnCopyAnswer.textContent = 'Copiado!';
  setTimeout(() => (els.btnCopyAnswer.textContent = 'Copiar Resposta'), 1500);
});

if (navigator.mediaDevices?.enumerateDevices) {
  loadDevices().catch(() => {});
}
