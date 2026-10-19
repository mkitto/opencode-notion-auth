// Notion's own API, as the web app calls it. Everything here is unofficial:
// it authenticates with the `token_v2` browser cookie and speaks the
// endpoints Notion's front end uses, so it can break whenever Notion changes.

import { randomUUID } from 'node:crypto'

const DEFAULT_ORIGIN = 'https://www.notion.so'
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36'
const SEC_CH_UA = '"Google Chrome";v="145", "Not?A_Brand";v="8", "Chromium";v="145"'
// Used only when the version Notion's login page reports cannot be read.
const FALLBACK_CLIENT_VERSION = '25.10.16.1'

export function notionOrigin() {
  const override = (globalThis.process?.env?.NOTION_API_BASE ?? '').trim()
  return (override || DEFAULT_ORIGIN).replace(/\/+$/, '')
}

// A TUN-less setup: this Notion line may leave through a proxy while the rest
// of the machine stays direct. Magpie hands a plugin its proxy as
// MAGPIE_HTTPS_PROXY, and Bun's fetch takes one per call — so it is attached
// here instead of left to the environment, which Bun reads only once.
const NOTION_PROXY = String(
  globalThis.process?.env?.NOTION_PROXY ??
    globalThis.process?.env?.MAGPIE_HTTPS_PROXY ??
    globalThis.process?.env?.MAGPIE_HTTP_PROXY ??
    globalThis.process?.env?.HTTPS_PROXY ??
    globalThis.process?.env?.HTTP_PROXY ??
    '',
).trim()

// Bun's fetch reads HTTPS_PROXY at request time; Magpie renames it to
// MAGPIE_*_PROXY for the host so a plugin's env cannot push every child
// through one. This plugin wants the proxy for its own requests only, so it
// is put back here — nothing outside this process sees it.
if (NOTION_PROXY) {
  const env = globalThis.process?.env
  if (env && !env.HTTPS_PROXY) env.HTTPS_PROXY = NOTION_PROXY
  if (env && !env.HTTP_PROXY) env.HTTP_PROXY = NOTION_PROXY
}

/** fetch with the proxy this Notion line goes through, when one is set. */
export function notionFetch(input, init = {}) {
  return NOTION_PROXY ? fetch(input, { ...init, proxy: NOTION_PROXY }) : fetch(input, init)
}

// Notion checks the TLS fingerprint where a thread is created: a runtime's own
// handshake — Bun's here — is answered 200 with `temporarily-unavailable`,
// which reads as an empty reply. impit speaks Chrome's TLS, so the one call
// that has to look like a browser goes through it; the rest keep plain fetch.
let impitClient
let impitLoading
async function impitFetch(url, init) {
  if (!impitClient) {
    impitLoading ??= import('impit')
      // impit's default timeout is 30s, which cut long replies mid-sentence
      // while the stream was still healthy (a 1397-char article stopped at
      // 30.14s with finish_reason "stop"). Notion itself is fine well past
      // 40s; the ceiling was this client, not the service.
      .then(({ Impit }) => (impitClient = new Impit({ browser: 'chrome', followRedirects: false, timeout: 180_000 })))
      .catch((error) => {
        impitLoading = undefined
        throw new NotionError(`impit could not load, so Notion cannot be reached: ${error?.message ?? error}`, {
          status: 503,
        })
      })
    await impitLoading
  }
  try {
    return await impitClient.fetch(String(url), init)
  } catch (error) {
    // Some impit builds refuse the per-request redirect option; the shared
    // client already does not follow redirects, so dropping it is safe.
    if (!/redirect/i.test(String(error?.message ?? ''))) throw error
    const { redirect, ...withoutRedirect } = init
    return impitClient.fetch(String(url), withoutRedirect)
  }
}

export function apiURL(name) {
  return `${notionOrigin()}/api/v3/${name}`
}

/** The version header Notion's own bundle reports, read off its login page. */
export async function fetchClientVersion({ signal, fetchImpl = notionFetch } = {}) {
  try {
    const res = await fetchImpl(`${notionOrigin()}/login`, {
      headers: {
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'user-agent': USER_AGENT,
      },
      signal,
    })
    if (!res.ok) return ''
    const html = await res.text()
    const match = /data-notion-version="([^"]+)"/.exec(html)
    return match ? match[1].trim() : ''
  } catch {
    return ''
  }
}

