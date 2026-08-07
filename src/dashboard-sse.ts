import { request, type ClientRequest, type IncomingMessage } from 'node:http'
import { subscribeEventsUrl } from './sse-server.js'

export type DashboardEvent = Record<string, unknown>

export interface SseFrame {
  event: string
  data: DashboardEvent
}

export function filterDashboardEvent(event: DashboardEvent, fleetId: string | undefined): boolean {
  if (fleetId === undefined) return true
  return event.fleet_id === fleetId
}

export interface ParsedSseFrames {
  frames: SseFrame[]
  remainder: string
}

export function parseSseFrames(input: string): ParsedSseFrames {
  const parts = input.split(/\r?\n\r?\n/)
  const remainder = parts.pop() ?? ''
  const frames: SseFrame[] = []
  for (const part of parts) {
    let event = 'message'
    const dataLines: string[] = []
    for (const line of part.split(/\r?\n/)) {
      if (line.startsWith(':')) continue
      const separator = line.indexOf(':')
      const field = separator < 0 ? line : line.slice(0, separator)
      const value = separator < 0 ? '' : line.slice(separator + 1).replace(/^ /, '')
      if (field === 'event') event = value
      if (field === 'data') dataLines.push(value)
    }
    if (dataLines.length === 0) continue
    try {
      const parsed: unknown = JSON.parse(dataLines.join('\n'))
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) continue
      frames.push({ event, data: Object.fromEntries(Object.entries(parsed)) })
    } catch {
      continue
    }
  }
  return { frames, remainder }
}

export class EventRingBuffer {
  private readonly entries: DashboardEvent[] = []

  public constructor(private readonly limit: number) {
    if (!Number.isInteger(limit) || limit < 1) throw new Error('event limit must be a positive integer')
  }

  public push(event: DashboardEvent): void {
    this.entries.push(event)
    if (this.entries.length > this.limit) this.entries.shift()
  }

  public replace(events: readonly DashboardEvent[]): void {
    this.entries.length = 0
    for (const event of events.slice(-this.limit)) this.entries.push(event)
  }

  public values(): DashboardEvent[] {
    return [...this.entries]
  }
}

export interface DashboardUpdatesOptions {
  readonly fleetId?: string
  readonly interval: number
  readonly port?: number
  readonly poll: () => void
  readonly onEvent: (event: DashboardEvent) => void
  readonly connect?: boolean
}

export interface DashboardUpdates {
  close: () => void
}

export function startDashboardUpdates(options: DashboardUpdatesOptions): DashboardUpdates {
  let closed = false
  let pollTimer: NodeJS.Timeout | undefined
  let retryTimer: NodeJS.Timeout | undefined
  let activeRequest: ClientRequest | undefined

  const startPolling = (): void => {
    if (closed || pollTimer) return
    options.poll()
    pollTimer = setInterval(options.poll, options.interval)
  }

  const connect = (): void => {
    if (closed) return
    const url = options.port === undefined
      ? subscribeEventsUrl(options.fleetId)
      : `http://127.0.0.1:${options.port}/events/stream${options.fleetId ? `?fleet_id=${encodeURIComponent(options.fleetId)}` : ''}`
    let disconnected = false
    const unavailable = (): void => {
      if (disconnected || closed) return
      disconnected = true
      startPolling()
      retryTimer = setTimeout(connect, options.interval)
    }
    activeRequest = request(url, (response: IncomingMessage) => {
      if (response.statusCode !== 200) {
        response.resume()
        unavailable()
        return
      }
      if (pollTimer) {
        clearInterval(pollTimer)
        pollTimer = undefined
      }
      let buffer = ''
      response.setEncoding('utf8')
      response.on('data', (chunk: string) => {
        const parsed = parseSseFrames(buffer + chunk)
        buffer = parsed.remainder
        for (const frame of parsed.frames) {
          const event = { ...frame.data, event: frame.event }
          if (filterDashboardEvent(event, options.fleetId)) options.onEvent(event)
        }
      })
      response.on('close', unavailable)
      response.on('error', unavailable)
    })
    activeRequest.on('error', unavailable)
  }

  if (options.connect !== false) connect()
  return {
    close: (): void => {
      closed = true
      if (pollTimer) clearInterval(pollTimer)
      if (retryTimer) clearTimeout(retryTimer)
      activeRequest?.destroy()
    },
  }
}
