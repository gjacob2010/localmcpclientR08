import express from 'express';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import dotenv from 'dotenv';
import crypto from 'crypto';

dotenv.config();

const app = express();
app.use(express.json());
app.use(express.static('public'));

// Store MCP client instances
const mcpClients = new Map();
const connectionTimestamps = new Map();

// Cloudflare AI Search configuration
const CF_ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID;
const CF_AI_SEARCH_NAME = process.env.CLOUDFLARE_AI_SEARCH_NAME;
const CF_API_TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const CF_AI_SEARCH_URL = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/ai-search/instances/obgyn4`;

let aiSearchReady = false;
let activeSearchUrl = CF_AI_SEARCH_URL;

async function initAISearch() {
  if (!CF_ACCOUNT_ID || !CF_AI_SEARCH_NAME || !CF_API_TOKEN) {
    throw new Error('Missing Cloudflare AI Search credentials in .env file');
  }

  try {
    const response = await fetch(`${CF_AI_SEARCH_URL}/search`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${CF_API_TOKEN}`
      },
      body: JSON.stringify({
        messages: [{ role: 'user', content: 'test' }],
        ai_search_options: { retrieval: { max_num_results: 1 } }
      })
    });

    if (!response.ok) {
      const err = await response.json();
      throw new Error(`AI Search connection failed: ${JSON.stringify(err.errors)}`);
    }

    aiSearchReady = true;
    activeSearchUrl = CF_AI_SEARCH_URL;
    console.log('Cloudflare AI Search initialized successfully');
    return true;
  } catch (error) {
    console.error('AI Search init error:', error);
    throw error;
  }
}

async function initAISearchGyn() {
  if (!CF_ACCOUNT_ID || !CF_API_TOKEN) {
    throw new Error('Missing Cloudflare AI Search credentials in .env file');
  }

  const GYN_URL = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/ai-search/instances/gyne1`;

  try {
    const response = await fetch(`${GYN_URL}/search`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${CF_API_TOKEN}`
      },
      body: JSON.stringify({
        messages: [{ role: 'user', content: 'test' }],
        ai_search_options: { retrieval: { max_num_results: 1 } }
      })
    });

    if (!response.ok) {
      const err = await response.json();
      throw new Error(`AI Search connection failed: ${JSON.stringify(err.errors)}`);
    }

    aiSearchReady = true;
    activeSearchUrl = GYN_URL;
    console.log('Cloudflare AI Search Gyne initialized successfully');
    return true;
  } catch (error) {
    console.error('AI Search init error:', error);
    throw error;
  }
}

async function initAISearchSMFM() {
  if (!CF_ACCOUNT_ID || !CF_API_TOKEN) {
    throw new Error('Missing Cloudflare AI Search credentials in .env file');
  }

  const SMFM_URL = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/ai-search/instances/smfm-guidelines`;

  try {
    const response = await fetch(`${SMFM_URL}/search`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${CF_API_TOKEN}`
      },
      body: JSON.stringify({
        messages: [{ role: 'user', content: 'test' }],
        ai_search_options: { retrieval: { max_num_results: 1 } }
      })
    });

    if (!response.ok) {
      const err = await response.json();
      throw new Error(`AI Search connection failed: ${JSON.stringify(err.errors)}`);
    }

    aiSearchReady = true;
    activeSearchUrl = SMFM_URL;
    console.log('Cloudflare AI Search SMFM initialized successfully');
    return true;
  } catch (error) {
    console.error('AI Search init error:', error);
    throw error;
  }
}

async function queryAISearch(question) {
  if (!aiSearchReady) {
    throw new Error('Cloudflare AI Search not initialized');
  }

  const response = await fetch(`${activeSearchUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${CF_API_TOKEN}`
    },
    body: JSON.stringify({
      messages: [{ role: 'user', content: question }],
      ai_search_options: {
        retrieval: {
          max_num_results: 10,
          match_threshold: 0.4
        }
      }
    })
  });

  if (!response.ok) {
    const err = await response.json();
    throw new Error(`AI Search query failed: ${JSON.stringify(err.errors)}`);
  }

  const data = await response.json();

  return {
    textResponse: data.choices?.[0]?.message?.content || null,
    sources: data.chunks?.map(c => c.item?.key) || []
  };
}

async function connectToSSEServer(serverId, url) {
  const client = new Client({
    name: 'mcp-openrouter-client',
    version: '1.0.0'
  }, {
    capabilities: {
      tools: {},
      resources: {},
      prompts: {}
    }
  });

  const transport = new SSEClientTransport(new URL(url));
  await client.connect(transport);
  mcpClients.set(serverId, client);

  return client;
}

