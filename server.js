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
// Jev is used in exactly two places, and ONLY for READ tools:
//   1. scoring every read tool with ONE holistic "call now / not yet" choice
//      question that considers its full parameter schema (every param,
//      every enum's options) as a whole — never the tool's name/title,
//      which is often an opaque, uninformative ID — and running every tool
//      whose confidence on "call now" clears the bar (askJevMultiToolSelection)
//   2. for each tool that gets selected, picking the value of its enum
//      parameters (askJevResolveToolParams)
// Everything else (filling free-text args, summarizing) is the LLM's job.
// POST / write tools never go through Jev.
//
// Both happen ONCE per chat turn, not in a loop. Selection scores the whole
// candidate list one time; each selected tool is then executed once, with
// retries reserved for actual execution errors (see MAX_FAILED_ATTEMPTS) —
// never re-run through Jev just because an earlier round finished.
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

// Minimum confidence Jev must have that a tool is TOPICALLY relevant before
// it's offered at all. This is deliberately a coarse bar — it does NOT
// require every parameter to already be answerable, just that the tool's
// subject matter matches what's being discussed. See PARAM_RESOLUTION_
// CONFIDENCE_THRESHOLD below for the (separate) bar each individual gateway/
// enum parameter has to clear once a tool is selected.
const TOOL_SELECTION_CONFIDENCE_THRESHOLD = 0.2;

// Minimum confidence Jev must have when resolving ONE gateway/enum parameter
// of an already-selected tool. A parameter that doesn't clear this is NOT
// guessed at and does NOT block the tool from ever being selected — if it's
// REQUIRED, it becomes a direct clarifying note to the clinician instead of
// a guessed or silently-dropped argument (see askJevResolveToolParams and
// its call site in /api/chat).
const PARAM_RESOLUTION_CONFIDENCE_THRESHOLD = parseFloat(
  process.env.PARAM_RESOLUTION_CONFIDENCE_THRESHOLD || String(TOOL_SELECTION_CONFIDENCE_THRESHOLD)
);

// Number of candidate tools bundled into a single Jev call during selection
// (askJevMultiToolSelection). Selection criteria is now a light topical
// summary per tool (not the full parameter block), so this can be fairly
// generous — lower it if you still hit "max tokens exceeded" with a lot of
// tools; raise it to cut down on round-trips if your tool count is small.
const TOOL_SELECTION_BATCH_SIZE = parseInt(process.env.TOOL_SELECTION_BATCH_SIZE || '4', 10);

// ── Embedding-based tool selection (alternative to Jev's choice question) ──
// Jev has no embedding primitive of its own (only 'choice' and 'noul'), so
// this is a genuinely separate mechanism: real vector embeddings, computed
// outside Jev, compared by cosine similarity. It embeds the SAME topical
// text used for Jev selection (tool description + each parameter's
// description/label — never enum option values, which is exactly what you
// asked to leave out, both because there can be many of them and because
// per-option embeddings would score on wording overlap with specific
// answers rather than the tool's general subject matter).
//
//   'jev'       (default) — unchanged: askJevMultiToolSelection only.
//   'embedding' — cosine similarity only; a tool is selected if its
//                 similarity to the query clears EMBEDDING_SIMILARITY_THRESHOLD.
//   'hybrid'    — embeddings act as a cheap recall filter (a looser
//                 EMBEDDING_RECALL_THRESHOLD), then Jev's own choice
//                 question scores only that shortlist. This also shrinks
//                 what gets batched to Jev, which helps if you're still
//                 seeing "max tokens exceeded" with a large tool catalog.
const TOOL_SELECTION_STRATEGY = (process.env.TOOL_SELECTION_STRATEGY || 'jev').toLowerCase();
const EMBEDDING_API_URL = process.env.EMBEDDING_API_URL || 'https://api.openai.com/v1/embeddings';
const EMBEDDING_API_KEY = process.env.EMBEDDING_API_KEY || process.env.OPENAI_API_KEY;
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || 'text-embedding-3-small';
// Cosine similarity thresholds are model- and domain-specific and NEED
// empirical tuning against your own tool set and real queries — these are
// reasonable starting points for text-embedding-3-small, not calibrated
// numbers. Log the per-tool scores (see askEmbeddingToolSelection) on a
// batch of real queries and adjust.
const EMBEDDING_SIMILARITY_THRESHOLD = parseFloat(process.env.EMBEDDING_SIMILARITY_THRESHOLD || '0.3');
const EMBEDDING_RECALL_THRESHOLD = parseFloat(
  process.env.EMBEDDING_RECALL_THRESHOLD || String(Math.min(0.15, EMBEDDING_SIMILARITY_THRESHOLD))
);

