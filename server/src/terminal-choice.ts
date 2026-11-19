/**
 * A model or effort the owner chose inside a card's own terminal, read from its transcript (canon 03).
 *
 * Only the CLI's answer to `/model` or `/effort` counts. A reply on another model with no such line
 * before it is the CLI falling back on overload or a rate limit, which is not a choice.
 */
export type TerminalChoice = {
  model: { id: string; at: number } | null
  effort: { value: string; at: number } | null
  /** A `/model` line seen with no reply after it yet and a name that does not map to an id. */
  modelWaiting: { at: number } | null
}

const SET_MODEL = /Set model to `?([^`\n<]+?)`?(?: and saved|\s*<|$)/
const SET_EFFORT = /Set effort level to ([a-z]+)/
const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max'])

/** "Opus 5.5" is claude-opus-5-5. Anything else waits for the reply to name it. */
export function modelIdFromName(name: string): string | null {
  const m = /^(Opus|Sonnet|Haiku|Fable) (\d+)(?:\.(\d+))?$/.exec(name.trim())
  if (!m) return null
  return `claude-${m[1]!.toLowerCase()}-${m[2]}${m[3] ? `-${m[3]}` : ''}`
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map((c) => (typeof c?.text === 'string' ? c.text : '')).join('\n')
  return ''
}

/**
 * The newest choices in these lines, in file order. `waitingSince` carries a `/model` line from an
 * earlier window whose reply had not been written yet, so the first reply here names it.
 */
export function readTerminalChoice(lines: string[], waitingSince: number | null = null): TerminalChoice {
  const out: TerminalChoice = { model: null, effort: null, modelWaiting: waitingSince === null ? null : { at: waitingSince } }
  for (const line of lines) {
    if (!line) continue
    const quick = line.includes('Set model to') || line.includes('Set effort level to') || (out.modelWaiting && line.includes('"model"'))
    if (!quick) continue
    let rec: any
    try {
      rec = JSON.parse(line)
    } catch {
      continue
    }
    const at = Date.parse(rec?.timestamp ?? '') || 0
    if (rec?.type === 'assistant' && out.modelWaiting && typeof rec?.message?.model === 'string' && rec.message.model !== '<synthetic>') {
      out.model = { id: rec.message.model, at: out.modelWaiting.at }
      out.modelWaiting = null
      continue
    }
    if (rec?.type !== 'user') continue
    const text = textOf(rec?.message?.content)
    if (!text.includes('<local-command-stdout>')) continue
    const model = SET_MODEL.exec(text)
    if (model && at) {
      const id = modelIdFromName(model[1]!)
      // The name is a fallback: the reply that follows names the model exactly, so prefer it.
      out.modelWaiting = { at }
      if (id) out.model = { id, at }
    }
    const effort = SET_EFFORT.exec(text)
    if (effort && at && EFFORTS.has(effort[1]!)) out.effort = { value: effort[1]!, at }
  }
  return out
}

/** The last `bytes` of a file as lines, read without holding the server's thread (canon 01). */
export async function tailLinesAsync(path: string, bytes: number): Promise<string[]> {
  const { open } = await import('node:fs/promises')
  const fh = await open(path, 'r')
  try {
    const size = (await fh.stat()).size
    const start = Math.max(0, size - bytes)
    const buf = Buffer.alloc(size - start)
    await fh.read(buf, 0, buf.length, start)
    const lines = buf.toString('utf8').split('\n')
    // The first line of a window that starts mid-file is partial.
    if (start > 0) lines.shift()
    return lines
  } finally {
    await fh.close()
  }
}