async function connectToStdioServer(serverId, config) {
  const client = new Client({
    name: 'mcp-openrouter-client',
    version: '1.0.0'
  }, {
    capabilities: {
      tools: {},
      resources: {},
      prompts: {}
    }
  });

  const transport = new StdioClientTransport({
    command: config.command,
    args: config.args,
    env: config.env
  });

  await client.connect(transport);
  mcpClients.set(serverId, client);

  return client;
}

// ════════════════════════════════════════════════════════════════════════
// Jev
//
// Jev is used in exactly ONE place: once a tool call has been decided on
// (by the LLM, via ordinary function-calling — see /api/chat below), Jev
// resolves that tool's enum/gateway parameters from the conversation
// (askJevResolveToolParams). It never picks WHICH tool to call — that is
// entirely the LLM's decision, offered every tool in the catalog (minus
// write tools if POST_TOOL_MODE is 'off') in a standard 'auto' round.
//
// Jev runs once per tool call that has enum parameters, right before that
// call executes. Free-text arguments are filled by the LLM as normal;
// Jev only ever overrides the enum/gateway ones, and only when confident.
// ════════════════════════════════════════════════════════════════════════

async function askJev(state, questions) {
  const response = await fetch('https://api.typesafe.ai/v1/systemone', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.TYPESAFE_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'jev-latest',
      state,
      questions
    })
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Jev API error: ${err}`);
  }

  return response.json();
}

// Minimum confidence Jev must have when resolving ONE gateway/enum
// parameter. A parameter that doesn't clear this is NOT guessed at — if
// it's REQUIRED, the tool call is skipped and turned into a direct
// clarifying note to the clinician instead (see askJevResolveToolParams
// and its call site in /api/chat).
const PARAM_RESOLUTION_CONFIDENCE_THRESHOLD = parseFloat(
  process.env.PARAM_RESOLUTION_CONFIDENCE_THRESHOLD || '0.2'
);

// A tool call that ERRORS on execution is retried up to this many times
// with the same arguments. This is the only reason a tool call runs more
// than once.
const MAX_FAILED_ATTEMPTS = 2;

// The LLM can call tools, see their results, and call more tools in
// response, same as any normal agentic tool-use loop. This caps how many
// such rounds happen before Claude is forced to answer with no tools
// offered, so a model that keeps calling tools can't loop forever.
const MAX_TOOL_ROUNDS = parseInt(process.env.MAX_TOOL_ROUNDS || '4', 10);

// What happens with POST / write tools:
//   'llm' (default): offered to the LLM alongside read tools, every round.
//   'off':            write tools are never offered at all.
const POST_TOOL_MODE = (process.env.POST_TOOL_MODE || 'llm').toLowerCase();

// ── Read vs POST detection (used only to gate write tools out entirely
//    when POST_TOOL_MODE is 'off' — read/write no longer changes how a
//    tool gets selected, since the LLM picks every tool itself) ─────────
const parseList = (v) => (v || '').split(',').map(s => s.trim()).filter(Boolean);
const READ_TOOL_OVERRIDES = new Set(parseList(process.env.READ_TOOLS));
const POST_TOOL_OVERRIDES = new Set(parseList(process.env.POST_TOOLS));

const WRITE_NAME_VERBS = new Set([
  'post', 'put', 'patch', 'delete', 'create', 'update', 'insert', 'submit', 'send',
  'save', 'write', 'add', 'remove', 'upload', 'register', 'cancel', 'modify', 'edit',
  'order', 'book', 'schedule'
]);
const READ_NAME_VERBS = new Set([
  'get', 'list', 'search', 'find', 'fetch', 'read', 'lookup', 'retrieve', 'query',
  'calculate', 'compute', 'check', 'estimate', 'predict', 'assess', 'classify',
  'score', 'show', 'view', 'describe', 'explain'
]);

function classifyTool(tool) {
  const name = tool.name || '';
  const text = `${name}\n${tool.description || ''}`;

  if (POST_TOOL_OVERRIDES.has(name)) return { kind: 'write', reason: 'POST_TOOLS override' };
  if (READ_TOOL_OVERRIDES.has(name)) return { kind: 'read', reason: 'READ_TOOLS override' };

  const ann = tool.annotations || {};
  if (ann.destructiveHint === true) return { kind: 'write', reason: 'annotation destructiveHint' };
  if (ann.readOnlyHint === true) return { kind: 'read', reason: 'annotation readOnlyHint' };

  const hasWriteVerb = /\b(POST|PUT|PATCH|DELETE)\b/.test(text);
  const hasGet = /\bGET\b/.test(text);
  if (hasWriteVerb && !hasGet) return { kind: 'write', reason: 'HTTP write verb in name/description' };
  if (hasGet && !hasWriteVerb) return { kind: 'read', reason: 'HTTP GET in name/description' };

  const firstWord = name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)[0]
    ?.toLowerCase();
  if (firstWord && WRITE_NAME_VERBS.has(firstWord)) return { kind: 'write', reason: `name starts with "${firstWord}"` };
  if (firstWord && READ_NAME_VERBS.has(firstWord)) return { kind: 'read', reason: `name starts with "${firstWord}"` };

  return { kind: 'read', reason: 'default (no read/write signal found)' };
}

// ── Schema helpers ─────────────────────────────────────────────────────
function unwrapSchema(def = {}) {
  if (Array.isArray(def.anyOf)) {
    const branch = def.anyOf.find(s => s && s.type !== 'null');
    if (branch) {
      return { ...branch, description: def.description ?? branch.description };
    }
  }
  return def;
}

function buildJevState(conversationMessages) {
  return conversationMessages
    .filter(m => ['user', 'assistant', 'tool'].includes(m.role))
    .map(m => {
      if (m.role === 'tool') {
        const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
        return `tool_result: ${content.slice(0, 800)}`;
      }
      if (typeof m.content === 'string' && m.content.trim() !== '') {
        return `${m.role}: ${m.content}`;
      }
      return null;
    })
    .filter(Boolean)
    .join('\n');
}

// Resolves ONE tool's enum/gateway parameters from the conversation. Each
// parameter gets an explicit UNKNOWN option, and Jev is told not to guess
// — a parameter only counts as resolved if Jev is both confident AND
// didn't pick UNKNOWN. REQUIRED parameters that don't resolve are returned
// in `unresolvedRequired` (with their label + full choice list) rather
// than being guessed at or silently dropped — the caller (in /api/chat)
// turns those into a direct clarifying note instead of calling the tool.
async function askJevResolveToolParams(clinicalState, tool) {
  const props = tool?.schema?.properties || {};
  const required = new Set(tool?.schema?.required || []);
  const UNKNOWN = 'UNKNOWN';

  const questions = {};
  const optionMaps = {};
  const labels = {};

  for (const [paramName, rawDef] of Object.entries(props)) {
    const paramDef = unwrapSchema(rawDef);
    if (!Array.isArray(paramDef.enum) || paramDef.enum.length === 0) continue;

    optionMaps[paramName] = new Map(paramDef.enum.map(opt => [String(opt), opt]));
    labels[paramName] = paramDef.description || paramName;

    const criteria = {};
    paramDef.enum.forEach(opt => {
      criteria[String(opt)] = paramDef.description
        ? `${paramDef.description} — this option: "${opt}"`
        : `Option: ${opt}`;
    });
    criteria[UNKNOWN] = 'The conversation does not clearly indicate an answer to this yet — do not guess.';

    questions[paramName] = {
      type: 'choice',
      instructions:
        (paramDef.description || `Select the correct value for ${paramName}, given the conversation so far.`) +
        ` Pick ${UNKNOWN} if the conversation doesn't clearly indicate an answer.`,
      criteria
    };
  }

  if (Object.keys(questions).length === 0) {
    return { picks: {}, unresolvedRequired: [] };
  }

  const picks = {};
  const unresolvedRequired = [];

  try {
    const jevResult = await askJev(clinicalState, questions);
    const answers = jevResult.answers || {};

    for (const paramName of Object.keys(questions)) {
      const answer = answers[paramName];
      const map = optionMaps[paramName];
      const resolved =
        answer && answer.type === 'choice' && answer.choice !== UNKNOWN &&
        typeof answer.confidence === 'number' &&
        answer.confidence >= PARAM_RESOLUTION_CONFIDENCE_THRESHOLD &&
        map.has(String(answer.choice));

      if (resolved) {
        picks[paramName] = map.get(String(answer.choice));
      } else if (required.has(paramName)) {
        unresolvedRequired.push({ name: paramName, label: labels[paramName], choices: Array.from(map.values()) });
      }
    }
  } catch (jevError) {
    console.error('Jev param resolution failed, treating all required enum params as unresolved:', jevError.message);
    // Fail toward asking the clinician, never toward guessing or silently
    // dropping the tool.
    for (const paramName of Object.keys(questions)) {
      if (required.has(paramName)) {
        unresolvedRequired.push({ name: paramName, label: labels[paramName], choices: Array.from(optionMaps[paramName].values()) });
      }
    }
  }

  return { picks, unresolvedRequired };
}

