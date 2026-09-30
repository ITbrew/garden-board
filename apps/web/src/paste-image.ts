import { conn } from './connection'

/**
 * Ctrl+V with a screenshot on the clipboard pastes the path of the saved image. Canon 03, "Pasting a
 * screenshot". The owner: "when i screen shot i can cntrl+v into a terminal and it pastes the path for
 * the image".
 *
 * Only when the clipboard holds an image and no text. Text always pastes as text, so copying a line
 * out of a document that also carries a picture behaves exactly as it did.
 */
export function pastedImage(e: ClipboardEvent | React.ClipboardEvent): File | null {
  const data = e.clipboardData
  if (!data) return null
  if (data.getData('text/plain')) return null
  for (const item of Array.from(data.items)) {
    if (item.kind === 'file' && item.type.startsWith('image/')) return item.getAsFile()
  }
  return null
}

const waiting = new Map<string, (path: string | null) => void>()
conn.on((msg) => {
  if (msg.t !== 'paste.saved') return
  waiting.get(msg.reqId)?.(msg.path)
  waiting.delete(msg.reqId)
})

/** Hand the image to the server and get back where it was saved, or null if it was not. */
export async function saveImage(file: File): Promise<string | null> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  const reqId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  return new Promise((resolve) => {
    waiting.set(reqId, resolve)
    // Never left hanging: a server that does not answer means no path, not a paste stuck forever.
    setTimeout(() => {
      if (waiting.delete(reqId)) resolve(null)
    }, 15_000)
    conn.send({ t: 'paste.image', reqId, mime: file.type, data: btoa(bin) })
  })
}

/** A path as it should be typed: quoted only when it has a space in it. */
export function typedPath(path: string): string {
  return /\s/.test(path) ? `"${path}"` : path
}
