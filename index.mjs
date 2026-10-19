// Notion AI as a magpie / OpenCode provider.
//
// Notion's own API is what this talks to: the `token_v2` cookie an agent user
// already has in a browser, and `runInferenceTranscript`, which answers in
// NDJSON rather than in any OpenAI shape. Everything below is that translation.
//
// Unofficial, and against Notion's terms of service. The account is the thing
// at risk, so this is meant for a throwaway workspace, not a working one.

import {
  FALLBACK_CLIENT_VERSION,
  KNOWN_EFFORTS,
  NotionError,
  fetchAvailableModels,
  fetchClientVersion,
  loadAccount,
  normalizeEffort,
  notionOrigin,
  runInferenceTranscript,
} from './notion-api.mjs'
import { finishEmailLogin, startEmailLogin } from './notion-login.mjs'
import { readBrowserSession } from './browser-cookies.mjs'
import { applyTranscriptLine, createLineReader, createTranscript, transcriptReasoning, transcriptText } from './ndjson.mjs'
import { buildPrompt, buildRepairPrompt, looksLikeRefusal, parseToolCalls } from './prompt.mjs'

const PROVIDER = 'notion'
const VERSION = '0.1.0'

// Notion's own web search, off unless the launcher asks for it
// (NOTION_WEB_SEARCH=1): every turn then carries a search round trip, which
// costs time the caller may not want to pay by default.
const WEB_SEARCH = /^(1|true|yes|on)$/i.test(String(globalThis.process?.env?.NOTION_WEB_SEARCH ?? ''))

// Notion's own model codes, with the names its picker shows. A model's key in
// magpie is the friendly id; `id` is the code the upstream request carries.
const DEFAULT_MODELS = {
  auto: { name: 'Auto (Notion picks)', code: '', context: 200000 },
  'gpt-5.4': { name: 'GPT-5.4', code: 'oval-kumquat-medium', context: 200000 },
  'gpt-5.2': { name: 'GPT-5.2', code: 'oatmeal-cookie', context: 200000 },
  'gpt-5.4-mini': { name: 'GPT-5.4 Mini', code: 'oregon-grape-medium', context: 200000 },
  'gpt-5.4-nano': { name: 'GPT-5.4 Nano', code: 'otaheite-apple-medium', context: 200000 },
  'opus-4.7': { name: 'Claude Opus 4.7', code: 'apricot-sorbet-medium', context: 200000 },
  'opus-4.6': { name: 'Claude Opus 4.6', code: 'avocado-froyo-medium', context: 200000 },
  'sonnet-4.6': { name: 'Claude Sonnet 4.6', code: 'almond-croissant-low', context: 200000 },
  'haiku-4.5': { name: 'Claude Haiku 4.5', code: 'anthropic-haiku-4.5', context: 200000 },
  'gemini-3.1-pro': { name: 'Gemini 3.1 Pro', code: 'galette-medium-thinking', context: 1000000 },
  'gemini-3-flash': { name: 'Gemini 3 Flash', code: 'gingerbread', context: 1000000 },
  'gemini-2.5-flash': { name: 'Gemini 2.5 Flash', code: 'vertex-gemini-2.5-flash', context: 1000000 },
  'minimax-m2.5': { name: 'MiniMax M2.5', code: 'fireworks-minimax-m2.5', context: 200000 },
}

function modelEntry({ name, code, context, efforts }, fallbackId) {
  // magpie rewrites a model the `models` hook returns as {...model, id: key},
  // so the code the upstream request carries has to be in api.id: a model that
  // only sets id would send its magpie name, and Notion would answer as
  // whichever model it falls back to.
  const apiId = code || fallbackId
  const entry = {
    id: apiId,
    api: { id: apiId },
    name,
    limit: { context: context || 200000, output: 32000 },
    // A `models` hook's entry is taken as it comes, so the capability has to
    // be here too: magpie reads capabilities.reasoning to decide whether the
    // model reasons at all, and without it the reasoning levels a model
    // serves are never offered. The flat fields beside it are what the
    // config hook's own table is read for.
    capabilities: {
      temperature: true,
      reasoning: true,
      toolcall: true,
      input: { text: true, image: false },
      output: { text: true },
    },
    reasoning: true,
    tool_call: true,
    modalities: { input: ['text'], output: ['text'] },
  }
  // A model that serves more than one level gets them offered as variants;
  // one with a single level has it baked into its code.
  const levels = Array.isArray(efforts) ? efforts.filter((effort) => KNOWN_EFFORTS.includes(effort)) : []
  if (levels.length > 1) entry.variants = Object.fromEntries(levels.map((effort) => [effort, {}]))
  return entry
}

