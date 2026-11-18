'use strict';

class WasapiLoopbackProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    // Ring buffer de 1 segundo em 48 kHz estéreo (48000 frames)
    this.capacity = 48000;
    this.left = new Float32Array(this.capacity);
    this.right = new Float32Array(this.capacity);
    this.readIdx = 0;
    this.writeIdx = 0;
    this.available = 0;

    // Pre-buffer de ~80ms (3840 frames) para absorver jitter do IPC/Windows sem estalos
    this.prebufferFrames = 3840;
    // Limite máximo de ~240ms (11520 frames) para não acumular atraso se a thread principal atrasar
    this.maxLatencyFrames = 11520;
    this.buffering = true;

    this.port.onmessage = (ev) => {
      const interleaved = ev.data;
      const frames = interleaved.length >> 1;
      for (let i = 0; i < frames; i++) {
        if (this.available >= this.capacity) {
          this.readIdx = (this.readIdx + 1) % this.capacity;
          this.available--;
        }
        this.left[this.writeIdx] = interleaved[i * 2];
        this.right[this.writeIdx] = interleaved[i * 2 + 1];
        this.writeIdx = (this.writeIdx + 1) % this.capacity;
        this.available++;
      }

      // Se acumulou mais que o limite máximo (~240ms), avança suavemente para ~100ms
      if (this.available > this.maxLatencyFrames) {
        const drop = this.available - 4800;
        this.readIdx = (this.readIdx + drop) % this.capacity;
        this.available -= drop;
      }

      if (this.buffering && this.available >= this.prebufferFrames) {
        this.buffering = false;
      }
    };
  }

  process(_inputs, outputs) {
    const out = outputs[0];
    if (!out || out.length < 2) return true;
    const outL = out[0];
    const outR = out[1];
    const len = outL.length;

    if (this.buffering) {
      outL.fill(0);
      outR.fill(0);
      return true;
    }

    for (let i = 0; i < len; i++) {
      if (this.available > 0) {
        outL[i] = this.left[this.readIdx];
        outR[i] = this.right[this.readIdx];
        this.readIdx = (this.readIdx + 1) % this.capacity;
        this.available--;
      } else {
        outL[i] = 0;
        outR[i] = 0;
        // Esvaziou: volta a acumular pre-buffer de 80ms para não picotar
        this.buffering = true;
      }
    }
    return true;
  }
}

registerProcessor('wasapi-loopback-processor', WasapiLoopbackProcessor);