// Some OpenRouter providers (e.g. Alibaba/Qwen while in "thinking" mode)
// reject tool_choice: 'auto' or a forced choice with a 400 error in some
// configurations. If that happens, retry once without tool_choice at all.
async function fetchOpenRouterChat(payload) {
  const doFetch = (body) => fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'http://localhost:3000',
      'X-Title': 'MCP OpenRouter Client'
    },
    body: JSON.stringify(body)
  });

  let response = await doFetch(payload);
  let toolChoiceStripped = false;

  if (!response.ok && payload.tool_choice) {
    const errorText = await response.clone().text();
    const toolChoiceUnsupported = /tool_choice/i.test(errorText) &&
      (/thinking mode/i.test(errorText) || /invalid_parameter_error/i.test(errorText));

    if (toolChoiceUnsupported) {
      console.warn(`Provider rejected tool_choice for model "${payload.model}", retrying without it:`, errorText);
      const { tool_choice, ...payloadWithoutForce } = payload;
      response = await doFetch(payloadWithoutForce);
      toolChoiceStripped = true;
    }
  }

  response.toolChoiceStripped = toolChoiceStripped;
  return response;
}

// Convert MCP tools to OpenRouter format
function convertMCPToolsToOpenRouter(mcpTools) {
  return mcpTools.map(tool => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description || '',
      parameters: tool.inputSchema || {
        type: 'object',
        properties: {},
        required: []
      }
    }
  }));
}

