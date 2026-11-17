'use strict';

class WasapiLoopbackProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    // Ring buffer para ~0.5s em 48 kHz estéreo (evita alocação no thread de áudio)
    this.capacity = 24000;
    this.left = new Float32Array(this.capacity);
    this.right = new Float32Array(this.capacity);
    this.readIdx = 0;
    this.writeIdx = 0;
    this.available = 0;

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
    };
  }

  process(_inputs, outputs) {
    const out = outputs[0];
    if (!out || out.length < 2) return true;
    const outL = out[0];
    const outR = out[1];
    const len = outL.length;

    for (let i = 0; i < len; i++) {
      if (this.available > 0) {
        outL[i] = this.left[this.readIdx];
        outR[i] = this.right[this.readIdx];
        this.readIdx = (this.readIdx + 1) % this.capacity;
        this.available--;
      } else {
        outL[i] = 0;
        outR[i] = 0;
      }
    }
    return true;
  }
}

registerProcessor('wasapi-loopback-processor', WasapiLoopbackProcessor);