function apiHeaders(account, { referer, accept = 'application/json' } = {}) {
  const headers = {
    accept,
    'content-type': 'application/json',
    'notion-audit-log-platform': 'web',
    'cookie': cookieHeader(account.cookie),
    'origin': notionOrigin(),
    'referer': referer || `${notionOrigin()}/ai`,
    'user-agent': USER_AGENT,
    'sec-ch-ua': SEC_CH_UA,
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-origin',
  }
  if (account.clientVersion) headers['notion-client-version'] = account.clientVersion
  if (account.userId) headers['x-notion-active-user-header'] = account.userId
  if (account.spaceId) headers['x-notion-space-id'] = account.spaceId
  return headers
}

/** `token_v2` alone is enough; anything else the user pasted is kept as given. */
export function cookieHeader(cookie) {
  const clean = (cookie || '').trim()
  if (!clean) return ''
  if (clean.includes('=')) return clean
  return `token_v2=${clean}`
}

export class NotionError extends Error {
  constructor(message, { status = 0, signIn = '' } = {}) {
    super(message)
    this.name = 'NotionError'
    this.status = status
    if (signIn) this.signIn = signIn
  }
}

async function postJson(account, name, payload, { signal, fetchImpl = notionFetch, referer } = {}) {
  const res = await fetchImpl(apiURL(name), {
    method: 'POST',
    headers: apiHeaders(account, { referer }),
    body: JSON.stringify(payload ?? {}),
    signal,
  })
  const text = await res.text()
  if (!res.ok) {
    const signIn = res.status === 401 || res.status === 403 ? 'expired' : ''
    throw new NotionError(
      `Notion ${name} answered ${res.status}${text ? `: ${text.slice(0, 200)}` : ''}`,
      { status: res.status, signIn: signIn || (isNotSignedIn(text) ? 'expired' : '') },
    )
  }
  if (isNotSignedIn(text)) {
    throw new NotionError(`Notion ${name} refused the sign-in: ${text.slice(0, 200)}`, { signIn: 'expired' })
  }
  try {
    return JSON.parse(text)
  } catch {
    throw new NotionError(`Notion ${name} answered something that is not JSON`)
  }
}

function isNotSignedIn(text) {
  return /unauthorized|not\s+logged\s+in|invalid\s+token|notion_user_id/i.test(text || '')
}

function unwrapRecord(raw) {
  if (!raw || typeof raw !== 'object') return null
  if (raw.value && typeof raw.value === 'object') {
    if (raw.value.value && typeof raw.value.value === 'object') return raw.value.value
    return raw.value
  }
  return raw
}

function boolOf(value) {
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase().trim())
  return false
}

/**
 * The account behind a `token_v2`: its user and the space to run inference in.
 * Notion answers with a record map covering every space the account can see;
 * the one that has AI on and a paid plan wins.
 */
export function parseUserContent(payload) {
  const recordMap = payload?.recordMap
  if (!recordMap) throw new NotionError('Notion loadUserContent answered no recordMap')

  let userId = ''
  let email = ''
  let userName = ''
  const users = recordMap.notion_user ?? {}
  for (const [id, raw] of Object.entries(users)) {
    const value = unwrapRecord(raw)
    if (!value) continue
    userId = id
    email = typeof value.email === 'string' ? value.email : ''
    userName = typeof value.name === 'string' ? value.name : ''
    break
  }

  const spaces = recordMap.space ?? {}
  const root = unwrapRecord((recordMap.user_root ?? {})[userId])
  const candidates = []
  for (const rawPointer of Array.isArray(root?.space_view_pointers) ? root.space_view_pointers : []) {
    const spaceId = (rawPointer?.spaceId ?? '').trim()
    if (!spaceId) continue
    const value = unwrapRecord(spaces[spaceId])
    if (!value) continue
    const settings = value.settings ?? {}
    const aiEnabled = boolOf(settings.enable_ai_feature) || !boolOf(settings.disable_ai_feature)
    const plan = (value.plan_type ?? '').trim()
    candidates.push({
      spaceId: (value.id ?? spaceId).trim(),
      spaceViewId: (rawPointer.id ?? '').trim(),
      spaceName: (value.name ?? '').trim(),
      planType: plan,
      aiEnabled,
      score: (aiEnabled ? 2 : 0) + (plan && plan !== 'free' ? 1 : 0) + ((value.name ?? '').trim() ? 1 : 0),
    })
  }
  candidates.sort((a, b) => b.score - a.score)
  const best = candidates[0]
  if (!best) throw new NotionError('Notion loadUserContent listed no space for this account')
  return { userId, email, userName, ...best }
}

export async function loadAccount(account, { signal, fetchImpl = notionFetch } = {}) {
  const payload = await postJson(account, 'loadUserContent', {}, { signal, fetchImpl })
  return parseUserContent(payload)
}

