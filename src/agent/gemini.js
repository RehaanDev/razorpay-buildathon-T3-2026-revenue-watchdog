import { config } from '../config.js';

/**
 * Gemini driver for the investigation agent.
 *
 * The agent's contract is defined in agent/tools.js and enforced in
 * agent/validator.js, and neither of them knows or cares which model is
 * driving. This file is only a translation layer: it converts the tool schemas
 * into Gemini's function-declaration format, runs the request/response loop
 * against generativelanguage.googleapis.com, and normalises what comes back
 * into the same `{ text, toolCalls }` shape the rest of the loop expects.
 *
 * Two quirks of this API are worth knowing about, because both
 * of them will bite anyone editing this file:
 *
 *   1. There is no separate `system` parameter in the request body. The system
 *      prompt goes in `systemInstruction`, which is a Content object, not a
 *      string.
 *   2. Tool results are not a distinct role. They are sent back as a `user`
 *      turn whose parts are `functionResponse` objects, and the `response`
 *      field of each one must be a JSON object — a bare string or number is
 *      rejected.
 */

/* ------------------------------------------------------- schema conversion -- */

/**
 * Gemini's Schema type is a subset of JSON Schema. It understands type,
 * description, enum, items, properties and required, and rejects requests
 * carrying keys it does not recognise, so anything else is dropped here rather
 * than passed through and turned into a 400 at request time.
 */
function toGeminiSchema(schema) {
  if (!schema || typeof schema !== 'object') return undefined;

  const out = {};
  if (schema.type) out.type = String(schema.type).toLowerCase();
  if (schema.description) out.description = schema.description;
  if (Array.isArray(schema.enum)) out.enum = schema.enum.map(String);

  if (schema.properties) {
    out.properties = {};
    for (const [key, value] of Object.entries(schema.properties)) {
      const converted = toGeminiSchema(value);
      if (converted) out.properties[key] = converted;
    }
  }
  if (schema.items) out.items = toGeminiSchema(schema.items);
  if (Array.isArray(schema.required) && schema.required.length) out.required = schema.required;

  return out;
}

export function toFunctionDeclarations(toolSchemas) {
  return toolSchemas.map((tool) => {
    const parameters = toGeminiSchema(tool.input_schema);
    const declaration = {
      name: tool.name,
      description: tool.description,
    };
    // A function with no parameters must omit the key entirely rather than
    // send an empty object.
    if (parameters && parameters.properties && Object.keys(parameters.properties).length) {
      declaration.parameters = parameters;
    }
    return declaration;
  });
}

/* --------------------------------------------------------- model resolver -- */

/**
 * Which model to actually call.
 *
 * Google renames and retires models often, and a free-tier key only has access
 * to some of them. Hard-coding a model name means the app breaks every time the
 * lineup changes. Instead we ask the key itself — ListModels returns exactly the
 * models this key can use — and pick the best Flash model that supports
 * generateContent. The result is cached for the process.
 *
 * If GEMINI_MODEL is set explicitly in .env, that wins and no discovery runs.
 */
let _resolvedModel = null;

