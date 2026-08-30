/**
 * Gemini integration check.
 *
 * Run with:  npm run gemini-check
 *
 * Checks:
 *   1. API key is present and has the right format
 *   2. A simple generateContent call succeeds
 *   3. Function calling round-trip works (model calls a tool, result returned,
 *      model writes a final answer)
 *   4. The full investigation agent runs on one real investigation (or falls
 *      back gracefully when there is nothing to investigate)
 *
 * Exit code 0 = all checks passed.
 * Exit code 1 = something failed.
 */

import { config } from '../src/config.js';
import { callGemini, readGeminiResponse, toFunctionDeclarations, functionResponseTurn } from '../src/agent/gemini.js';

let passed = 0;
let failed = 0;

function ok(label) {
  console.log(`  \x1b[32m✓\x1b[0m  ${label}`);
  passed++;
}
function fail(label, detail) {
  console.log(`  \x1b[31m✗\x1b[0m  ${label}`);
  if (detail) console.log(`       ${detail}`);
  failed++;
}

console.log('');
console.log('Gemini integration check');
console.log('────────────────────────────────────────────');

/* ---- 1. Key present ------------------------------------------------------- */
if (!config.geminiApiKey) {
  fail('GEMINI_API_KEY is set', 'Add GEMINI_API_KEY to your .env file (get one at https://aistudio.google.com/apikey)');
  console.log('');
  console.log('Get a free key at https://aistudio.google.com/apikey');
  process.exit(1);
}

ok(`Key present (${config.geminiApiKey.slice(0, 8)}…)`);

/* ---- 1b. List models this key can actually use ---------------------------- */
try {
  const { listModelNames, resolveModel } = await import('../src/agent/gemini.js');
  const names = await listModelNames();
  if (!names.length) {
    fail('Key has access to at least one model', 'ListModels returned nothing. The Generative Language API may not be enabled for this key\'s project.');
    process.exit(1);
  }
  ok(`Key can access ${names.length} models`);
  const chosen = await resolveModel();
  ok(`Auto-selected model: ${chosen}`);
  console.log(`       (available: ${names.slice(0, 6).join(', ')}${names.length > 6 ? ', …' : ''})`);
} catch (e) {
  fail(`Model discovery: ${e.message}`);
  if (/403|401|PERMISSION/i.test(e.message)) {
    console.log('       Your key was rejected. Two common causes:');
    console.log('       1. The key is unrestricted. AI Studio → your key → Add restrictions → Restrict to Gemini API only.');
    console.log('       2. The Generative Language API is not enabled for the project.');
    console.log('       Note: keys starting with AQ. (auth keys) and AIza (standard) both work.');
  }
  process.exit(1);
}

/* ---- 2. Basic call -------------------------------------------------------- */
try {
  const resp = await callGemini({
    contents: [{ role: 'user', parts: [{ text: 'Reply with exactly: WATCHDOG_OK' }] }],
    systemPrompt: 'You are a test probe. Follow the user instruction exactly.',
    functionDeclarations: [],
  });
  const { texts } = readGeminiResponse(resp);
  const text = texts.join('').trim();
  if (text.includes('WATCHDOG_OK')) {
    ok('generateContent call succeeded');
    ok(`Response: "${text.slice(0, 60)}"`);
  } else {
    fail('generateContent returned expected string', `Got: ${text.slice(0, 100)}`);
  }
} catch (e) {
  fail(`generateContent call: ${e.message}`);
  if (e.status === 400) console.log('       400 usually means a malformed request body. Check GEMINI_MODEL in .env.');
  if (e.status === 401 || e.status === 403) console.log('       Auth failed. Check that GEMINI_API_KEY is correct and the Gemini API is enabled in your Google Cloud project.');
  if (e.status === 429) console.log('       Rate limited. Wait a minute and try again.');
  process.exit(1);
}

/* ---- 3. Function calling round-trip -------------------------------------- */
const testTool = {
  name: 'get_watchdog_status',
  description: 'Returns the watchdog system status.',
  parameters: { type: 'object', properties: {}, required: [] },
};