function defaultModelConfig() {
  const models = {}
  for (const [id, model] of Object.entries(DEFAULT_MODELS)) {
    models[id] = modelEntry(model, id)
  }
  return models
}

/** The user, the space and the version header, read off the sign-in's cookie. */
async function discoverAccount(cookie, clientVersion, { signal } = {}) {
  const version = clientVersion || (await fetchClientVersion({ signal })) || FALLBACK_CLIENT_VERSION
  const discovered = await loadAccount({ cookie, clientVersion: version }, { signal })
  return {
    cookie,
    clientVersion: version,
    userId: discovered.userId,
    spaceId: discovered.spaceId,
    spaceViewId: discovered.spaceViewId || '',
    userName: discovered.userName || '',
    email: discovered.email || '',
    spaceName: discovered.spaceName || '',
    planType: discovered.planType || '',
  }
}

function accountFields(metadata) {
  return {
    clientVersion: metadata.clientVersion,
    userId: metadata.userId,
    spaceId: metadata.spaceId,
    spaceViewId: metadata.spaceViewId || '',
    userName: metadata.userName || '',
    email: metadata.email || '',
    spaceName: metadata.spaceName || '',
    planType: metadata.planType || '',
  }
}

/** "Claude Opus 5.5" → opus-5.5, for a model Notion lists and our table does not. */
function slugModelID(name) {
  const slug = String(name || '')
    .toLowerCase()
    .replace(/^claude[- ]/, '')
    .replace(/[^a-z0-9.+-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug
}

/**
 * What the picker shows: the models Notion says this account has. A model our
 * table already knows keeps the id it had, so an agent's choice survives; the
 * rest are named after what Notion calls them.
 */
function mergeAccountModels(base, listed) {
  const byApiId = new Map()
  for (const [id, model] of Object.entries(base)) {
    if (model?.id) byApiId.set(model.id, id)
  }
  const models = {}
  for (const [id, model] of Object.entries(base)) {
    if (id === 'auto' || !model?.id) models[id] = model
  }
  for (const entry of listed) {
    const known = byApiId.get(entry.apiId)
    let id = known || slugModelID(entry.name)
    if (!id) id = entry.apiId
    if (models[id] && !known) id = `${id}-${entry.apiId}`
    const previous = base[id]
    models[id] = modelEntry(
      {
        name: entry.name,
        code: entry.apiId,
        context: previous?.limit?.context ?? DEFAULT_MODELS[id]?.context,
        efforts: entry.efforts,
      },
      id,
    )
  }
  return models
}

/** The account behind a sign-in, discovering what the cookie implies once. */
async function accountFor(auth, client, signal) {
  const cookie = (auth?.key ?? '').trim()
  if (!cookie) {
    throw Object.assign(new Error('Notion is not signed in: sign in with an email code, your browser session, or by pasting a cookie'), {
      signIn: 'expired',
    })
  }
  const metadata = auth?.metadata ?? {}
  if (metadata.clientVersion && metadata.userId && metadata.spaceId) {
    return { cookie, ...accountFields(metadata) }
  }

  const account = await discoverAccount(cookie, metadata.clientVersion, { signal })
  try {
    const { cookie: _cookie, ...cacheable } = account
    await client?.auth?.set?.({
      path: { id: PROVIDER },
      body: { ...auth, metadata: { ...metadata, ...cacheable } },
    })
  } catch {
    // caching is a convenience; a later request rediscovers it
  }
  return account
}

/** The sign-in an email-code login ends with, ready to be saved. */
async function metadataForToken(token, clientVersion, { signal } = {}) {
  const account = await discoverAccount(token, clientVersion, { signal })
  const { cookie: _cookie, ...metadata } = account
  return metadata
}

function emailCodeMethod() {
  return {
    type: 'oauth',
    label: 'Notion email code',
    prompts: [
      {
        type: 'text',
        key: 'email',
        message: 'Notion account email',
        placeholder: 'you@example.com',
        validate: (value) =>
          /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value ?? '').trim()) ? undefined : 'a full email address',
      },
    ],
    async authorize(inputs) {
      // A failure here has to throw: magpie reads a returned failure as an
      // immediate callback and would ask for a code that was never sent.
      const state = await startEmailLogin(inputs?.email)
      return {
        url: '',
        instructions: `Notion emailed a code to ${state.email}. Enter it below.`,
        method: 'code',
        async callback(code) {
          try {
            const { cookieHeader, userId } = await finishEmailLogin(state, code)
            const metadata = await metadataForToken(cookieHeader, state.clientVersion)
            return { type: 'success', key: cookieHeader, metadata: { ...metadata, userId: userId || metadata.userId } }
          } catch (error) {
            return { type: 'failed', error: error?.message ?? String(error) }
          }
        },
      }
    },
  }
}

