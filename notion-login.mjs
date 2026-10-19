// Notion's passwordless sign-in, the one its own login page runs: ask for a
// code by email, hand the code back, and end up holding the same `token_v2`
// cookie a browser would have.
//
// Notion has no OAuth for this, so there is no browser round trip to show: the
// user reads the code out of their mail and types it in.

import { randomUUID } from 'node:crypto'
import { FALLBACK_CLIENT_VERSION, NotionError, apiURL, fetchClientVersion, notionFetch, notionOrigin } from './notion-api.mjs'
import { createCookieJar, hasToken } from './cookies.mjs'

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36'

function loginHeaders(clientVersion, { json = true, referer } = {}) {
  const headers = {
    accept: json ? 'application/json' : 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'accept-language': 'en-US,en;q=0.9',
    origin: notionOrigin(),
    referer: referer || `${notionOrigin()}/login`,
    'user-agent': USER_AGENT,
    'notion-audit-log-platform': 'web',
  }
  if (json) headers['content-type'] = 'application/json'
  if (clientVersion) headers['notion-client-version'] = clientVersion
  return headers
}

function loginError(step, response, text) {
  const retry = response.headers.get('retry-after')
  const hint = response.status === 429 ? ' (too many requests; wait a moment)' : ''
  return new NotionError(
    `Notion ${step} answered ${response.status}${hint}${text ? `: ${text.slice(0, 200)}` : ''}${retry ? ` [retry-after ${retry}]` : ''}`,
    { status: response.status },
  )
}

async function postLogin(step, path, payload, { jar, clientVersion, signal, fetchImpl = notionFetch, userId = '' }) {
  const headers = loginHeaders(clientVersion)
  if (jar.header()) headers.cookie = jar.header()
  if (userId) headers['x-notion-active-user-header'] = userId
  const response = await fetchImpl(apiURL(path), {
    method: 'POST',
    headers,
    body: JSON.stringify(payload ?? {}),
    signal,
  })
  jar.absorb(response)
  const text = await response.text()
  if (!response.ok) throw loginError(step, response, text)
  if (!text.trim()) return {}
  try {
    return JSON.parse(text)
  } catch {
    throw new NotionError(`Notion ${step} answered something that is not JSON: ${text.slice(0, 120)}`, { status: response.status })
  }
}

/**
 * Asks Notion for a code by email. What comes back is everything the second
 * half of the login needs, so nothing has to be kept on the side.
 */
export async function startEmailLogin(email, { signal, fetchImpl = notionFetch } = {}) {
  const address = (email || '').trim()
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) {
    throw new NotionError('enter a full email address')
  }

  const jar = createCookieJar()
  const loginPage = await fetchImpl(`${notionOrigin()}/login`, {
    headers: loginHeaders('', { json: false }),
    signal,
  })
  jar.absorb(loginPage)
  const html = await loginPage.text()
  const found = /data-notion-version="([^"]+)"/.exec(html)
  const clientVersion = found ? found[1].trim() : (await fetchClientVersion({ signal, fetchImpl })) || FALLBACK_CLIENT_VERSION
  const deviceId = jar.get('notion_browser_id') || jar.get('device_id') || randomUUID()

  const options = await postLogin('getLoginOptions', 'getLoginOptions', { email: address, requireWorkTypeEmail: false }, {
    jar,
    clientVersion,
    signal,
    fetchImpl,
  })
  const loginOptionsToken = String(options.loginOptionsToken ?? '').trim()
  if (!loginOptionsToken) throw new NotionError('Notion returned no loginOptionsToken, so the sign-in cannot go on')

  const sent = await postLogin(
    'sendTemporaryPassword',
    'sendTemporaryPassword',
    {
      email: address,
      disableLoginLink: false,
      native: false,
      isSignup: false,
      shouldHidePasscode: false,
      loginOptionsToken,
      deviceId,
      loginRouteOrigin: 'login',
    },
    { jar, clientVersion, signal, fetchImpl },
  )
  const csrfState = String(sent.csrfState ?? '').trim()
  if (!csrfState) throw new NotionError('Notion returned no csrfState: the code was probably not sent')

  return { email: address, clientVersion, deviceId, loginOptionsToken, csrfState, jar }
}

/** Hands the code back, and keeps the cookie that comes with it. */
export async function finishEmailLogin(state, code, { signal, fetchImpl = notionFetch } = {}) {
  const password = (code || '').trim()
  if (!password) throw new NotionError('enter the code from the email')
  const payload = await postLogin(
    'loginWithEmail',
    'loginWithEmail',
    { state: state.csrfState, password, loginRouteOrigin: 'login' },
    { jar: state.jar, clientVersion: state.clientVersion, signal, fetchImpl },
  )
  const cookieHeader = state.jar.sessionHeader()
  if (!hasToken(cookieHeader)) {
    throw new NotionError('Notion accepted the code but set no token_v2 cookie (two-step verification may be on)')
  }
  const token = state.jar.get('token_v2') || state.jar.get('token_v3')
  return { token, cookieHeader, userId: String(payload.userId ?? '').trim() }
}

export { createCookieJar }
export const _internal = { loginHeaders, postLogin }