/**
 * The models this account may pick, as Notion's own picker lists them. The
 * answer nests the list in a string as often as not, so every JSON value the
 * payload holds is tried and the ones shaped like a model list are read.
 */
export async function fetchAvailableModels(account, { signal, fetchImpl = notionFetch } = {}) {
  if (!account?.spaceId) throw new NotionError('No space to ask for a model list about')
  const payload = await postJson(account, 'getAvailableModels', { spaceId: account.spaceId }, { signal, fetchImpl })
  const found = []
  for (const candidate of jsonCandidates(payload)) {
    if (!Array.isArray(candidate?.models)) continue
    for (const model of candidate.models) {
      const entry = readModelEntry(model)
      if (entry) found.push(entry)
    }
  }
  return dedupe(found)
}

function readModelEntry(model) {
  if (!model || typeof model !== 'object') return null
  if (model.isDisabled) return null
  const name = (model.modelMessage || model.model || '').trim()
  // The code a workflow thread runs under: Notion names it in each surface,
  // and falls back to the model itself.
  const apiId = (
    model.workflow?.finalModelName ||
    model.customAgent?.finalModelName ||
    model.agentService?.finalModelName ||
    model.model ||
    ''
  ).trim()
  if (!name || !apiId) return null
  const efforts = Array.isArray(model.modelConfiguration?.supportedReasoningEfforts)
    ? model.modelConfiguration.supportedReasoningEfforts.filter((effort) => typeof effort === 'string' && effort)
    : []
  return {
    name,
    apiId,
    family: (model.modelProvider || model.modelFamily || '').trim(),
    group: (model.displayGroup ?? '').trim(),
    beta: Boolean(model.markdownChat?.beta || model.workflow?.beta || model.customAgent?.beta),
    efforts,
    defaultEffort: (model.modelConfiguration?.defaultReasoningEffort ?? '').trim(),
  }
}

/** Every object reachable from a payload, following JSON kept in strings. */
function jsonCandidates(value, depth = 0) {
  if (depth > 5 || value == null) return []
  if (typeof value === 'string') {
    const text = value.trim()
    if (!text.startsWith('{') && !text.startsWith('[')) return []
    try {
      return jsonCandidates(JSON.parse(text), depth + 1)
    } catch {
      return []
    }
  }
  if (Array.isArray(value)) return value.flatMap((item) => jsonCandidates(item, depth + 1))
  if (typeof value === 'object') {
    return [value, ...Object.values(value).flatMap((item) => jsonCandidates(item, depth + 1))]
  }
  return []
}

function dedupe(items) {
  const seen = new Set()
  const out = []
  for (const item of items) {
    if (seen.has(item.apiId)) continue
    seen.add(item.apiId)
    out.push(item)
  }
  return out
}

/** The workflow config a transcript run starts from, as the web app sends it. */
/** The reasoning levels magpie can offer for a model, as Notion names them. */
export const KNOWN_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

/** magpie and other agents say "ultra"; Notion's highest is "max". */
export function normalizeEffort(effort, allowed = KNOWN_EFFORTS) {
  const clean = typeof effort === 'string' ? effort.trim().toLowerCase() : ''
  const aliased = clean === 'ultra' ? 'max' : clean === 'off' ? 'none' : clean
  return allowed.includes(aliased) ? aliased : ''
}