// Build the tool catalog for one chat request: every MCP tool (classified
// read/write from its list entry + schema, used only to gate write tools
// when POST_TOOL_MODE is 'off') plus the RAG search tool.
function buildToolCatalog(mcpTools, includeSearch) {
  const catalog = mcpTools.map(t => {
    const { kind, reason } = classifyTool(t);
    return {
      name: t.name,
      description: t.description || '',
      schema: t.inputSchema,
      kind,
      reason,
      source: 'mcp',
      def: convertMCPToolsToOpenRouter([t])[0]
    };
  });

  if (includeSearch) {
    const def = {
      type: 'function',
      function: {
        name: 'search_medical_guidelines',
        description: 'Search comprehensive obstetric and gynecological medical guidelines and clinical protocols using Cloudflare AI Search RAG pipeline.',
        parameters: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'The medical question or clinical scenario to search for in the guidelines.'
            }
          },
          required: ['query']
        }
      }
    };
    const { kind, reason } = classifyTool({ name: def.function.name, description: def.function.description });
    catalog.push({
      name: def.function.name,
      description: def.function.description,
      schema: def.function.parameters,
      kind,
      reason: reason === 'default (no read/write signal found)' ? 'built-in retrieval tool (default: read)' : reason,
      source: 'rag',
      def
    });
  }

  return catalog;
}

// API Routes

