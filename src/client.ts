/**
 * The Hindsight transport: one bounded REST call per operation, every
 * failure — connect, read, status — surfaced as the plugin's clean,
 * bounded error shape.
 *
 * @module dsh-plugin-hindsight-advanced/client
 */

import type { ResolvedConfig } from './config.ts'

/** Bound for detail text embedded in surfaced errors. */
const MAX_ERROR_DETAIL_CHARS = 300

/** Wrap a transport failure in the plugin's clean, bounded error shape. */
function failure(path: string, error: unknown): Error {
  const reason = error instanceof Error ? error.message : String(error)
  return new Error(`hindsight: ${path} failed: ${reason.slice(0, MAX_ERROR_DETAIL_CHARS)}`)
}

/** One bounded REST call against the Hindsight server. GETs carry no body
 *  (the query lives in `path`). */
export async function request(
  config: ResolvedConfig,
  path: string,
  body: unknown,
  signal: AbortSignal,
  method: 'POST' | 'PATCH' | 'GET' = 'POST',
): Promise<Record<string, unknown>> {
  let res: Response
  try {
    res = await fetch(config.baseUrl + path, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(config.apiKey !== undefined ? { authorization: `Bearer ${config.apiKey}` } : {}),
      },
      body: method === 'GET' ? undefined : JSON.stringify(body),
      signal,
    })
  } catch (error) {
    throw failure(path, error)
  }
  let text: string
  try {
    text = await res.text()
  } catch (error) {
    throw failure(path, error)
  }
  if (!res.ok) {
    let detail = text
    try {
      detail = JSON.stringify(JSON.parse(text))
    } catch {
      // not JSON; keep the raw body
    }
    throw new Error(`hindsight: ${path} returned HTTP ${res.status}: ${detail.slice(0, MAX_ERROR_DETAIL_CHARS)}`)
  }
  let data: unknown
  try {
    data = text.length > 0 ? JSON.parse(text) : {}
  } catch {
    data = { error: text }
  }
  return typeof data === 'object' && data !== null ? data as Record<string, unknown> : {}
}
