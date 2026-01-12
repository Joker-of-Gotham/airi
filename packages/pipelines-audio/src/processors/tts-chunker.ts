import type { ReaderLike } from 'clustr'

import type { TextSegment, TextToken } from '../types'

import { readGraphemeClusters } from 'clustr'

import { createPushStream } from '../stream'

export const TTS_FLUSH_INSTRUCTION = '\u200B'
export const TTS_SPECIAL_TOKEN = '\u2063'

const keptPunctuations = new Set('?？!！')
const hardPunctuations = new Set('.。?？!！…⋯～~\n\t\r')
const softPunctuations = new Set(',，、–—:：;；《》「」')

export interface TtsInputChunk {
  text: string
  words: number
  reason: 'boost' | 'limit' | 'hard' | 'flush' | 'special'
}

export interface TtsInputChunkOptions {
  boost?: number
  minimumWords?: number
  maximumWords?: number
  /**
   * When provided, chunking will also respect grapheme/char length bounds.
   * This helps reduce pauses for long sentences and for CJK languages where "word" counts are not stable.
   */
  minimumChars?: number
  maximumChars?: number
  /**
   * Dynamic minimum length control:
   * - before we have emitted any speech chunks, keep segments longer to reduce "overly short" audio.
   * - after at least one chunk is emitted, allow shorter segments to improve responsiveness.
   *
   * Recommended range: [11..20]
   */
  minimumCharsBeforeFirst?: number
  minimumCharsAfterFirst?: number
}

export interface TtsChunkItem {
  chunk: string
  special: string | null
  reason: 'boost' | 'limit' | 'hard' | 'flush' | 'special'
}

export async function* chunkTtsInput(
  input: string | ReaderLike,
  options?: TtsInputChunkOptions,
): AsyncGenerator<TtsInputChunk, void, unknown> {
  const {
    boost = 2,
    minimumWords = 4,
    maximumWords = 12,
    minimumChars = 12,
    maximumChars = 64,
    minimumCharsBeforeFirst = 20,
    minimumCharsAfterFirst = 11,
  } = options ?? {}

  const iterator = readGraphemeClusters(
    typeof input === 'string'
      ? new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(input))
            controller.close()
          },
        }).getReader()
      : input,
  )

  const segmenter = new Intl.Segmenter(undefined, { granularity: 'word' }) // I love Intl.Segmenter

  let yieldCount = 0
  let buffer = ''
  let chunk = ''
  let chunkWordsCount = 0

  let previousValue: string | undefined
  let current = await iterator.next()

  while (!current.done) {
    let value = current.value

    // Some grapheme clusters (e.g. emoji) may have length > 1.
    // We must NOT skip them, otherwise TTS input loses content and can't split on emoji boundaries.

    const flush = value === TTS_FLUSH_INSTRUCTION
    const special = value === TTS_SPECIAL_TOKEN
    const isEmoji = /\p{Extended_Pictographic}/u.test(value)
    const hard = isEmoji || hardPunctuations.has(value)
    const soft = softPunctuations.has(value)
    const kept = keptPunctuations.has(value)
    let next: IteratorResult<string, any> | undefined
    let afterNext: IteratorResult<string, any> | undefined

    // Markdown strong marker: split on paired "**" (and do not speak the marker)
    if (value === '*') {
      next = await iterator.next()
      if (!next.done && next.value === '*') {
        // Treat "**" as a flush boundary without emitting any visible chars.
        value = TTS_FLUSH_INSTRUCTION
      }
      else {
        // Not a pair, keep as literal
        afterNext = next
        next = undefined
      }
    }

    if (flush || special || hard || soft) {
      switch (value) {
        case '.':
        case ',': {
          if (previousValue !== undefined && /\d/.test(previousValue)) {
            next = await iterator.next()
            if (!next.done && next.value && /\d/.test(next.value)) {
              buffer += value
              current = next
              next = undefined
              continue
            }
          }
          else if (value === '.') {
            next = await iterator.next()
            if (!next.done && next.value && next.value === '.') {
              afterNext = await iterator.next()
              if (!afterNext.done && afterNext.value && afterNext.value === '.') {
                value = '…'
                next = undefined
                afterNext = undefined
              }
            }
          }
        }
      }

      if (buffer.length === 0) {
        if (special) {
          yield {
            text: '',
            words: 0,
            reason: 'special',
          }
          yieldCount++
          chunkWordsCount = 0
        }

        previousValue = value
        if (afterNext !== undefined) {
          current = afterNext
          afterNext = undefined
        }
        else {
          current = next ?? await iterator.next()
          next = undefined
        }
        continue
      }

      const words = [...segmenter.segment(buffer)].filter(w => w.isWordLike)

      if (chunkWordsCount > minimumWords && chunkWordsCount + words.length > maximumWords) {
        const text = kept ? chunk.trim() + value : chunk.trim()
        yield {
          text,
          words: chunkWordsCount,
          reason: 'limit',
        }
        yieldCount++
        chunk = ''
        chunkWordsCount = 0
      }

      chunk += buffer + value
      chunkWordsCount += words.length
      buffer = ''

      const dynamicMinChars = yieldCount > 0 ? minimumCharsAfterFirst : minimumCharsBeforeFirst
      const dynamicMinLen = Math.max(minimumChars, dynamicMinChars)

      if (special) {
        const text = chunk.slice(0, -1).trim()
        yield {
          text,
          words: chunkWordsCount,
          reason: 'special',
        }
        yieldCount++
        chunk = ''
        chunkWordsCount = 0
      }
      else if (flush || hard || chunkWordsCount > maximumWords || chunk.length > maximumChars || yieldCount < boost) {
        // (1) Short segment extension:
        // If the segment between punctuations is too short, DO NOT emit yet; extend to next punctuation.
        // (2) Dynamic minimum:
        // Before any audio emitted, require longer segments; after that allow shorter ones.
        const shouldExtendShort
          = !flush
            && !hard
            && (chunk.length < dynamicMinLen || chunkWordsCount < Math.min(minimumWords, 3))
            && yieldCount >= boost
            && chunk.length < maximumChars

        if (shouldExtendShort) {
          previousValue = value
          current = next ?? await iterator.next()
          next = undefined
          continue
        }
        const text = chunk.trim()
        yield {
          text,
          words: chunkWordsCount,
          reason: flush ? 'flush' : hard ? 'hard' : (chunkWordsCount > maximumWords || chunk.length > maximumChars) ? 'limit' : 'boost',
        }
        yieldCount++
        chunk = ''
        chunkWordsCount = 0
      }

      previousValue = value
      if (next !== undefined) {
        if (afterNext !== undefined) {
          current = afterNext
          next = undefined
          afterNext = undefined
        }
        else {
          current = next
          next = undefined
        }
      }
      else {
        current = await iterator.next()
      }
      continue
    }

    buffer += value
    previousValue = value
    next = await iterator.next()
    current = next
  }

  if (chunk.length > 0 || buffer.length > 0) {
    const text = (chunk + buffer).trim()
    yield {
      text,
      words: chunkWordsCount + [...segmenter.segment(buffer)].filter(w => w.isWordLike).length,
      reason: 'flush',
    }
  }
}