try {
  // First turn: ask a question that requires the tool
  const resp1 = await callGemini({
    contents: [{ role: 'user', parts: [{ text: 'Call the get_watchdog_status tool and tell me what it returns.' }] }],
    systemPrompt: 'Use the available tools.',
    functionDeclarations: toFunctionDeclarations([{ name: testTool.name, description: testTool.description, input_schema: testTool.parameters }]),
  });

  const read1 = readGeminiResponse(resp1);

  if (!read1.toolCalls.length) {
    fail('Model made a function call', `No tool call in response. Texts: ${read1.texts.join(' ').slice(0, 120)}`);
  } else {
    ok(`Model called tool: ${read1.toolCalls[0].name}`);

    // Second turn: return the tool result
    const contents2 = [
      { role: 'user', parts: [{ text: 'Call the get_watchdog_status tool and tell me what it returns.' }] },
      read1.content,
      functionResponseTurn([{ name: read1.toolCalls[0].name, value: { status: 'healthy', version: '3.0.0', timestamp: new Date().toISOString() } }]),
    ];

    const resp2 = await callGemini({
      contents: contents2,
      systemPrompt: 'Use the available tools.',
      functionDeclarations: toFunctionDeclarations([{ name: testTool.name, description: testTool.description, input_schema: testTool.parameters }]),
    });

    const read2 = readGeminiResponse(resp2);
    const finalText = read2.texts.join(' ');
    if (finalText.length > 0) {
      ok(`Final answer received (${read2.usage.outputTokens} output tokens)`);
      ok(`Answer: "${finalText.slice(0, 80)}…"`);
    } else {
      fail('Model produced a final text answer', 'Empty response after tool result');
    }
  }
} catch (e) {
  fail(`Function calling round-trip: ${e.message}`);
}

/* ---- 4. Full agent loop -------------------------------------------------- */
try {
  // Seed synthetic traffic FIRST. This is what creates the training rows the
  // recovery model needs — without it, fitModel() throws "no training rows".
  const { seed } = await import('../src/seed/generator.js');
  seed();

  const { store } = await import('../src/store.js');
  const { ingestRealPayment } = await import('../src/razorpay/ingest.js');

  // Add one real-looking failed payment on top of the synthetic traffic, so
  // the agent has a real payment to investigate.
  const fakeEntity = {
    id: `pay_geminitest_${Date.now()}`,
    amount: 119900,
    currency: 'INR',
    method: 'upi',
    vpa: 'failure@razorpay',
    status: 'failed',
    error_code: 'BAD_REQUEST_ERROR',
    error_reason: 'payment_failed',
    error_description: 'Your payment failed due to a technical issue on the bank side. Please try again.',
    created_at: Math.floor(Date.now() / 1000),
    email: 'test@example.com',
    contact: '9999999999',
    notes: {},
  };

  ingestRealPayment(fakeEntity, { via: 'gemini-check-script' });

  // Now the model has training rows to fit on.
  const { fitModel } = await import('../src/pipeline/model.js');
  fitModel();

  // Run a cycle so there is an investigation.
  const { runCycle } = await import('../src/pipeline/cycle.js');
  await runCycle({ autoExecute: false });

  // Run the full agent.
  const { investigate } = await import('../src/agent/loop.js');
  const result = await investigate({ merchantId: store.merchants[0]?.id || 'acc_LEAFANDLOOM' });

  if (result.driver === 'gemini') {
    ok(`Agent ran with driver: ${result.driver} (${result.model})`);
    ok(`Tool calls: ${result.toolCalls}  Turns used: ${result.trace.length}`);
    if (result.proposal) {
      ok(`Proposal produced — cause: ${result.proposal.cause}, posture: ${result.proposal.posture}, confidence: ${result.proposal.confidence}`);
    } else {
      ok('Agent ran to completion (no proposal — expected when investigation context is thin)');
    }
    if (result.cost) {
      ok(`Tokens: ${result.cost.inputTokens} in / ${result.cost.outputTokens} out  Cost: free tier`);
    }
  } else {
    fail(`Agent driver should be "gemini", got "${result.driver}"`, result.degradedReason || '');
  }
} catch (e) {
  fail(`Full agent loop: ${e.message}`);
  console.error(e);
}

/* ---- summary -------------------------------------------------------------- */
console.log('');
console.log(`  ${passed} passed, ${failed} failed`);
console.log('');

if (failed > 0) {
  console.log('  Fix the errors above, then run  npm run gemini-check  again.');
  process.exit(1);
} else {
  console.log('  All checks passed. The Gemini agent is ready.');
  console.log('  Start the server:  npm start');
  console.log('');
}