app.post('/api/aisearch/init', async (req, res) => {
  try {
    await initAISearch();
    res.json({ success: true, instanceName: 'obgyn4', message: 'Cloudflare AI Search initialized' });
  } catch (error) {
    console.error('AI Search init error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/aisearch/initGyn', async (req, res) => {
  try {
    await initAISearchGyn();
    res.json({ success: true, instanceName: 'gyne1', message: 'Cloudflare AI Search initialized' });
  } catch (error) {
    console.error('AI Search init error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/aisearch/initSMFM', async (req, res) => {
  try {
    await initAISearchSMFM();
    res.json({ success: true, instanceName: 'smfm-guidelines', message: 'Cloudflare AI Search initialized' });
  } catch (error) {
    console.error('AI Search init error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/servers', async (req, res) => {
  try {
    const { serverId, type, url, command, args, env } = req.body;

    if (!serverId) {
      return res.status(400).json({ error: 'serverId is required' });
    }

    const uniqueServerId = `${serverId}-${crypto.randomBytes(4).toString('hex')}`;

    if (type === 'sse') {
      if (!url) {
        return res.status(400).json({ error: 'url is required for sse connections' });
      }
      await connectToSSEServer(uniqueServerId, url);
    } else if (type === 'stdio') {
      await connectToStdioServer(uniqueServerId, { command, args, env });
    } else {
      return res.status(400).json({ error: 'Invalid server type. Use "sse" or "stdio"' });
    }

    connectionTimestamps.set(uniqueServerId, Date.now());

    res.json({ success: true, serverId: uniqueServerId });
  } catch (error) {
    console.error('Connection error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/servers/:serverId/reconnect', async (req, res) => {
  try {
    const { serverId } = req.params;
    const { type, url, command, args, env } = req.body;

    if (mcpClients.has(serverId)) {
      await mcpClients.get(serverId).close().catch(() => {});
      mcpClients.delete(serverId);
      connectionTimestamps.delete(serverId);
    }

    if (type === 'sse') {
      await connectToSSEServer(serverId, url);
    } else if (type === 'stdio') {
      await connectToStdioServer(serverId, { command, args, env });
    } else {
      return res.status(400).json({ error: 'Invalid server type. Use "sse" or "stdio"' });
    }

    connectionTimestamps.set(serverId, Date.now());

    res.json({ success: true, serverId });
  } catch (error) {
    console.error('Reconnect error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/servers', (req, res) => {
  const servers = Array.from(mcpClients.keys());
  res.json({ servers });
});

app.delete('/api/servers/:serverId', async (req, res) => {
  try {
    const { serverId } = req.params;
    const client = mcpClients.get(serverId);

    if (!client) {
      return res.status(404).json({ error: 'Server not found' });
    }

    await client.close();
    mcpClients.delete(serverId);
    connectionTimestamps.delete(serverId);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/servers/:serverId/tools', async (req, res) => {
  try {
    const { serverId } = req.params;
    const client = mcpClients.get(serverId);

    if (!client) {
      return res.status(404).json({ error: 'Server not found' });
    }

    const result = await client.listTools();
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/servers/:serverId/tool-classification', async (req, res) => {
  try {
    const client = mcpClients.get(req.params.serverId);

    if (!client) {
      return res.status(404).json({ error: 'Server not found' });
    }

    const { tools = [] } = await client.listTools();
    res.json({
      postToolMode: POST_TOOL_MODE,
      tools: tools.map(t => ({ name: t.name, ...classifyTool(t) }))
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Chat with OpenRouter (with MCP tool support and streaming)
//
// Standard agentic tool-use loop, up to MAX_TOOL_ROUNDS rounds:
//   1. The LLM is offered every tool in the catalog (all read tools, plus
//      write tools unless POST_TOOL_MODE is 'off'), tool_choice: 'auto'.
//      The LLM decides whether to call anything, and which.
//   2. If it calls nothing, that response IS the final answer — done.
//   3. If it calls tool(s): for each call, Jev resolves that tool's
//      enum/gateway parameters from the conversation
//      (askJevResolveToolParams). Free-text args come from the LLM as
//      normal; Jev's resolved values, when confident, override them for
//      enum params only. If a REQUIRED enum can't be resolved, the tool is
//      skipped with a clarifying note instead of being guessed at.
//      Otherwise it executes, retried up to MAX_FAILED_ATTEMPTS times on
//      execution error (not on a skipped/clarification case).
//   4. Loop back to step 1 with the tool results in context, so the LLM
//      can call more tools if it needs to. After MAX_TOOL_ROUNDS rounds,
//      the LLM is asked once more with no tools offered, forcing a final
//      answer.
app.post('/api/chat', async (req, res) => {
  try {
    const {
      messages,
      model,
      serverId,
    } = req.body;

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    let conversationMessages = [...messages];
    const toolResults = [];

    if (!conversationMessages.some(m => m.role === 'system')) {
      conversationMessages.unshift({
        role: 'system',
        content: `You are a medical decision support assistant. You have NO medical knowledge of your own to rely on: everything you say must come from tool results.

HOW THIS WORKS:
- You decide which tool(s) to call, if any, based on the conversation. Call a tool and fill in its arguments; some arguments (marked as enums in the tool's schema) may be overridden by a separate resolution step before the tool runs.
- When you have what you need, or no tool applies, write the final answer: summarize the tool results already in this conversation.

CRITICAL RULES:
1. Base your entire response ONLY on the information returned by the tools
2. If a tool returns "No relevant medical guidelines found", clearly state that you don't have that information
3. If a tool returned an error, say so briefly and do not guess what it would have returned
4. If a tool call was skipped because required information is missing, tell the clinician what's needed and the valid options
5. Never say "I don't have access to real-time data" - you DO have access via tools
6. Never make assumptions or provide medical information from your training
7. Always cite which tool/source provided the information
8. Keep numbers, units, thresholds, and drug names exactly as the tools returned them
9. Never write out tool calls as text — call them for real, or just answer

Sources of information:
- search_medical_guidelines: comprehensive medical guidelines via Cloudflare AI Search
- Clinical decision support tools (MCP tools on the gradio server)`
      });
    }

    const sendEvent = (event, data) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    // Tool list is fetched once per request, then classified read/write
    // (classification is now only used to gate write tools out entirely
    // when POST_TOOL_MODE is 'off' — the LLM picks among whatever's left).
    let mcpTools = [];
    if (serverId) {
      const client = mcpClients.get(serverId);
      if (client) {
        const listed = await client.listTools();
        mcpTools = listed.tools || [];
      }
    }
    const catalog = buildToolCatalog(mcpTools, aiSearchReady);
    console.log('Tool classification:', catalog.map(t => `${t.name}=${t.kind}`).join(', ') || '(no tools)');

    const offeredCatalog = POST_TOOL_MODE === 'off'
      ? catalog.filter(t => t.kind !== 'write')
      : catalog;
    const toolsForRequest = offeredCatalog.map(t => t.def);
    const offeredToolNames = new Set(offeredCatalog.map(t => t.name));

    // Does one OpenRouter streaming call and returns its accumulated content
    // + tool_calls. Streams `content` deltas to the client as they arrive.
    // Doesn't touch conversationMessages — the caller decides what to do
    // with the result.
    async function streamChatOnce(payload) {
      const openRouterResponse = await fetchOpenRouterChat(payload);

      if (!openRouterResponse.ok) {
        const error = await openRouterResponse.text();
        return { ok: false, error };
      }

      let fullContent = '';
      let toolCalls = [];
      const reader = openRouterResponse.body.getReader();
      const decoder = new TextDecoder();
      let streamBuffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        streamBuffer += decoder.decode(value, { stream: true });
        const lines = streamBuffer.split('\n');
        streamBuffer = lines.pop();

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6);
            if (data === '[DONE]') continue;

            try {
              const parsed = JSON.parse(data);
              const delta = parsed.choices?.[0]?.delta;

              if (delta?.content) {
                fullContent += delta.content;
                sendEvent('content', { content: delta.content });
              }

              if (delta?.tool_calls) {
                for (const tc of delta.tool_calls) {
                  if (!toolCalls[tc.index]) {
                    toolCalls[tc.index] = { id: tc.id || '', type: 'function', function: { name: '', arguments: '' } };
                  }
                  if (tc.function?.name) toolCalls[tc.index].function.name = tc.function.name;
                  if (tc.function?.arguments) toolCalls[tc.index].function.arguments += tc.function.arguments;
                  if (tc.id) toolCalls[tc.index].id = tc.id;
                }
              }
            } catch (e) {
              console.error('Error parsing stream:', e);
            }
          }
        }
      }

      return { ok: true, fullContent, toolCalls: toolCalls.filter(Boolean), toolChoiceStripped: openRouterResponse.toolChoiceStripped };
    }

    // Runs a tool that has an MCP client or is the RAG search tool.
    async function executeTool(calledName, toolArgs) {
      if (calledName === 'search_medical_guidelines') {
        try {
          if (!aiSearchReady) {
            throw new Error('Cloudflare AI Search not initialized. Please initialize RAG first.');
          }
          console.log(`Querying Cloudflare AI Search for: "${toolArgs.query}"`);
          const ragResponse = await queryAISearch(toolArgs.query);
          console.log('Cloudflare AI Search response received');

          if (ragResponse.textResponse) {
            const sourcesText = ragResponse.sources.length > 0
              ? `\n\nSources: ${ragResponse.sources.join(', ')}`
              : '';
            return { result: { content: [{ type: 'text', text: ragResponse.textResponse + sourcesText }] }, ok: true };
          }
          return { result: { content: [{ type: 'text', text: 'No relevant medical guidelines found.' }] }, ok: true };
        } catch (error) {
          console.error('AI Search error:', error);
          return { result: { content: [{ type: 'text', text: `Error searching medical guidelines: ${error.message}` }] }, ok: false };
        }
      }

      const client = mcpClients.get(serverId);
      if (!client) return { hardFailure: true };

      try {
        const result = await client.callTool({ name: calledName, arguments: toolArgs });
        return { result, ok: !result?.isError };
      } catch (mcpError) {
        console.error(`MCP tool call failed for "${calledName}":`, mcpError.message);
        return {
          result: { content: [{ type: 'text', text: `Error calling tool "${calledName}": ${mcpError.message}. You may retry with different arguments.` }] },
          ok: false
        };
      }
    }

    // Runs ONE tool call the LLM already made: resolves its enum params via
    // Jev, executes it (retrying on execution error), and pushes the tool
    // result into conversationMessages. Returns:
    //   { hardFailure: true }  — unrecoverable (ends the response)
    //   { ranTool: true }      — normal case, whether it succeeded, errored,
    //                            or was skipped for missing required info
    async function handleToolCall(toolCall) {
      const calledName = toolCall.function.name;

      if (!offeredToolNames.has(calledName)) {
        console.error(`Model called "${calledName}" but it was not offered this round`);
        conversationMessages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: JSON.stringify({ error: `Tool "${calledName}" is not available right now.` })
        });
        return { ranTool: true };
      }

      let toolArgs;
      try {
        toolArgs = JSON.parse(toolCall.function.arguments || '{}');
      } catch (jsonError) {
        console.error(`JSON parse error for tool ${calledName}:`, jsonError);
        conversationMessages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: JSON.stringify({
            error: `JSON parsing failed: ${jsonError.message}. Please retry with valid JSON.`,
            invalid_json: toolCall.function.arguments
          })
        });
        return { ranTool: true };
      }

      // Jev resolves this tool's enum/gateway parameters from the
      // conversation. Free-text args stay whatever the LLM filled in;
      // resolved enum values (when confident) override them.
      const entry = catalog.find(t => t.name === calledName);
      const state = buildJevState(conversationMessages);
      const { picks, unresolvedRequired } = await askJevResolveToolParams(state, entry);

      if (unresolvedRequired.length > 0) {
        const need = unresolvedRequired
          .map(p => `${p.label} (choices: ${p.choices.join(', ')})`)
          .join('; ');
        console.warn(`Skipping "${calledName}" — missing required info: ${need}`);
        const note = `Tool "${calledName}" was not called: missing required information — ${need}. Ask the clinician for this and it can be called on the next turn.`;

        toolResults.push({ tool: calledName, arguments: toolArgs, rawResult: { content: [{ type: 'text', text: note }] }, displayResult: note });
        sendEvent('tool_result', { tool: calledName, arguments: toolArgs, displayResult: note, ok: false, needsClarification: true });

        conversationMessages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: JSON.stringify({ content: [{ type: 'text', text: note }] })
        });
        return { ranTool: true };
      }

      if (Object.keys(picks).length > 0) {
        for (const [paramName, value] of Object.entries(picks)) {
          console.log(`Applying Jev-resolved value "${value}" for ${paramName}`);
          toolArgs[paramName] = value;
        }
        sendEvent('jev_param_resolution', { tool: calledName, picks });
      }

      sendEvent('tool_call', { tool: calledName, arguments: toolArgs });

      let executed;
      let attempts = 0;
      while (attempts < MAX_FAILED_ATTEMPTS) {
        attempts++;
        executed = await executeTool(calledName, toolArgs);
        if (executed.hardFailure) {
          sendEvent('error', { message: 'MCP server not connected' });
          res.end();
          return { hardFailure: true };
        }
        if (executed.ok) break;
        if (attempts < MAX_FAILED_ATTEMPTS) {
          console.warn(`"${calledName}" errored on attempt ${attempts}/${MAX_FAILED_ATTEMPTS} — retrying`);
        }
      }

      const { result, ok } = executed;

      toolResults.push({
        tool: calledName,
        arguments: toolArgs,
        rawResult: result,
        displayResult: result.content?.[0]?.text || JSON.stringify(result)
      });

      sendEvent('tool_result', {
        tool: calledName,
        arguments: toolArgs,
        rawResult: result,
        displayResult: result.content?.[0]?.text || JSON.stringify(result),
        ok
      });

      conversationMessages.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        content: JSON.stringify(result)
      });

      return { ranTool: true };
    }

    // ── Agentic loop: LLM picks tools, Jev resolves their enum params ──
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const attempt = await streamChatOnce({
        model: model || 'openai/gpt-3.5-turbo',
        messages: conversationMessages,
        tools: toolsForRequest.length > 0 ? toolsForRequest : undefined,
        tool_choice: toolsForRequest.length > 0 ? 'auto' : undefined,
        stream: true
      });

      if (!attempt.ok) {
        sendEvent('error', { message: `OpenRouter API error: ${attempt.error}` });
        res.end();
        return;
      }

      const { fullContent, toolCalls } = attempt;
      const assistantMessage = { role: 'assistant', content: fullContent || null };
      if (toolCalls.length > 0) assistantMessage.tool_calls = toolCalls;
      conversationMessages.push(assistantMessage);

      if (toolCalls.length === 0) {
        // No tool calls: this streamed content IS the final answer.
        sendEvent('done', {
          conversationMessages: conversationMessages,
          toolResults: toolResults
        });
        res.end();
        return;
      }

      sendEvent('tool_calls_start', { count: toolCalls.length });

      for (const toolCall of toolCalls) {
        const outcome = await handleToolCall(toolCall);
        if (outcome.hardFailure) return; // response already ended
      }

      sendEvent('tool_calls_end', {});
      // Loop back with tool results in context — the LLM may call more
      // tools, or write its final answer, on the next round.
    }

    // Hit MAX_TOOL_ROUNDS: force a final answer with no tools offered.
    const finalResponse = await fetchOpenRouterChat({
      model: model || 'openai/gpt-3.5-turbo',
      messages: conversationMessages,
      stream: true
    });

    if (!finalResponse.ok) {
      const error = await finalResponse.text();
      sendEvent('error', { message: `OpenRouter API error: ${error}` });
      res.end();
      return;
    }

    let fullContent = '';
    const reader = finalResponse.body.getReader();
    const decoder = new TextDecoder();
    let streamBuffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      streamBuffer += decoder.decode(value, { stream: true });
      const lines = streamBuffer.split('\n');
      streamBuffer = lines.pop();

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6);
          if (data === '[DONE]') continue;

          try {
            const parsed = JSON.parse(data);
            const delta = parsed.choices?.[0]?.delta?.content;
            if (delta) {
              fullContent += delta;
              sendEvent('content', { content: delta });
            }
          } catch (e) {
            console.error('Error parsing stream:', e);
          }
        }
      }
    }

    conversationMessages.push({ role: 'assistant', content: fullContent || null });

    sendEvent('done', {
      conversationMessages: conversationMessages,
      toolResults: toolResults
    });
    res.end();

  } catch (error) {
    console.error('Chat error:', error);
    try {
      res.write(`event: error\ndata: ${JSON.stringify({ message: error.message })}\n\n`);
      res.end();
    } catch (e) {
      // Response already ended
    }
  }
});

app.post('/api/servers/:serverId/tools/:toolName/call', async (req, res) => {
  try {
    const { serverId, toolName } = req.params;
    const { arguments: toolArgs } = req.body;

    const client = mcpClients.get(serverId);

    if (!client) {
      return res.status(404).json({ error: 'Server not found' });
    }

    const result = await client.callTool({
      name: toolName,
      arguments: toolArgs || {}
    });

    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/servers/:serverId/resources', async (req, res) => {
  try {
    const { serverId } = req.params;
    const client = mcpClients.get(serverId);

    if (!client) {
      return res.status(404).json({ error: 'Server not found' });
    }

    const result = await client.listResources();
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/servers/:serverId/resources/read', async (req, res) => {
  try {
    const { serverId } = req.params;
    const { uri } = req.body;

    const client = mcpClients.get(serverId);

    if (!client) {
      return res.status(404).json({ error: 'Server not found' });
    }

    const result = await client.readResource({ uri });
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/servers/:serverId/prompts', async (req, res) => {
  try {
    const { serverId } = req.params;
    const client = mcpClients.get(serverId);

    if (!client) {
      return res.status(404).json({ error: 'Server not found' });
    }

    const result = await client.listPrompts();
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/servers/:serverId/prompts/:promptName', async (req, res) => {
  try {
    const { serverId, promptName } = req.params;
    const { arguments: promptArgs } = req.body;

    const client = mcpClients.get(serverId);

    if (!client) {
      return res.status(404).json({ error: 'Server not found' });
    }

    const result = await client.getPrompt({
      name: promptName,
      arguments: promptArgs || {}
    });

    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    connectedServers: mcpClients.size,
    aiSearchReady: aiSearchReady,
    activeSearchUrl: activeSearchUrl,
    aiSearchInstance: activeSearchUrl.includes('gyne1') ? 'Gynecology' : 'obgyn4'
  });
});

initAISearch()
  .then(() => console.log('AI Search ready'))
  .catch(err => console.error('AI Search init failed on startup:', err.message));

setInterval(async () => {
  const now = Date.now();
  const maxAge = 2 * 60 * 60 * 1000; // 2 hours

  for (const [id, timestamp] of connectionTimestamps.entries()) {
    if (now - timestamp > maxAge) {
      const client = mcpClients.get(id);
      if (client) {
        try {
          await client.close();
          console.log(`Cleaned up stale connection: ${id}`);
        } catch (e) {
          console.error(`Error closing stale connection ${id}:`, e);
        }
        mcpClients.delete(id);
      }
      connectionTimestamps.delete(id);
    }
  }
}, 30 * 60 * 1000);

process.on('SIGTERM', async () => {
  console.log('Shutting down...');
  for (const [serverId, client] of mcpClients) {
    try {
      await client.close();
      console.log(`Closed connection to ${serverId}`);
    } catch (error) {
      console.error(`Error closing ${serverId}:`, error);
    }
  }
  process.exit(0);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`MCP OpenRouter Client running on http://localhost:${PORT}`);
  console.log(`Cloudflare AI Search RAG ready - instance: obgyn4`);
});
