/*
 * Jev (TypeSafe AI / System One): motor de decisiones estructuradas.
 *
 * Capa ultrarrápida y económica para puntos críticos de decisión y
 * clasificación (validación de intenciones, extracción de parámetros,
 * variantes, enrutamiento de flujos, urgencias) ANTES de invocar modelos
 * conversacionales pesados o lógica determinista.
 *
 * Un solo POST a https://api.typesafe.ai/v1/systemone con un estado + un set
 * de preguntas tipadas (choice / score / noul). Devuelve respuestas tipadas
 * con probabilidades: no hay texto libre que parsear.
 *
 * Fallback seguro: ante cualquier error (sin key, timeout, red, HTTP no-2xx)
 * devuelve null para que el flujo principal del bot NUNCA se interrumpa y
 * caiga al comportamiento tradicional (LLM conversacional o menú directo).
 */

const API_BASE = (process.env.TYPESAFE_BASE_URL || 'https://api.typesafe.ai').replace(/\/+$/, '');
const DEFAULT_MODEL = process.env.TYPESAFE_MODEL || 'jev-latest';
const DEFAULT_TIMEOUT_MS = 4000;

/**
 * Umbral seguro de confianza para Enrutamiento por Confianza.
 * Si Jev devuelve confidence/probabilidad >= UMBRAL_CONFIANZA se ejecuta la
 * acción de forma directa y determinista; si es menor/ambigua, se cae al
 * flujo conversacional tradicional. Configurable por entorno (JEV_UMBRAL).
 */
const UMBRAL_CONFIANZA = (() => {
    const n = Number(process.env.JEV_UMBRAL);
    return (!Number.isNaN(n) && n > 0 && n < 1) ? n : 0.85;
})();

/**
 * Umbral laxo para NAVEGACIÓN de menús (Enrutamiento por Confianza).
 * Como el cliente quiere que el bot SIEMPRE entre al menú y baje por la rama
 * que mejor encaja (en vez de quedarse mostrando el listado numerado), para las
 * decisiones de navegación (intención CONSULTAR_MENU y elección de categoría)
 * exigimos solo este umbral, más bajo que el de acciones (agregar/quitar/pagar).
 * Si el ganador no lo alcanza, se cae al menú determinista. Configurable por
 * entorno (JEV_UMBRAL_NAVEGACION).
 */
const UMBRAL_NAVEGACION = (() => {
    const n = Number(process.env.JEV_UMBRAL_NAVEGACION);
    return (!Number.isNaN(n) && n > 0 && n < 1) ? n : 0.4;
})();

function _apiKey() {
    return String(process.env.TYPESAFE_API_KEY || '').trim();
}

/**
 * Envía una petición a la API de Jev con el estado del mensaje y las
 * preguntas tipadas.
 *
 * @param {string|Object|Array} stateText - Estado/contexto que evalúan las
 *   preguntas (texto, JSON object o array).
 * @param {Object} questions - Mapa { nombrePregunta: { type, instructions,
 *   criteria } }. type: 'choice' | 'score' | 'noul'.
 * @param {Object} [opts]
 * @param {number} [opts.timeoutMs] - Timeout por intento (default 4000).
 * @param {string} [opts.model]    - Modelo (default jev-latest; pin ej.
 *   jev-1.13.0 en producción si afinás umbrales).
 * @returns {Promise<Object|null>} La respuesta completa { model, answers,
 *   usage } o null ante cualquier fallo.
 */
async function consultarJev(stateText, questions, opts) {
    const apiKey = _apiKey();
    if (!apiKey) return null;
    if (stateText === null || stateText === undefined) return null;
    if (!questions || typeof questions !== 'object' || Object.keys(questions).length === 0) return null;

    const model = (opts && opts.model) || DEFAULT_MODEL;
    const timeoutMs = (opts && opts.timeoutMs) || DEFAULT_TIMEOUT_MS;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
        const res = await fetch(`${API_BASE}/v1/systemone`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ state: stateText, model, questions }),
            signal: controller.signal
        });
        if (!res.ok) {
            console.error(`[Jev] HTTP ${res.status} ${res.statusText}`);
            return null;
        }
        const data = await res.json();
        return data && typeof data === 'object' ? data : null;
    } catch (err) {
        const motivo = (err && err.name === 'AbortError') ? 'timeout' : (err && err.message) || String(err);
        console.error(`[Jev] Error consultando: ${motivo}`);
        return null;
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Extrae la respuesta de tipo 'choice' de una pregunta.
 * @returns {{type:'choice', choice:string, confidence:number, probabilities:Object}|null}
 */
function obtenerChoice(respuesta, nombre) {
    const a = respuesta && respuesta.answers && respuesta.answers[nombre];
    return (a && a.type === 'choice') ? a : null;
}

/**
 * Extrae la respuesta de tipo 'noul' (probabilidad de sí 0..1) de una pregunta.
 * @returns {number|null}
 */
function obtenerNoul(respuesta, nombre) {
    const a = respuesta && respuesta.answers && respuesta.answers[nombre];
    return (a && a.type === 'noul' && typeof a.noul === 'number') ? a.noul : null;
}

/**
 * Extrae la respuesta de tipo 'score' de una pregunta.
 * @returns {{type:'score', score:number, confidence:number, probabilities:Object, legend:Object}|null}
 */
function obtenerScore(respuesta, nombre) {
    const a = respuesta && respuesta.answers && respuesta.answers[nombre];
    return (a && a.type === 'score') ? a : null;
}

/**
 * Consumo de tokens reportado por Jev para una respuesta.
 * @returns {number} input + output tokens (0 si no viene).
 */
function tokensUsados(respuesta) {
    const u = respuesta && respuesta.usage;
    if (!u) return 0;
    return Number(u.input_tokens) + Number(u.output_tokens) || 0;
}

module.exports = {
    consultarJev,
    obtenerChoice,
    obtenerNoul,
    obtenerScore,
    tokensUsados,
    UMBRAL_CONFIANZA,
    UMBRAL_NAVEGACION,
    API_BASE,
    DEFAULT_MODEL
};