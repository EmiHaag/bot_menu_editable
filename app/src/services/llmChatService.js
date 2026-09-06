const OpenAI = require('openai');

const MODEL = 'gpt-4o-mini';
const MAX_TOOL_ROUNDS = 8;

let client = null;

function getClient() {
    if (!client) {
        client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    }
    return client;
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Wrapper sobre GPT-4o-mini con soporte de function calling.
 *
 * Ejecuta un bucle de herramientas: manda el mensaje al LLM; si pide una tool
 * ejecuta el handler y vuelve a mandar el resultado; repite hasta obtener una
 * respuesta final de texto o agotar las rondas.
 *
 * @param {Object} opts
 * @param {string} opts.systemPrompt - Instrucciones del sistema (estilo + negocio + menú).
 * @param {Array}  opts.messages    - Historial [{role, content}].
 * @param {Array}  opts.tools       - Definiciones de tools (OpenAI format).
 * @param {Function} opts.executeTool - async (name, args) => string (resultado).
 * @param {Function} [opts.onTokens] - async (tokens) callback para registrar consumo.
 * @param {string}  [opts.toolChoice] - 'auto' | 'required' (default 'auto' cuando hay tools).
 * @param {Function} [opts.earlyStop] - (name, args) => boolean. Si devuelve true tras
 *     ejecutar una tool, corta el bucle de inmediato (ahorra la ronda final de texto).
 * @returns {Promise<{content: string|null, toolCalls: number, stopped?: boolean}>}
 */
async function chat({ systemPrompt, messages, tools, executeTool, onTokens, toolChoice, earlyStop }) {
    if (!process.env.OPENAI_API_KEY) {
        throw new Error('OPENAI_API_KEY no configurada');
    }

    const api = getClient();

    const fullMessages = [
        { role: 'system', content: systemPrompt },
        ...messages
    ];

    let toolCallsUsed = 0;
    let finalContent = null;
    let retries = 0;
    const MAX_RETRIES = 3;
    const dbg = process.env.AI_DEBUG === '1';

    for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
        let completion;
        try {
            completion = await api.chat.completions.create({
                model: MODEL,
                temperature: 0.6,
                messages: fullMessages,
                tools: tools.length ? tools : undefined,
                tool_choice: tools.length ? (toolChoice || 'auto') : undefined
            });
        } catch (err) {
            const status = err && err.status;
            const code = err && err.error && err.error.code;
            if (dbg) console.error(`[llm] round ${round} error status=${status} code=${code} msg=${err.message}`);
            // 429 por límite de saldo/gasto o cuenta sin créditos: NO se resuelve con retry.
            // Lanzamos de inmediato para que el agente vuelque al modo menú sin golpear más la API.
            const quotaCodes = ['insufficient_quota', 'credit_balance_exhausted'];
            if (status === 429 && quotaCodes.includes(code)) {
                const quotaErr = new Error(`Cuota de OpenAI agotada (${code})`);
                quotaErr.isQuotaExceeded = true;
                throw quotaErr;
            }
            // Reintentos acotados para 429/5xx transitorios
            if (status === 429 || status >= 500) {
                retries++;
                if (retries > MAX_RETRIES) {
                    throw new Error(`OpenAI no disponible tras ${MAX_RETRIES} reintentos (${code || status})`);
                }
                await sleep(1500);
                continue;
            }
            throw err;
        }

        const usage = completion.usage;
        if (usage && onTokens) {
            await onTokens((usage.prompt_tokens || 0) + (usage.completion_tokens || 0));
        }

        const choice = completion.choices && completion.choices[0];
        if (!choice) {
            if (dbg) console.error(`[llm] round ${round}: sin choice en respuesta`);
            finalContent = null;
            break;
        }

        const message = choice.message || {};
        const toolCalls = message.tool_calls || [];
        if (dbg) console.log(`[llm] round ${round} finish=${choice.finish_reason} contentLen=${(message.content||'').length} toolCalls=${toolCalls.length}`);

        if (toolCalls.length === 0) {
            finalContent = message.content || null;
            if (dbg) console.log(`[llm] respuesta final: ${finalContent ? JSON.stringify(finalContent.slice(0,80)) : 'NULL'}`);
            break;
        }
        if (dbg) console.log(`[llm] tools pedidas: ${toolCalls.map(c => c.function && c.function.name).join(', ')}`);

        fullMessages.push(message);

        for (const call of toolCalls) {
            toolCallsUsed++;
            let toolResult = 'Error ejecutando la herramienta';
            try {
                let args = {};
                if (call.function && call.function.arguments) {
                    args = JSON.parse(call.function.arguments);
                }
                toolResult = await executeTool(call.function.name, args);
                if (typeof earlyStop === 'function' && earlyStop(call.function.name, args)) {
                    if (dbg) console.log(`[llm] early stop tras tool ${call.function.name}`);
                    return { content: finalContent, toolCalls: toolCallsUsed, stopped: true };
                }
            } catch (err) {
                toolResult = 'Error ejecutando la herramienta: ' + (err && err.message ? err.message : String(err));
            }
            if (dbg) console.log(`[llm] tool ${call.function && call.function.name} -> ${String(toolResult).slice(0,100)}`);
            fullMessages.push({
                role: 'tool',
                tool_call_id: call.id,
                content: typeof toolResult === 'string' ? toolResult : JSON.stringify(toolResult)
            });
        }
    }

    if (dbg && finalContent === null) console.error('[llm] finalContent NULL tras agotar rondas');
    return { content: finalContent, toolCalls: toolCallsUsed };
}

module.exports = {
    chat,
    MODEL,
    MAX_TOOL_ROUNDS
};