export async function chunkEmitter(
  reader: ReaderLike,
  pendingSpecials: string[],
  options: TtsInputChunkOptions | undefined,
  handler: (ttsSegment: TtsChunkItem) => Promise<void> | void,
) {
  const sanitizeChunk = (text: string) =>
    text
      .replaceAll(TTS_SPECIAL_TOKEN, '')
      .replaceAll(TTS_FLUSH_INSTRUCTION, '')
      .trim()

  try {
    for await (const chunk of chunkTtsInput(reader, options)) {
      // TODO: remove later

      if (chunk.reason === 'special') {
        const specialToken = pendingSpecials.shift()
        // console.debug("special yield:", specialToken)
        await handler({ chunk: sanitizeChunk(chunk.text), special: specialToken ?? null, reason: chunk.reason })
      }
      else {
        await handler({ chunk: sanitizeChunk(chunk.text), special: null, reason: chunk.reason })
      }
    }
  }
  catch (e) {
    console.error('Error chunking stream to TTS queue:', e)
  }
}

export function createTtsSegmentStream(
  tokens: ReadableStream<TextToken>,
  meta: { streamId: string, intentId: string },
  options?: TtsInputChunkOptions,
) {
  const { stream, write, close, error } = createPushStream<TextSegment>()
  const pendingSpecials: string[] = []
  const encoder = new TextEncoder()

  const { stream: byteStream, write: writeBytes, close: closeBytes, error: errorBytes } = createPushStream<Uint8Array>()

  void (async () => {
    const reader = tokens.getReader()
    try {
      while (true) {
        const { value, done } = await reader.read()
        if (done)
          break
        if (!value)
          continue

        if (value.type === 'literal') {
          if (value.value)
            writeBytes(encoder.encode(value.value))
        }
        else if (value.type === 'special') {
          pendingSpecials.push(value.value ?? '')
          writeBytes(encoder.encode(TTS_SPECIAL_TOKEN))
        }
        else if (value.type === 'flush') {
          writeBytes(encoder.encode(TTS_FLUSH_INSTRUCTION))
        }
      }
      closeBytes()
    }
    catch (err) {
      errorBytes(err)
    }
    finally {
      reader.releaseLock()
    }
  })()

  void (async () => {
    try {
      const reader = byteStream.getReader()
      await chunkEmitter(reader, pendingSpecials, options, async (chunk) => {
        write({
          streamId: meta.streamId,
          intentId: meta.intentId,
          segmentId: `${meta.streamId}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
          text: chunk.chunk,
          special: chunk.special,
          reason: chunk.reason,
          createdAt: Date.now(),
        })
      })
      close()
    }
    catch (err) {
      error(err)
    }
  })()

  return stream
}
