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
// Jev has exactly one job now: resolving the enum/gateway parameters of a
// tool the LLM has already decided to call. Jev does NOT pick which tool
// runs — that's the LLM's job, via ordinary 'auto' tool-calling, the same
// as any standard tool-use integration.
//
// For every enum parameter on a called tool, Jev is asked to choose among
// the schema's real option values — nothing else is offered as a choice —
// and whatever it answers is applied, REGARDLESS of confidence. There is no
// "I'm not sure" escape hatch and no threshold to clear: Jev is forced to
// commit to one of the real options, so its answer can never be something
// off the list, and it's never skipped for being low-confidence.
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

// A tool call that ERRORS (bad args, MCP failure, etc.) is just reported
// back to the model as a tool result, like any normal function-calling
// flow — the model sees the error and can retry with corrected arguments
// on its next turn. There's no separate bespoke retry loop; maxIterations
// below is only a safety cap on the whole conversation turn.
const MAX_ITERATIONS = parseInt(process.env.MAX_ITERATIONS || '10', 10);

// What happens with POST / write tools:
//   'llm' (default): offered to the model like any other tool.
//   'off':           never offered to the model at all.
const POST_TOOL_MODE = (process.env.POST_TOOL_MODE || 'llm').toLowerCase();

// ── Read vs POST detection ─────────────────────────────────────────────
// Used ONLY to support POST_TOOL_MODE='off' as a safety switch (exclude
// certain tools from ever being offered to the model). It no longer gates
// Jev involvement — Jev resolves enum params on ANY tool the model calls,
// read or write.
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
// Handles both `anyOf` (nullable wrapper) and `oneOf` (same shape, used by
// some schema generators) so a param wrapped either way is still seen.
function unwrapSchema(def = {}) {
  const branches = Array.isArray(def.anyOf) ? def.anyOf : Array.isArray(def.oneOf) ? def.oneOf : null;
  if (branches) {
    const branch = branches.find(s => s && s.type !== 'null');
    if (branch) {
      return { ...branch, description: def.description ?? branch.description };
    }
  }
  return def;
}

function baseType(def = {}) {
  return Array.isArray(def.type) ? def.type.find(t => t !== 'null') : def.type;
}