function browserSessionMethod() {
  return {
    type: 'oauth',
    label: "This computer's browser session",
    async authorize() {
      const found = await readBrowserSession()
      if (!found?.cookieHeader) {
        const why = found?.tried?.length ? `（${found.tried.join('；')}）` : ''
        throw new NotionError(
          `no usable notion.so session in a local browser${why}. Sign in to Notion in Chrome first, or use the email code`,
        )
      }
      return {
        url: '',
        instructions: `using the ${found.browser} session in profile ${found.profile}. Nothing else to do.`,
        method: 'auto',
        async callback() {
          try {
            const metadata = await metadataForToken(found.cookieHeader, '')
            return {
              type: 'success',
              key: found.cookieHeader,
              metadata: { ...metadata, source: `${found.browser}/${found.profile}` },
            }
          } catch (error) {
            return { type: 'failed', error: error?.message ?? String(error) }
          }
        },
      }
    },
  }
}


/** How hard the caller asked this turn to think, in Notion's words. */
function requestedEffort(body) {
  const asked =
    body?.reasoning_effort ??
    body?.reasoningEffort ??
    (body?.reasoning && typeof body.reasoning === 'object' ? body.reasoning.effort : body?.reasoning) ??
    ''
  return normalizeEffort(asked)
}

function jsonResponse(status, body, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...extraHeaders },
  })
}

function errorResponse(error) {
  const expired = error?.signIn === 'expired'
  const status = expired ? 401 : 502
  const headers = expired ? { 'x-magpie-sign-in': 'expired' } : {}
  return jsonResponse(
    status,
    {
      error: {
        message: error?.message || 'Notion request failed',
        type: expired ? 'invalid_request_error' : 'api_error',
        code: expired ? 'sign_in_expired' : 'notion_upstream_error',
      },
    },
    headers,
  )
}

/** Reads Notion's NDJSON reply, reporting the text as it grows. */
async function consumeTranscript(stream, onProgress, { signal, threadId } = {}) {
  const startedAt = Date.now()
  const lines = createLineReader()
  const decoder = new TextDecoder()
  const state = createTranscript()
  state.threadId = threadId
  const reader = stream.getReader()
  let emitted = ''
  let latest = ''

  const feed = async (line) => {
    const trimmed = line.trim()
    if (!trimmed) return
    let parsed
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      return
    }
    if (!applyTranscriptLine(state, parsed)) return
    const text = transcriptText(state)
    if (text === latest) return
    latest = text
    if (onProgress) await onProgress(text, emitted)
    emitted = text
  }

  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      for (const line of lines.push(decoder.decode(value, { stream: true }))) await feed(line)
    }
    const tail = decoder.decode()
    for (const line of [...lines.push(tail), ...lines.flush()]) await feed(line)
  } finally {
    try {
      await reader.cancel()
    } catch {
      // the stream is over either way
    }
  }
  if (signal?.aborted) throw new NotionError('the client stopped waiting for this request')
  return { text: transcriptText(state) || latest, reasoning: transcriptReasoning(state), duration: Date.now() - startedAt }
}

