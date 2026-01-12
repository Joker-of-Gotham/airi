// vad-worklet-processor.ts
// This file needs to be registered as an AudioWorklet

/**
 * Silero VAD (and most STT frontends) prefer 16kHz mono frames.
 * This worklet always emits Float32 PCM at 16kHz in fixed 512-sample frames (~32ms),
 * regardless of the AudioContext's actual sampleRate (often 48kHz on desktop).
 *
 * This guarantees:
 * - Stable VAD probability over time (no wrong-rate drift)
 * - Stable streaming STT input (correct sample rate)
 * - Stable recording input (consistent PCM frames)
 */
const TARGET_SAMPLE_RATE = 16000
const TARGET_CHUNK_SIZE = 512

// AudioWorklet global `sampleRate` reflects the AudioContext sample rate.
const INPUT_SAMPLE_RATE = typeof sampleRate === 'number' ? sampleRate : TARGET_SAMPLE_RATE
const RATIO = INPUT_SAMPLE_RATE / TARGET_SAMPLE_RATE
const RATIO_INT = Math.round(RATIO)
const RATIO_IS_INT = Math.abs(RATIO - RATIO_INT) < 1e-6

// Sliding input buffer (Float32) + fractional read position
let pending = new Float32Array(Math.max(2048, Math.ceil(TARGET_CHUNK_SIZE * RATIO) * 4))
let pendingLen = 0
let inputPos = 0 // fractional index into pending [0,1)

// DC blocker (high-pass) to reduce low-frequency hum / "electrical" noise.
// y[n] = x[n] - x[n-1] + R * y[n-1]
// R closer to 1 => lower cutoff, less distortion of speech.
let dcX1 = 0
let dcY1 = 0
const DC_R = 0.995

function ensureCapacity(extra: number) {
  const needed = pendingLen + extra
  if (needed <= pending.length)
    return
  let nextSize = pending.length
  while (nextSize < needed)
    nextSize *= 2
  const next = new Float32Array(nextSize)
  next.set(pending.subarray(0, pendingLen), 0)
  pending = next
}

function appendInput(input: Float32Array) {
  ensureCapacity(input.length)
  pending.set(input, pendingLen)
  pendingLen += input.length
}

function canEmitFrame() {
  if (INPUT_SAMPLE_RATE === TARGET_SAMPLE_RATE)
    return pendingLen >= TARGET_CHUNK_SIZE
  // Need enough input so that (inputPos + (TARGET_CHUNK_SIZE-1)*RATIO + 1) is valid
  const required = Math.ceil(inputPos + (TARGET_CHUNK_SIZE - 1) * RATIO) + 2
  return pendingLen >= required
}

function emitFrame(port: MessagePort) {
  if (INPUT_SAMPLE_RATE === TARGET_SAMPLE_RATE) {
    const out = pending.slice(0, TARGET_CHUNK_SIZE)
    // Shift left
    pending.copyWithin(0, TARGET_CHUNK_SIZE, pendingLen)
    pendingLen -= TARGET_CHUNK_SIZE
    // DC block
    for (let i = 0; i < out.length; i++) {
      const x = out[i]
      const y = x - dcX1 + DC_R * dcY1
      dcX1 = x
      dcY1 = y
      out[i] = y
    }
    port.postMessage({ buffer: out })
    return
  }

  const out = new Float32Array(TARGET_CHUNK_SIZE)
  if (RATIO_IS_INT && RATIO_INT >= 2 && inputPos === 0) {
    // Box-filter + decimate for common cases like 48k -> 16k (ratio = 3).
    // This significantly reduces aliasing compared to pure linear resampling,
    // which often manifests as "electrical" high-frequency artifacts.
    for (let i = 0; i < TARGET_CHUNK_SIZE; i++) {
      const base = i * RATIO_INT
      let acc = 0
      for (let j = 0; j < RATIO_INT; j++)
        acc += pending[base + j] || 0
      out[i] = acc / RATIO_INT
    }
  }
  else {
    // Generic linear resampling (fractional ratios like 44.1k -> 16k)
    for (let i = 0; i < TARGET_CHUNK_SIZE; i++) {
      const pos = inputPos + i * RATIO
      const left = Math.floor(pos)
      const frac = pos - left
      const a = pending[left] || 0
      const b = pending[left + 1] || 0
      out[i] = a * (1 - frac) + b * frac
    }
  }

  // DC block on output frame
  for (let i = 0; i < out.length; i++) {
    const x = out[i]
    const y = x - dcX1 + DC_R * dcY1
    dcX1 = x
    dcY1 = y
    out[i] = y
  }

  // Advance read position by one frame of output
  inputPos += TARGET_CHUNK_SIZE * RATIO
  const drop = Math.floor(inputPos)
  inputPos -= drop

  if (drop > 0) {
    pending.copyWithin(0, drop, pendingLen)
    pendingLen -= drop
  }

  port.postMessage({ buffer: out })
}

/**
 * VAD AudioWorklet Processor - processes audio chunks and sends them to the main thread
 */
class VADProcessor extends AudioWorkletProcessor {
  process(inputs: Float32Array[][], _outputs: Float32Array[][], _parameters: Record<string, Float32Array>) {
    const buffer = inputs[0][0]
    if (!buffer)
      return true // buffer is null when the stream ends

    // Always copy input out of WebAudio-owned buffers to avoid lifetime/reuse issues.
    appendInput(buffer.slice(0))

    while (canEmitFrame()) {
      emitFrame(this.port)
    }

    return true
  }
}

registerProcessor('vad-audio-worklet-processor', VADProcessor)