// Resolves a CALLED tool's enum/gateway parameters from the conversation.
// Every enum parameter gets its own Jev 'choice' question, with criteria
// built ONLY from the schema's real option values — there's no "unknown" /
// "not applicable" option offered, so whatever Jev answers is guaranteed to
// be one of the real options. The result is applied unconditionally: no
// confidence threshold, no skipping. This is deliberately different from
// the tool-SELECTION questions (removed) — this only ever fires once the
// model has already decided to call this specific tool, so there's no
// "is this tool even relevant" judgment left to make, just "which option".
//
// If Jev's call fails outright (network/API error), picks for that tool are
// left empty and a warning is logged — the model's own guessed values stay
// in place rather than the tool call failing entirely.
async function askJevEnumPicksForTool(clinicalState, tool, toolArgs) {
  const props = tool?.schema?.properties || {};
  const questions = {};
  const optionMaps = {};

  for (const [paramName, rawDef] of Object.entries(props)) {
    const paramDef = unwrapSchema(rawDef);
    if (!Array.isArray(paramDef.enum) || paramDef.enum.length === 0) continue;

    optionMaps[paramName] = new Map(paramDef.enum.map(opt => [String(opt), opt]));

    const criteria = {};
    paramDef.enum.forEach(opt => {
      criteria[String(opt)] = paramDef.description
        ? `${paramDef.description} — this option: "${opt}"`
        : `Option: ${opt}`;
    });

    questions[paramName] = {
      type: 'choice',
      instructions:
        (paramDef.description || `Select the correct value for ${paramName}, given the conversation so far.`) +
        ` The model's own guess for this call was ${JSON.stringify(toolArgs[paramName] ?? null)} — use that as a hint, ` +
        `but choose whichever option genuinely fits best; don't just default to it.`,
      criteria
    };
  }

  if (Object.keys(questions).length === 0) {
    return {};
  }

  const picks = {};
  try {
    const jevResult = await askJev(clinicalState, questions);
    const answers = jevResult.answers || {};

    for (const paramName of Object.keys(questions)) {
      const answer = answers[paramName];
      const map = optionMaps[paramName];
      // Criteria only ever contained real option keys, so any valid
      // 'choice' answer is guaranteed to be one of them. Taken regardless
      // of confidence — there is no threshold here by design.
      if (answer && answer.type === 'choice' && map.has(String(answer.choice))) {
        picks[paramName] = map.get(String(answer.choice));
      } else if (answer) {
        console.warn(`Jev returned an answer for "${paramName}" that wasn't one of the offered options — keeping the model's own value`);
      }
    }
  } catch (jevError) {
    console.error(`Jev enum resolution failed for tool "${tool.name}", keeping the model's own values:`, jevError.message);
  }

  return picks;
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
// read/write only for the POST_TOOL_MODE='off' filter) plus the RAG search
// tool.
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
// Standard 'auto' tool-calling loop: the LLM decides which tool(s) to call,
// each round, for up to MAX_ITERATIONS rounds. The only custom step is
// right before each tool executes: if it has enum parameters, Jev resolves
// them and its answer is applied unconditionally (see askJevEnumPicksForTool
// above). The loop ends naturally the first time the model responds with no
// tool calls — that response IS the final answer, streamed as it's
// generated. If MAX_ITERATIONS is hit first, one last no-tools call forces
// a wrap-up so the turn always ends with a summary.
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

CRITICAL RULES:
1. Base your entire response ONLY on the information returned by the tools
2. Call whatever tools you need, in whatever order makes sense; call more than one if the question needs it
3. If a tool returns "No relevant medical guidelines found", clearly state that you don't have that information
4. If a tool call errors, you may retry it with corrected arguments, or try a different tool
5. Never say "I don't have access to real-time data" - you DO have access via tools
6. Never make assumptions or provide medical information from your training
7. Always cite which tool/source provided the information
8. Keep numbers, units, thresholds, and drug names exactly as the tools returned them
9. Once you have what you need, respond with your final answer and no further tool calls

Sources of information:
- search_medical_guidelines: comprehensive medical guidelines via Cloudflare AI Search
- Clinical decision support tools (MCP tools on the gradio server)`
      });
    }

    const sendEvent = (event, data) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    // Tool list is fetched once per request.
    let mcpTools = [];
    if (serverId) {
      const client = mcpClients.get(serverId);
      if (client) {
        const listed = await client.listTools();
        mcpTools = listed.tools || [];
      }
    }
    const fullCatalog = buildToolCatalog(mcpTools, aiSearchReady);
    // POST_TOOL_MODE='off' is the only thing that ever removes a tool from
    // what the model is offered — everything else is the model's choice.
    const catalog = POST_TOOL_MODE === 'off' ? fullCatalog.filter(t => t.kind !== 'write') : fullCatalog;
    console.log('Tools offered to the model:', catalog.map(t => t.name).join(', ') || '(none)');

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

    let iterations = 0;

    while (iterations < MAX_ITERATIONS) {
      iterations++;
      const finalRound = iterations === MAX_ITERATIONS;

      const toolsForRequest = finalRound ? undefined : catalog.map(t => t.def);

      const openRouterResponse = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'http://localhost:3000',
          'X-Title': 'MCP OpenRouter Client'
        },
        body: JSON.stringify({
          model: model || 'openai/gpt-3.5-turbo',
          messages: conversationMessages,
          tools: toolsForRequest,
          stream: true
        })
      });

      if (!openRouterResponse.ok) {
        const error = await openRouterResponse.text();
        sendEvent('error', { message: `OpenRouter API error: ${error}` });
        res.end();
        return;
      }

      let fullContent = '';
      let toolCalls = [];
      const reader = openRouterResponse.body.getReader();
      const decoder = new TextDecoder();
      let streamBuffer = '';
      // Content is only forwarded to the client once we know this round has
      // no tool calls (see below) — buffering here avoids streaming
      // preamble text from a round that turns out to also call a tool,
      // which would otherwise look like a spurious extra "summary".
      let bufferedDeltas = [];

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
                bufferedDeltas.push(delta.content);
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

      toolCalls = toolCalls.filter(Boolean);

      const assistantMessage = { role: 'assistant', content: fullContent || null };
      if (toolCalls.length > 0) assistantMessage.tool_calls = toolCalls;
      conversationMessages.push(assistantMessage);

      if (toolCalls.length === 0) {
        // No tool calls this round: this is the final answer. Flush the
        // buffered text now, as the real summary.
        for (const chunk of bufferedDeltas) sendEvent('content', { content: chunk });

        sendEvent('done', {
          conversationMessages: conversationMessages,
          toolResults: toolResults
        });
        res.end();
        return;
      }

      sendEvent('tool_calls_start', { count: toolCalls.length });

      for (const toolCall of toolCalls) {
        const calledName = toolCall.function.name;
        const entry = catalog.find(t => t.name === calledName);

        if (!entry) {
          console.error(`Model called "${calledName}" but it was not offered this round`);
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
          continue;
        }

        // Jev resolves enum params, unconditionally overriding the model's
        // own guess for each one — this is the one place Jev is involved.
        const picks = await askJevEnumPicksForTool(buildJevState(conversationMessages), entry, toolArgs);
        for (const [paramName, value] of Object.entries(picks)) {
          toolArgs[paramName] = value;
        }

        sendEvent('tool_call', { tool: calledName, arguments: toolArgs });

        const executed = await executeTool(calledName, toolArgs);
        if (executed.hardFailure) {
          sendEvent('error', { message: 'MCP server not connected' });
          res.end();
          return;
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
      }

      sendEvent('tool_calls_end', {});
      // Loop back: the model sees this round's results and decides whether
      // it needs another tool call or is ready to answer.
    }

    // Safety net: MAX_ITERATIONS was hit without the model ever stopping on
    // its own. `finalRound` above already forced this last pass to omit
    // tools, so we should have hit the `toolCalls.length === 0` branch and
    // returned already — this is only reached if that branch's own logic
    // changes in the future, so it's here to guarantee the response always
    // ends rather than hanging.
    sendEvent('done', {
      message: 'Maximum iterations reached',
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