export function buildConfigValue({ notionModel = '', webSearch = false, readOnly = false, effort = '' } = {}) {
  const config = {
    type: 'workflow',
    enableAgentAutomations: true,
    enableAgentIntegrations: true,
    enableCustomAgents: true,
    enableExperimentalIntegrations: false,
    enableAgentDiffs: true,
    enableAgentUpdatePagePatch: !readOnly,
    enableAgentCreateDbTemplate: true,
    enableCsvAttachmentSupport: false,
    enableDatabaseAgents: false,
    showDatabaseAgentsDiscoverability: false,
    enableAgentThreadTools: false,
    enableCrdtOperations: false,
    enableAgentCardCustomization: true,
    enableSystemPromptAsPage: false,
    enableUserSessionContext: false,
    enableScriptAgentAdvanced: false,
    enableScriptAgent: true,
    enableScriptAgentSearchConnectorsInCustomAgent: false,
    enableScriptAgentGoogleDriveInCustomAgent: false,
    enableScriptAgentGoogleDriveOAuthInCustomAgent: false,
    enableScriptAgentSlack: true,
    enableScriptAgentMcpServers: false,
    enableScriptAgentMail: true,
    enableScriptAgentCalendar: true,
    enableScriptAgentCustomToolCalling: true,
    enableCreateAndRunThread: true,
    enableSoftwareFactoryPage: false,
    enableAgentGenerateImage: false,
    enableSpeculativeSearch: false,
    enableQueryCalendar: false,
    enableQueryMail: false,
    enableMailExplicitToolCalls: true,
    enableMailNotificationPreferences: false,
    enableMailAgentMultiProviderSupport: false,
    useRulePrioritization: true,
    availableConnectors: [],
    customConnectorInfo: [],
    searchScopes: webSearch ? [{ type: 'everything' }] : [],
    useSearchToolV2: false,
    enableUnifiedSearch: false,
    useWebSearch: webSearch,
    isHipaa: false,
    yoloMode: false,
    useReadOnlyMode: readOnly,
    writerMode: false,
    modelFromUser: Boolean(notionModel),
    isCustomAgent: false,
    isCustomAgentBuilder: false,
    isAgentResearchRequest: false,
    useCustomAgentDraft: false,
    use_draft_actor_pointer: false,
    enableUpdatePageAutofixer: !readOnly,
    enableMarkdownVNext: false,
    enableUpdatePageOrderUpdates: !readOnly,
    enableAgentSupportPropertyReorder: !readOnly,
    agentShortUpdatePageResult: false,
    enableAgentAskSurvey: true,
    databaseAgentConfigMode: false,
    isOnboardingAgent: false,
    isMobile: false,
  }
  if (notionModel) config.model = notionModel
  // How hard Notion's own agent thinks, carried in the config step of the
  // transcript. A model that serves one level only needs nothing here; its
  // code already says which.
  if (effort) config.reasoningEffort = effort
  return config
}

export function buildContextValue(account, { instructions = '' } = {}) {
  const context = {
    timezone: 'Asia/Shanghai',
    userName: account.userName || '',
    userId: account.userId || '',
    userEmail: account.email || '',
    spaceName: account.spaceName || '',
    spaceId: account.spaceId || '',
    currentDatetime: new Date().toISOString(),
    surface: 'ai_module',
  }
  if (account.spaceViewId) context.spaceViewId = account.spaceViewId
  if (instructions) {
    context.instructions = instructions
    context.runtimePromptHint = instructions
  }
  return context
}

/**
 * Runs one turn in a new thread. Notion never ends the stream early when a
 * client hangs up, so the caller owns the abort signal.
 */
export async function runInferenceTranscript(
  account,
  { prompt, notionModel = '', webSearch = false, instructions = '', effort = '', signal, fetchImpl = notionFetch } = {},
) {
  const threadId = randomUUID()
  const configId = randomUUID()
  const contextId = randomUUID()
  const transcript = [
    { id: configId, type: 'config', value: buildConfigValue({ notionModel, webSearch, effort }) },
    { id: contextId, type: 'context', value: buildContextValue(account, { instructions }) },
  ]
  if (instructions) {
    transcript.push({
      id: randomUUID(),
      type: 'context',
      value: { instructions, runtimePromptHint: instructions },
    })
  }
  transcript.push({
    id: randomUUID(),
    type: 'user',
    value: [[prompt]],
    userId: account.userId,
    createdAt: new Date().toISOString(),
  })

  const body = {
    spaceId: account.spaceId,
    threadId,
    createThread: true,
    generateTitle: false,
    traceId: randomUUID(),
    transcript,
    threadType: 'workflow',
    asPatchResponse: true,
    isPartialTranscript: false,
    saveAllThreadOperations: false,
    setUnreadState: false,
    createdSource: 'ai_module',
    isUserInAnySalesAssistedSpace: false,
    isSpaceSalesAssisted: false,
    debugOverrides: {
      annotationInferences: {},
      cachedInferences: {},
      emitAgentSearchExtractedResults: true,
      emitInferences: false,
    },
    threadParentPointer: { table: 'space', id: account.spaceId, spaceId: account.spaceId },
  }

  const runFetch = fetchImpl === notionFetch ? impitFetch : fetchImpl
  const res = await runFetch(apiURL('runInferenceTranscript'), {
    method: 'POST',
    headers: apiHeaders(account, { accept: 'application/x-ndjson', referer: `${notionOrigin()}/ai` }),
    body: JSON.stringify(body),
    signal,
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    const status = res.status
    throw new NotionError(
      `Notion runInferenceTranscript answered ${status}${text ? `: ${text.slice(0, 300)}` : ''}`,
      { status, signIn: status === 401 || status === 403 || isNotSignedIn(text) ? 'expired' : '' },
    )
  }
  if (!res.body) throw new NotionError('Notion runInferenceTranscript answered no body')
  return { response: res, threadId }
}

export { FALLBACK_CLIENT_VERSION, USER_AGENT }