async function listAvailableModels() {
  const res = await fetch(`${config.geminiBase}/models`, {
    headers: { 'x-goog-api-key': config.geminiApiKey },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error?.message || `ListModels HTTP ${res.status}`);
  return (data.models || []).filter((m) =>
    (m.supportedGenerationMethods || m.supported_generation_methods || []).includes('generateContent')
  );
}

/** Rank preference: the stable alias first, then newest Flash, then anything. */
function pickBestModel(models) {
  const names = models.map((m) => m.name.replace(/^models\//, ''));
  const prefer = [
    /^gemini-flash-latest$/,      // alias, always points at newest Flash — best default
    /^gemini-3\.7-flash$/,        // current latest as of this writing
    /^gemini-3\.\d+-flash$/,      // any 3.x Flash
    /^gemini-3-flash$/,
    /^gemini-2\.5-flash$/,        // older but may still be enabled on some keys
    /flash-latest$/,
    /flash/,
    /gemini/,
  ];
  for (const pattern of prefer) {
    const hit = names.find((n) => pattern.test(n) && !/vision|embedding|image|tts|audio|lite/.test(n));
    if (hit) return hit;
  }
  // Accept flash-lite as a last resort before giving up
  const lite = names.find((n) => /flash-lite/.test(n));
  return lite || names[0] || null;
}

export async function resolveModel() {
  // Explicit override always wins.
  if (process.env.GEMINI_MODEL) return process.env.GEMINI_MODEL;
  if (_resolvedModel) return _resolvedModel;
  const models = await listAvailableModels();
  _resolvedModel = pickBestModel(models);
  if (!_resolvedModel) throw new Error('No generateContent-capable model available to this key');
  console.log(`[gemini] auto-selected model: ${_resolvedModel}`);
  return _resolvedModel;
}

export async function listModelNames() {
  const models = await listAvailableModels();
  return models.map((m) => m.name.replace(/^models\//, ''));
}

/* --------------------------------------------------------------- transport -- */

export async function callGemini({ contents, systemPrompt, functionDeclarations, signal }) {
  const model = await resolveModel();
  const url = `${config.geminiBase}/models/${model}:generateContent`;

  const body = {
    contents,
    systemInstruction: { parts: [{ text: systemPrompt }] },
    tools: [{ functionDeclarations }],
    generationConfig: {
      // The investigation should be reproducible enough to review. This is not
      // a creative writing task.
      temperature: 0.2,
      maxOutputTokens: 2048,
    },
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-goog-api-key': config.geminiApiKey,
    },
    body: JSON.stringify(body),
    signal,
  });

  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`Gemini returned non-JSON (${res.status}): ${text.slice(0, 300)}`);
  }

  if (!res.ok) {
    const detail = data?.error?.message || `HTTP ${res.status}`;
    const err = new Error(`Gemini ${res.status}: ${detail}`);
    err.status = res.status;
    err.geminiStatus = data?.error?.status || null;
    throw err;
  }

  return data;
}

/* -------------------------------------------------------------- normalising -- */

/**
 * Pull the useful parts out of a Gemini response.
 *
 * `candidates[0].content.parts` is a mixed array: text parts, function-call
 * parts, sometimes both in one turn. The caller wants them separated, plus the
 * raw content object so it can be appended verbatim to the conversation — the
 * model's own turn has to go back in unchanged or the function-call ids stop
 * lining up.
 */
export function readGeminiResponse(data) {
  const candidate = data?.candidates?.[0];
  const parts = candidate?.content?.parts || [];

  const texts = [];
  const toolCalls = [];

  for (const part of parts) {
    if (part.text && part.text.trim()) texts.push(part.text.trim());
    if (part.functionCall) {
      toolCalls.push({
        name: part.functionCall.name,
        args: part.functionCall.args || {},
      });
    }
  }

  return {
    content: candidate?.content || { role: 'model', parts: [] },
    texts,
    toolCalls,
    finishReason: candidate?.finishReason || null,
    // Gemini reports usage under usageMetadata rather than usage.
    usage: {
      inputTokens: data?.usageMetadata?.promptTokenCount || 0,
      outputTokens: data?.usageMetadata?.candidatesTokenCount || 0,
    },
  };
}

/**
 * Build the turn that carries tool results back to the model.
 *
 * Every `response` value must be a JSON object. Tool results already are;
 * strings and other scalars get wrapped so the request cannot be rejected for
 * a reason that has nothing to do with the investigation.
 */
export function functionResponseTurn(results) {
  return {
    role: 'user',
    parts: results.map(({ name, value }) => ({
      functionResponse: {
        name,
        response: value && typeof value === 'object' && !Array.isArray(value) ? value : { result: value },
      },
    })),
  };
}

/** Free tier, so the money cost is zero. Tokens are still worth reporting. */
export function geminiCost(usage) {
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    usd: 0,
    paise: 0,
    assumption: `Gemini ${config.geminiModel} on the free tier. No per-token charge, but the free tier is rate limited, so a busy day is bounded by requests per minute rather than by cost.`,
  };
}