function completionID() {
  return `chatcmpl-notion-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

// The 30s ceiling was impit's client timeout, not Notion's (fixed at the
// transport: a 39.5s reply now comes back complete). A long reply is no longer
// evidence of a cut-off one, so nothing is marked truncated by duration.
const NOTION_CUTOFF_MS = null

function bufferedMessage(result) {
  const { content, toolCalls } = parseToolCalls(result.text)
  const message = { role: 'assistant', content: toolCalls.length ? content || null : result.text }
  if (toolCalls.length) message.tool_calls = toolCalls
  if (result.reasoning) message.reasoning_content = result.reasoning
  const truncated = false
  return { message, toolCalls, truncated }
}

function bufferedResponse({ model, result }) {
  const { message, toolCalls, truncated } = bufferedMessage(result)
  return jsonResponse(200, {
    id: completionID(),
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, finish_reason: toolCalls.length ? 'tool_calls' : truncated ? 'length' : 'stop' }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  })
}

/**
 * Streams the reply the way an OpenAI-compatible client reads it. Calls cannot
 * be told apart from prose until the tag closes, so a request that declared
 * tools is answered in one piece at the end instead of tag by tag.
 */
function streamingResponse({ model, upstream, signal, threadId, deferContent }) {
  const id = completionID()
  const created = Math.floor(Date.now() / 1000)
  const encoder = new TextEncoder()
  const body = new ReadableStream({
    async start(controller) {
      const send = (payload) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`))
      const chunk = (delta, finishReason) => ({
        id,
        object: 'chat.completion.chunk',
        created,
        model,
        choices: [{ index: 0, delta, finish_reason: finishReason ?? null }],
      })
      try {
        const result = await consumeTranscript(
          upstream,
          deferContent
            ? null
            : async (text, emitted) => {
                if (text.length <= emitted.length) return
                send(chunk({ content: text.slice(emitted.length) }))
              },
          { signal, threadId },
        )
        const { message, toolCalls, truncated } = bufferedMessage(result)
        if (deferContent) {
          if (message.content) send(chunk({ content: message.content }))
          if (message.reasoning_content) send(chunk({ reasoning_content: message.reasoning_content }))
        }
        if (toolCalls.length) {
          send(
            chunk(
              {
                tool_calls: toolCalls.map((call, index) => ({
                  index,
                  id: call.id,
                  type: 'function',
                  function: call.function,
                })),
              },
              'tool_calls',
            ),
          )
        } else if (!String(result.text ?? '').trim()) {
          // Nothing at all: an overloaded turn. Say so, rather than ending on
          // an empty reply the client reads as a refusal.
          send({
            ...chunk({}, 'stop'),
            error: { message: 'Notion returned an empty reply (likely rate limited); retry the turn', type: 'empty_reply' },
          })
        } else {
          send(chunk({}, truncated ? 'length' : 'stop'))
        }
      } catch (error) {
        send({ ...chunk({}, 'stop'), error: { message: error?.message || 'Notion request failed', type: 'api_error' } })
      } finally {
        controller.enqueue(encoder.encode('data: [DONE]\n\n'))
        controller.close()
      }
    },
    cancel() {
      Promise.resolve(upstream?.cancel?.()).catch(() => {})
    },
  })
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' },
  })
}

/**
 * The same SSE shape, built from a reply that was already read to its end so it
 * could be inspected (a tool turn, or a repaired one). A call cannot be told
 * from prose until the reply closes, so the client sees it in one piece anyway.
 */