// A tool call that ERRORS is retried up to this many times (same tool, same
// selection — NOT re-scored by Jev). This is the ONLY reason a tool runs
// more than once in a turn.
const MAX_FAILED_ATTEMPTS = 2;

// What happens with POST / write tools:
//   'llm' (default): Jev is not involved. Once every Jev-selected read tool
//                    has run, write tools (if any) are offered to the LLM
//                    as ordinary tools, in one round.
//   'off':           write tools are never called from /api/chat.
const POST_TOOL_MODE = (process.env.POST_TOOL_MODE || 'llm').toLowerCase();

// ── Read vs POST detection ─────────────────────────────────────────────
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

function baseType(def = {}) {
  return Array.isArray(def.type) ? def.type.find(t => t !== 'null') : def.type;
}

function describeParams(schema) {
  const props = schema?.properties || {};
  const required = new Set(schema?.required || []);
  const parts = Object.entries(props).map(([name, rawDef]) => {
    const def = unwrapSchema(rawDef);
    let p = `${name} (${baseType(def) || 'any'}${required.has(name) ? ', required' : ''}`;
    if (Array.isArray(def.enum) && def.enum.length > 0) {
      p += `, one of: ${def.enum.slice(0, 12).join(' | ')}`;
    }
    return `${p})`;
  });
  return parts.length > 0 ? `Inputs: ${parts.join('; ')}.` : 'Takes no inputs.';
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

// Light topical summary of a tool: name + description + each parameter's
// LABEL only (not its full option text). Used for selection — a coarse
// "is this the right subject matter" judgment, deliberately NOT requiring
// every parameter to already be answerable from the conversation. (Full
// per-parameter resolution, including the actual option text, happens
// separately and only for tools that get selected — see
// askJevResolveToolParams.) Titles/descriptions are used here on purpose:
// for tools with genuinely descriptive names, that's real signal; for tools
// with opaque IDs, the parameter labels still carry the topical weight.
function buildTopicalSummary(tool) {
  const props = tool.schema?.properties || {};
  const labels = Object.values(props)
    .map(rawDef => unwrapSchema(rawDef).description)
    .filter(Boolean)
    .slice(0, 8);
  const topicLine = labels.length > 0 ? ` Addresses questions such as: ${labels.join(' | ')}` : '';
  return `${tool.name}. ${(tool.description || '').trim()}${topicLine}`.slice(0, 700);
}

// Resolves a SELECTED tool's enum/gateway parameters from the conversation.
// Each parameter gets an explicit UNKNOWN option, and Jev is told not to
// guess — a parameter only counts as resolved if Jev is both confident AND
// didn't pick UNKNOWN. REQUIRED parameters that don't resolve are returned
// in `unresolvedRequired` (with their label + full choice list) rather than
// being guessed at or silently dropped — the caller (in /api/chat) turns
// those into a direct clarifying note instead of calling the tool. Kept
// separate from selection so this payload is always small (one tool's
// parameters), regardless of how many candidates were considered during
// selection, and is only ever called once per selected tool.
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

// Scores EVERY candidate tool independently, but with ONE holistic question
// per tool — its full parameter schema (every param, every enum's full
// option list) considered together as a whole. Framed as a binary CHOICE
// ("call now" vs "not yet") rather than an abstract confidence number:
// choice-type questions force Jev to weigh two concrete, grounded options
// against each other, which calibrates far better here than asking for a
// bare confidence out of nowhere. Every tool whose "call now" choice clears
// TOOL_SELECTION_CONFIDENCE_THRESHOLD is returned, so a query that
// genuinely needs two tools gets both. Batched across tools
// (TOOL_SELECTION_BATCH_SIZE per Jev call) to stay under token limits.
//
// Called exactly ONCE per chat turn (from /api/chat) — never in a loop.
async function askJevMultiToolSelection(clinicalState, candidates) {
  if (!candidates || candidates.length === 0) {
    return { selected: [], error: null };
  }

  const searchFirstNote = candidates.some(t => t.name === 'search_medical_guidelines')
    ? ' If this is search_medical_guidelines and the question is a general medical one, favor calling it alongside or before other clinical tools.'
    : '';

  const CALL_NOW = 'CALL_NOW';
  const NOT_YET = 'NOT_YET';

  const questions = {};
  candidates.forEach(t => {
    const topicalSummary = buildTopicalSummary(t);
    questions[t.name] = {
      type: 'choice',
      instructions: (
        `This is a coarse TOPICAL match only — you do NOT need to already know the answer to every ` +
        `detail the tool asks about, just whether its subject matter matches what's being discussed. ` +
        `Given the conversation so far, is this tool topically relevant right now?${searchFirstNote}`
      ).slice(0, 800),
      criteria: {
        [CALL_NOW]:
          `This tool's subject matter clearly matches what the conversation is currently about.\n\n${topicalSummary}`,
        [NOT_YET]:
          `This tool's subject matter does NOT match what the conversation is currently about.\n\n${topicalSummary}`
      }
    };
  });

  // Bundling every candidate's topical summary into one Jev call can still
  // overflow the token limit with enough tools. Batch the calls and merge
  // the answers — the scoring below just reads from the merged `answers`
  // map either way.
  const names = Object.keys(questions);
  const batches = [];
  for (let i = 0; i < names.length; i += TOOL_SELECTION_BATCH_SIZE) {
    batches.push(names.slice(i, i + TOOL_SELECTION_BATCH_SIZE));
  }

  const answers = {};
  const batchErrors = [];

  for (const batchNames of batches) {
    const batchQuestions = {};
    batchNames.forEach(n => { batchQuestions[n] = questions[n]; });

    try {
      const jevResult = await askJev(clinicalState, batchQuestions);
      Object.assign(answers, jevResult.answers || {});
    } catch (jevError) {
      // One batch failing shouldn't sink every tool's selection — the
      // tools in this batch just won't clear the bar this round (no
      // answer -> confidence 0 below).
      console.error(`Jev tool-selection batch failed (tools: ${batchNames.join(', ')}):`, jevError.message);
      batchErrors.push(jevError.message);
    }
  }

  if (batchErrors.length === batches.length && batches.length > 0) {
    return { selected: [], error: batchErrors.join('; ') };
  }

  const selected = [];
  for (const t of candidates) {
    const answer = answers[t.name];
    const calledFor = answer && answer.choice === CALL_NOW && typeof answer.confidence === 'number';
    const confidence = calledFor ? answer.confidence : 0;
    if (calledFor && confidence >= TOOL_SELECTION_CONFIDENCE_THRESHOLD) {
      selected.push({ name: t.name, confidence });
    }
  }
  selected.sort((a, b) => b.confidence - a.confidence);

  console.log(
    'Jev multi-tool selection (topical):',
    selected.length > 0
      ? selected.map(s => `${s.name}(${s.confidence.toFixed(2)})`).join(', ')
      : '(none cleared bar)'
  );

  return { selected, error: null };
}

// Some OpenRouter providers (e.g. Alibaba/Qwen while in "thinking" mode)
// reject a forced tool_choice (an object, or the string 'required') with a
// 400 "does not support being set to required or object in thinking mode"
// error. When that happens, retry once without tool_choice — the request
// still only offers the tool(s) Jev already selected, so the model has
// nothing else to pick even under the default 'auto' behavior.
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
      console.warn(`Provider rejected forced tool_choice for model "${payload.model}", retrying without it:`, errorText);
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
// read/write from its list entry + schema) plus the RAG search tool.
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
    // Runs through classifyTool() (like MCP tools) so POST_TOOLS/READ_TOOLS
    // overrides apply to the built-in search tool too, instead of it being
    // hardcoded to always go through Jev.
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
// ONE pass per chat turn, in this order:
//   1. Jev scores every READ tool with one holistic "call now / not yet"
//      question, ONCE (askJevMultiToolSelection). Every tool that clears
//      the bar is selected — no re-scoring happens after this.
//   2. Each selected tool runs exactly once: Jev resolves its enum params
//      (askJevResolveToolParams), a forced LLM call fills the free-text
//      args, and it executes. If a REQUIRED enum param can't be resolved,
//      the tool is skipped with a clarifying note instead of being guessed
//      at or called anyway. If EXECUTION errors, it's retried (same tool,
//      no re-scoring) up to MAX_FAILED_ATTEMPTS times — that's the only
//      case a tool runs more than once.
//   3. Any read tool that did NOT clear Jev's bar, plus any write tools
//      (if POST_TOOL_MODE isn't 'off'), are offered to the LLM together in
//      ONE 'auto' round — the model decides whether to use them. This is
//      the fallback for "Jev wasn't confident enough", not a retry of
//      Jev's own decision.
//   4. The LLM writes ONE final summary, with no tools offered, covering
//      everything gathered in steps 2–3.
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
- A separate routing system decides which tool(s) are called. When a tool is offered to you, call it and fill in its arguments from the conversation.
- When no tool is offered, write the final answer: summarize the tool results already in this conversation.

CRITICAL RULES:
1. Base your entire response ONLY on the information returned by the tools
2. If the tool returns "No relevant medical guidelines found", clearly state that you don't have that information
3. If a tool returned an error, say so briefly and do not guess what it would have returned
4. If a tool was skipped because required information is missing, tell the clinician what's needed and the valid options
5. Never say "I don't have access to real-time data" - you DO have access via tools
6. Never make assumptions or provide medical information from your training
7. Always cite which tool/source provided the information
8. Keep numbers, units, thresholds, and drug names exactly as the tools returned them
9. Never write out tool calls as text; if no tool is offered, just answer

Sources of information:
- search_medical_guidelines: comprehensive medical guidelines via Cloudflare AI Search
- Clinical decision support tools (MCP tools on the gradio server)`
      });
    }

    const sendEvent = (event, data) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    // Tool list is fetched once per request, then classified read/write.
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

    // Strips any enum-typed argument whose value isn't a literal match for
    // one of the schema's declared options. This runs on EVERY tool call,
    // not just Jev-selected ones: the LLM fills in a tool call's arguments
    // from the same schema it was given, including enum params Jev never
    // resolved (optional ones Jev marked UNKNOWN, or ones from the fallback
    // 'auto' round where Jev isn't involved at all) — and models
    // occasionally guess a value that's close to a real option but isn't
    // actually one of them. `overrides` (Jev's resolved picks, when any)
    // always wins and is applied after sanitizing, since those are already
    // guaranteed valid by askJevResolveToolParams.
    function sanitizeEnumArgs(schema, toolArgs, calledName, overrides = {}) {
      const props = schema?.properties || {};
      for (const [paramName, rawDef] of Object.entries(props)) {
        if (paramName in overrides) continue; // will be overwritten below regardless
        const paramDef = unwrapSchema(rawDef);
        if (!Array.isArray(paramDef.enum) || paramDef.enum.length === 0) continue;
        if (!(paramName in toolArgs)) continue;

        const valid = paramDef.enum.some(opt => String(opt) === String(toolArgs[paramName]));
        if (!valid) {
          console.warn(
            `Dropping invalid enum value ${JSON.stringify(toolArgs[paramName])} for ${calledName}.${paramName} ` +
            `— not one of: ${paramDef.enum.join(', ')}. The model guessed this itself (Jev didn't resolve it).`
          );
          delete toolArgs[paramName];
        }
      }
      for (const [paramName, value] of Object.entries(overrides)) {
        toolArgs[paramName] = value;
      }
      return toolArgs;
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

    // Runs ONE forced tool call against the LLM for `toolName` (which must
    // already have its enum args resolved in `enumPicks`), executes it, and
    // pushes the result into conversationMessages.
    // Returns:
    //   { hardFailure: true }               — unrecoverable (ends the response)
    //   { status: 'declined' }              — model wouldn't call it
    //   { status: 'succeeded' | 'error' }   — tool ran; 'error' is retryable
    async function runForcedToolCall(toolName, enumPicks) {
      const entry = catalog.find(t => t.name === toolName);
      if (!entry) return { status: 'declined' };

      const attempt = await streamChatOnce({
        model: model || 'openai/gpt-3.5-turbo',
        messages: conversationMessages,
        tools: [entry.def],
        tool_choice: { type: 'function', function: { name: toolName } },
        stream: true
      });

      if (!attempt.ok) {
        sendEvent('error', { message: `OpenRouter API error: ${attempt.error}` });
        res.end();
        return { hardFailure: true };
      }

      const { fullContent, toolCalls } = attempt;

      if (toolCalls.length === 0) {
        // Declined: nothing to record. This was an attempt to elicit a
        // specific tool call, not a real conversational turn — pushing it
        // anyway can leave conversationMessages ending on an assistant
        // message with no follow-up, which some providers (e.g. Google AI
        // Studio/Gemini) reject outright on the next completion call
        // ("Requests ending with a model turn are not supported").
        const cause = attempt.toolChoiceStripped
          ? `provider rejected forced tool_choice for model "${model || 'openai/gpt-3.5-turbo'}" (likely a "thinking mode" restriction), fell back to 'auto', and the model didn't call it there either`
          : `tool_choice WAS forced and accepted, but the model still didn't call it`;
        console.warn(`Jev selected "${toolName}" but the model didn't call it — ${cause}`);
        return { status: 'declined' };
      }

      const assistantMessage = { role: 'assistant', content: fullContent || null, tool_calls: toolCalls };
      conversationMessages.push(assistantMessage);

      sendEvent('tool_calls_start', { count: toolCalls.length });

      let sawError = false;
      for (const toolCall of toolCalls) {
        const calledName = toolCall.function.name;

        if (calledName !== toolName) {
          console.error(`Model called "${calledName}" but only "${toolName}" was offered this round`);
          conversationMessages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: JSON.stringify({ error: `Tool "${calledName}" is not available right now.` })
          });
          continue;
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
          sawError = true;
          continue;
        }

        // Enum params were already resolved once by askJevResolveToolParams
        // right after selection — apply those picks directly.
        if (enumPicks && Object.keys(enumPicks).length > 0) {
          for (const [paramName, value] of Object.entries(enumPicks)) {
            console.log(`Applying Jev-resolved value "${value}" for ${paramName}`);
            toolArgs[paramName] = value;
          }
        }

        sendEvent('tool_call', { tool: calledName, arguments: toolArgs });

        const executed = await executeTool(calledName, toolArgs);
        if (executed.hardFailure) {
          sendEvent('error', { message: 'MCP server not connected' });
          res.end();
          return { hardFailure: true };
        }

        const { result, ok } = executed;
        if (!ok) sawError = true;

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
      }

      sendEvent('tool_calls_end', {});
      return { status: sawError ? 'error' : 'succeeded' };
    }

    // ── 1. Jev selection — ONCE for this turn, no loop ──
    const readCandidates = catalog.filter(t => t.kind === 'read');
    const postCandidates = POST_TOOL_MODE === 'off' ? [] : catalog.filter(t => t.kind === 'write');

    let jevSelectedTools = [];
    let jevSelectionError = null;
    if (readCandidates.length > 0) {
      const sel = await askJevMultiToolSelection(buildJevState(conversationMessages), readCandidates);
      jevSelectedTools = sel.selected;
      jevSelectionError = sel.error;
    }

    sendEvent('jev_tool_selection', {
      selected: jevSelectedTools.map(s => s.name),
      confidences: Object.fromEntries(jevSelectedTools.map(s => [s.name, s.confidence])),
      ...(jevSelectionError ? { error: jevSelectionError } : {})
    });

    // ── 2. Run each selected tool exactly once, retrying only on error ──
    for (const { name } of jevSelectedTools) {
      const entry = catalog.find(t => t.name === name);
      const state = buildJevState(conversationMessages);

      const { picks, unresolvedRequired } = await askJevResolveToolParams(state, entry);

      if (unresolvedRequired.length > 0) {
        const need = unresolvedRequired
          .map(p => `${p.label} (choices: ${p.choices.join(', ')})`)
          .join('; ');
        console.warn(`Skipping "${name}" — missing required info: ${need}`);
        const note = `Tool "${name}" was not called: missing required information — ${need}. Ask the clinician for this and it can be called on the next turn.`;
        toolResults.push({ tool: name, arguments: {}, rawResult: { content: [{ type: 'text', text: note }] }, displayResult: note });
        sendEvent('tool_result', { tool: name, arguments: {}, displayResult: note, ok: false, needsClarification: true });
        continue; // not an execution error — don't retry, don't re-score
      }

      let attempts = 0;
      let outcome;
      while (attempts < MAX_FAILED_ATTEMPTS) {
        attempts++;
        outcome = await runForcedToolCall(name, picks);
        if (outcome.hardFailure) return; // response already ended
        if (outcome.status !== 'error') break; // succeeded or declined -> don't retry
        console.warn(`"${name}" errored on attempt ${attempts}/${MAX_FAILED_ATTEMPTS} — retrying`);
      }
    }

    // ── 3. LLM fallback round: read tools Jev passed on + write tools ──
    // If NO read tool cleared the confidence bar, don't just drop them —
    // offer them to the LLM as ordinary 'auto' tools instead, so a real
    // signal (the model genuinely has nothing to call) and a merely-low
    // Jev score are handled differently. Write tools are always offered
    // this way (never through Jev at all), so both go in the same round.
    // Note: tools picked here did NOT go through askJevResolveToolParams,
    // so the LLM fills in their enum params itself, same as any normal
    // function-calling flow — Jev's enum resolution is selection-only.
    const fallbackReadCandidates = jevSelectedTools.length === 0 ? readCandidates : [];
    const autoCandidates = [...fallbackReadCandidates, ...postCandidates];

    if (fallbackReadCandidates.length > 0) {
      console.log(`No read tool cleared the bar — falling back to the LLM for: ${fallbackReadCandidates.map(t => t.name).join(', ')}`);
      sendEvent('tool_fallback', {
        reason: 'no_read_tool_cleared_bar',
        offered: fallbackReadCandidates.map(t => t.name)
      });
    }

    if (autoCandidates.length > 0) {
      const toolsForRequest = autoCandidates.map(t => t.def);
      const offeredTools = new Set(toolsForRequest.map(t => t.function.name));

      const attempt = await streamChatOnce({
        model: model || 'openai/gpt-3.5-turbo',
        messages: conversationMessages,
        tools: toolsForRequest,

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
        // The model looked at the offered tools and chose to just answer in
        // text instead. That answer (already streamed above) IS the final
        // response — don't fall through to step 4. Besides being redundant,
        // sending a follow-up completion request whose message list ends
        // with this assistant turn is rejected outright by some providers
        // (e.g. Google AI Studio/Gemini: "Requests ending with a model turn
        // are not supported").
        sendEvent('done', {
          conversationMessages: conversationMessages,
          toolResults: toolResults
        });
        res.end();
        return;
      }

      if (toolCalls.length > 0) {
        sendEvent('tool_calls_start', { count: toolCalls.length });

        for (const toolCall of toolCalls) {
          const toolName = toolCall.function.name;

          if (!offeredTools.has(toolName)) {
            console.error(`Model called "${toolName}" but it was not offered this round`);
            conversationMessages.push({
              role: 'tool',
              tool_call_id: toolCall.id,
              content: JSON.stringify({ error: `Tool "${toolName}" is not available right now.` })
            });
            continue;
          }

          let toolArgs;
          try {
            toolArgs = JSON.parse(toolCall.function.arguments || '{}');
          } catch (jsonError) {
            console.error(`JSON parse error for tool ${toolName}:`, jsonError);
            conversationMessages.push({
              role: 'tool',
              tool_call_id: toolCall.id,
              content: JSON.stringify({
                error: `JSON parsing failed: ${jsonError.message}.`,
                invalid_json: toolCall.function.arguments
              })
            });
            continue;
          }

          sendEvent('tool_call', { tool: toolName, arguments: toolArgs });

          const executed = await executeTool(toolName, toolArgs);
          if (executed.hardFailure) {
            sendEvent('error', { message: 'MCP server not connected' });
            res.end();
            return;
          }

          const { result, ok } = executed;

          toolResults.push({
            tool: toolName,
            arguments: toolArgs,
            rawResult: result,
            displayResult: result.content?.[0]?.text || JSON.stringify(result)
          });

          sendEvent('tool_result', {
            tool: toolName,
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
        }

        sendEvent('tool_calls_end', {});
      }
    }

    // ── 4. Final summary — one call, no tools offered ──
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
