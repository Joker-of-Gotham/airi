import type { MaybeRefOrGetter } from 'vue'

import { until } from '@vueuse/core'
import { ref, shallowRef, toRef } from 'vue'

import vadWorkletUrl from '../../workers/vad/process.worklet?worker&url'

function float32ToInt16(buffer: Float32Array) {
  const output = new Int16Array(buffer.length)
  for (let i = 0; i < buffer.length; i++) {
    const value = Math.max(-1, Math.min(1, buffer[i]))
    output[i] = value < 0 ? value * 0x8000 : value * 0x7FFF
  }
  return output
}

function encodeWavPcm16(samples: Int16Array, sampleRate: number) {
  // 44-byte WAV header for PCM16 mono
  const buffer = new ArrayBuffer(44 + samples.length * 2)
  const view = new DataView(buffer)

  const writeString = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++)
      view.setUint8(offset + i, str.charCodeAt(i))
  }

  const byteRate = sampleRate * 2 // mono * 16-bit
  const blockAlign = 2

  writeString(0, 'RIFF')
  view.setUint32(4, 36 + samples.length * 2, true)
  writeString(8, 'WAVE')
  writeString(12, 'fmt ')
  view.setUint32(16, 16, true) // PCM
  view.setUint16(20, 1, true) // audio format = PCM
  view.setUint16(22, 1, true) // channels = 1
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, byteRate, true)
  view.setUint16(32, blockAlign, true)
  view.setUint16(34, 16, true) // bits per sample
  writeString(36, 'data')
  view.setUint32(40, samples.length * 2, true)

  // PCM data
  let offset = 44
  for (let i = 0; i < samples.length; i++, offset += 2)
    view.setInt16(offset, samples[i], true)

  return buffer
}

export function useAudioRecorder(
  media: MaybeRefOrGetter<MediaStream | undefined>,
) {
  const mediaRef = toRef(media)
  const recording = shallowRef<Blob>()

  const audioContext = ref<AudioContext>()
  const workletNode = ref<AudioWorkletNode>()
  const mediaStreamSource = ref<MediaStreamAudioSourceNode>()
  const silentGain = ref<GainNode>()

  const sampleRate = 16000
  const chunks = ref<Float32Array[]>([])
  const isActive = ref(false)

  const onStopRecordHooks = ref<Array<(recording: Blob | undefined) => Promise<void>>>([])

  function onStopRecord(callback: (recording: Blob | undefined) => Promise<void>) {
    onStopRecordHooks.value.push(callback)
    // Return unsubscribe function to prevent memory leaks
    return () => {
      onStopRecordHooks.value = onStopRecordHooks.value.filter(h => h !== callback)
    }
  }

  async function startRecord() {
    await until(mediaRef).toBeTruthy()
    if (isActive.value)
      return
    // Reset buffers
    chunks.value = []

    // We intentionally do NOT stop the incoming MediaStream tracks here;
    // this recorder is a tap that builds its own WebAudio graph.
    const ctx = new AudioContext({ sampleRate, latencyHint: 'interactive' })
    await ctx.audioWorklet.addModule(vadWorkletUrl)

    const node = new AudioWorkletNode(ctx, 'vad-audio-worklet-processor')
    node.port.onmessage = ({ data }: MessageEvent<{ buffer?: Float32Array }>) => {
      const buf = data?.buffer
      if (!buf)
        return
      // Clone to avoid retaining transferred/reused buffers
      chunks.value.push(buf.slice(0))
    }

    const source = ctx.createMediaStreamSource(mediaRef.value!)
    source.connect(node)

    // Keep graph alive but silent
    const gain = ctx.createGain()
    gain.gain.value = 0
    node.connect(gain)
    gain.connect(ctx.destination)

    audioContext.value = ctx
    workletNode.value = node
    mediaStreamSource.value = source
    silentGain.value = gain
    isActive.value = true

    if (ctx.state === 'suspended')
      await ctx.resume()
  }

  async function stopRecord() {
    if (!isActive.value || !audioContext.value) {
      recording.value = undefined
      return undefined
    }
    const ctx = audioContext.value
    const node = workletNode.value
    const source = mediaStreamSource.value
    const gain = silentGain.value

    // Tear down graph
    try {
      source?.disconnect()
      if (node?.port)
        node.port.onmessage = null
      node?.disconnect()
      gain?.disconnect()
    }
    catch {}

    try {
      await ctx?.close()
    }
    catch {}

    audioContext.value = undefined
    workletNode.value = undefined
    mediaStreamSource.value = undefined
    silentGain.value = undefined
    isActive.value = false

    // Build wav
    const totalLen = chunks.value.reduce((acc, cur) => acc + cur.length, 0)
    if (totalLen <= 0) {
      recording.value = undefined
      return undefined
    }
    const merged = new Float32Array(totalLen)
    let offset = 0
    for (const c of chunks.value) {
      merged.set(c, offset)
      offset += c.length
    }

    const pcm16 = float32ToInt16(merged)
    const wav = encodeWavPcm16(pcm16, sampleRate)
    const audioBlob = new Blob([wav], { type: 'audio/wav' })

    recording.value = audioBlob

    // await hooks and catch errors
    for (const hook of onStopRecordHooks.value) {
      try {
        await hook(audioBlob)
      }
      catch (err) {
        console.error('onStopRecord hook failed:', err)
      }
    }

    return audioBlob
  }

  return {
    startRecord,
    stopRecord,
    onStopRecord,

    recording,
  }
}