function bufferedStreamingResponse({ model, result }) {
  const id = completionID()
  const created = Math.floor(Date.now() / 1000)
  const encoder = new TextEncoder()
  const body = new ReadableStream({
    start(controller) {
      const send = (payload) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`))
      const chunk = (delta, finishReason) => ({
        id,
        object: 'chat.completion.chunk',
        created,
        model,
        choices: [{ index: 0, delta, finish_reason: finishReason ?? null }],
      })
      try {
        const { message, toolCalls, truncated } = bufferedMessage(result)
        if (message.content) send(chunk({ content: message.content }))
        if (message.reasoning_content) send(chunk({ reasoning_content: message.reasoning_content }))
        if (toolCalls.length) {
          send(
            chunk(
              {
                tool_calls: toolCalls.map((call, index) => ({
                  index,
                  id: call.id,
                  type: 'function',
                  function: call.function,
                })),
              },
              'tool_calls',
            ),
          )
        } else if (!String(result.text ?? '').trim()) {
          // Nothing at all: an overloaded turn. Say so, rather than ending on
          // an empty reply the client reads as a refusal.
          send({
            ...chunk({}, 'stop'),
            error: { message: 'Notion returned an empty reply (likely rate limited); retry the turn', type: 'empty_reply' },
          })
        } else {
          send(chunk({}, truncated ? 'length' : 'stop'))
        }
      } catch (error) {
        send({ ...chunk({}, 'stop'), error: { message: error?.message || 'Notion request failed', type: 'api_error' } })
      } finally {
        controller.enqueue(encoder.encode('data: [DONE]\n\n'))
        controller.close()
      }
    },
  })
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' },
  })
}

export const NotionPlugin = async ({ client }) => ({
  config: async (cfg) => {
    cfg.provider ??= {}
    cfg.provider[PROVIDER] ??= {
      name: 'Notion AI',
      npm: '@ai-sdk/openai-compatible',
      api: `${notionOrigin()}/api/v3`,
      models: defaultModelConfig(),
    }
  },

  auth: {
    provider: PROVIDER,
    methods: [
      emailCodeMethod(),
      browserSessionMethod(),
      {
        type: 'api',
        label: 'Notion cookie (token_v2, or the whole document.cookie)',
        placeholder: 'token_v2=…',
      },
    ],

    async loader(getAuth) {
      const auth = await getAuth()
      return {
        baseURL: `${notionOrigin()}/api/v3`,
        apiKey: auth?.key ?? '',
        fetch: async (_input, init) => {
          const signal = init?.signal ?? undefined
          let body = {}
          try {
            body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}')
          } catch {
            return errorResponse(new NotionError('the request body was not JSON'))
          }
          try {
            const account = await accountFor(auth, client, signal)
            const parallelToolCalls = body.parallel_tool_calls !== false
            const built = buildPrompt(body.messages, {
              tools: body.tools,
              parallelToolCalls,
            })
            const requested = typeof body.model === 'string' ? body.model : 'auto'
            const notionModel = requested === 'auto' ? '' : requested
            const effort = requestedEffort(body)
            let { response, threadId } = await runInferenceTranscript(account, {
              prompt: built.prompt,
              notionModel,
              instructions: built.instructions,
              webSearch: WEB_SEARCH,
              effort,
              signal,
            })
            // A turn that carries tools is answered in one piece anyway, so it
            // can be inspected before the client sees it: a reply that refused
            // on Notion's own identity gets one repair round, because the caller
            // is an agent that would have executed the action itself.
            if (built.toolCount > 0) {
              let result = await consumeTranscript(response.body, null, { signal, threadId })
              // Notion answers an overloaded turn with nothing at all — the
              // stream ends in under a second with no words. Asking once more
              // after a moment is cheaper than handing the client an empty
              // reply it cannot tell from a refusal.
              if (!String(result.text ?? '').trim()) {
                await new Promise((resolve) => setTimeout(resolve, 2500))
                const again = await runInferenceTranscript(account, {
                  prompt: built.prompt,
                  notionModel,
                  instructions: built.instructions,
                  webSearch: WEB_SEARCH,
                  effort,
                  signal,
                })
                threadId = again.threadId
                result = await consumeTranscript(again.response.body, null, { signal, threadId })
              }
              if (!parseToolCalls(result.text).toolCalls.length && looksLikeRefusal(result.text)) {
                const repaired = buildRepairPrompt({
                  messages: body.messages,
                  tools: body.tools,
                  parallelToolCalls,
                })
                const again = await runInferenceTranscript(account, {
                  prompt: repaired.prompt,
                  notionModel,
                  instructions: repaired.instructions,
                  webSearch: WEB_SEARCH,
                  effort,
                  signal,
                })
                threadId = again.threadId
                const retried = await consumeTranscript(again.response.body, null, { signal, threadId })
                if (parseToolCalls(retried.text).toolCalls.length || !looksLikeRefusal(retried.text)) {
                  result = retried
                }
              }
              if (body.stream === false) return bufferedResponse({ model: requested, result })
              return bufferedStreamingResponse({ model: requested, result })
            }
            if (body.stream === false) {
              let result = await consumeTranscript(response.body, null, { signal, threadId })
              if (!String(result.text ?? '').trim()) {
                await new Promise((resolve) => setTimeout(resolve, 2500))
                const again = await runInferenceTranscript(account, {
                  prompt: built.prompt,
                  notionModel,
                  instructions: built.instructions,
                  webSearch: WEB_SEARCH,
                  effort,
                  signal,
                })
                threadId = again.threadId
                result = await consumeTranscript(again.response.body, null, { signal, threadId })
              }
              return bufferedResponse({ model: requested, result })
            }
            return streamingResponse({
              model: requested,
              upstream: response.body,
              signal,
              threadId,
              deferContent: false,
            })
          } catch (error) {
            return errorResponse(error)
          }
        },
      }
    },
  },

  provider: {
    id: PROVIDER,
    // What this account has, asked of Notion. A read that fails leaves the
    // table above in place; a refused sign-in is passed on so magpie can mark
    // the account instead of quietly showing a list it cannot use.
    async models(provider, { auth } = {}) {
      if (!auth?.key) return provider.models
      const account = await accountFor(auth, null, undefined)
      try {
        const listed = await fetchAvailableModels(account)
        if (!listed.length) return provider.models
        return mergeAccountModels(provider.models, listed)
      } catch (error) {
        if (error?.signIn === 'expired') throw error
        return provider.models
      }
    },
  },
})

export const _internal = {
  DEFAULT_MODELS,
  requestedEffort,
  slugModelID,
  mergeAccountModels,
  accountFor,
  consumeTranscript,
  modelEntry,
  bufferedMessage,
  discoverAccount,
  metadataForToken,
  emailCodeMethod,
  browserSessionMethod,
  VERSION,
}
