/**
 * Generation record store (Host side).
 *
 * v1 kept no record of what it generated: the picture existed only as a durable
 * attachment and as a file on disk, so "the last five pictures" and "generate
 * again with the same parameters" had nothing to read. This module is that
 * missing index.
 *
 * Design notes:
 *
 * - **Records hold metadata, never pixels.** The bytes stay where v1 put them
 *   (attachment store + `saveDir`); a record carries the prompt, the parameters
 *   actually sent, the seed, the paths, and the attachment ids needed to render
 *   a thumbnail. A store that copies bytes would double the disk cost of every
 *   picture for no gain.
 *
 * - **Newest first, capped.** Every reader wants "the most recent N", so the
 *   list is kept in that order and trimmed on write. A growing append-only log
 *   would need compaction later; a capped array does not.
 *
 * - **Persisted, unlike the staged references.** The history strip is a feature
 *   the user expects to survive a restart, so this is written to a JSON file
 *   under the plugin's own data directory rather than held in memory. A failed
 *   write is a warning, never a failed generation: losing history must not cost
 *   the user a picture.
 */
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/** How many records are kept. The UI shows 5; the extra headroom is so a few
 *  older ones remain reachable after the strip's window moves on. */
export const HISTORY_LIMIT = 60

function errorMessage(error) {
  if (error === undefined || error === null) return '未知错误'
  if (typeof error === 'string') return error
  if (typeof error.message === 'string' && error.message.length > 0) return error.message
  return String(error)
}

/**
 * A record as the client consumes it. Only plain JSON values, because this
 * crosses the same-origin JSON route.
 *
 * @typedef {{
 *   id: string,
 *   createdAt: number,
 *   prompt: string,
 *   request: string,
 *   model: string,
 *   params: Record<string, unknown>,
 *   seed: number|null,
 *   seedRandom: boolean,
 *   outputDir: string|null,
 *   outputDirRelative: string|null,
 *   cost: number|null,
 *   elapsedMs: number|null,
 *   images: Array<{name: string, mediaType: string, bytes: number,
 *                  attachmentId: string|null, filePath: string|null}>
 * }} GenerationRecord
 */

export class GenerationStore {
  /**
   * @param {string} file absolute path of the JSON file backing the store
   */
  constructor(file) {
    this.file = file
    /** @type {GenerationRecord[]} newest first */
    this.records = []
    this.loaded = false
  }

  /**
   * Read the file once. A missing or corrupt file is an empty history, not an
   * error: the store is a convenience index, and refusing to boot over it would
   * take the whole plugin down with it.
   */
  async load() {
    if (this.loaded) return
    this.loaded = true
    try {
      const text = await readFile(this.file, 'utf8')
      const parsed = JSON.parse(text)
      const list = Array.isArray(parsed?.records) ? parsed.records : []
      this.records = list.filter((row) => row !== null && typeof row === 'object' && typeof row.id === 'string')
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        console.warn(`[openrouter-imagen-v2] history unreadable (${errorMessage(error)}); starting empty`)
      }
      this.records = []
    }
  }

  /** Newest first, capped. */
  list(limit) {
    const max = Number.isFinite(Number(limit)) ? Math.max(1, Math.floor(Number(limit))) : this.records.length
    return this.records.slice(0, max)
  }

  find(id) {
    return this.records.find((row) => row.id === id) ?? null
  }

  /**
   * Prepend one generation. Returns the stored record.
   *
   * The write is atomic-ish (temp file + rename) so a crash mid-write cannot
   * leave a half-written history that the next boot would have to discard.
   */
  async add(record) {
    await this.load()
    this.records.unshift(record)
    if (this.records.length > HISTORY_LIMIT) this.records.length = HISTORY_LIMIT
    await this.persist()
    return record
  }

  async remove(id) {
    await this.load()
    const before = this.records.length
    this.records = this.records.filter((row) => row.id !== id)
    if (this.records.length !== before) await this.persist()
    return before !== this.records.length
  }

  async clear() {
    await this.load()
    this.records = []
    await this.persist()
  }

  async persist() {
    const payload = JSON.stringify({ version: 1, records: this.records }, null, 0)
    const temp = `${this.file}.tmp`
    try {
      await mkdir(dirname(this.file), { recursive: true })
      await writeFile(temp, payload, 'utf8')
      await rename(temp, this.file)
    } catch (error) {
      console.warn(`[openrouter-imagen-v2] cannot persist history: ${errorMessage(error)}`)
    }
  }
}

/** Ids only have to be unique within one history file. */
export function recordId(now = Date.now(), salt = Math.random()) {
  return `gen-${now.toString(36)}-${Math.floor(salt * 0xffffff).toString(36)}`
}

export { join }
