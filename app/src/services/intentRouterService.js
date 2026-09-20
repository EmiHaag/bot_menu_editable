const llmChatService = require('../services/llmChatService');
const llmPromptService = require('../services/llmPromptService');
const aiFewShotService = require('../services/aiFewShotService');

/**
 * Motor conversacional híbrido: clasifica la intención del cliente con el LLM
 * (Function Calling) y despacha la acción al motor determinista existente
 * (menú/carrito). El LLM NO inventa datos: solo referencia triggers del
 * catálogo real que recibe como contexto.
 *
 * Fallback seguro: si la clasificación falla o no hay certeza, la intención
 * devuelta es 'FALLO' para que el traductor caiga al menú estructurado.
 */
const INTENCIONES = [
    'AGREGAR_AL_CARRITO',
    'QUITAR_DEL_CARRITO',
    'CONSULTAR_MENU',
    'CONSULTAR_HORARIOS',
    'VER_CARRITO',
    'FINALIZAR_PEDIDO',
    'CHARLA_GENERAL',
    'FALLO'
];

class IntentRouterService {
    /**
     * @param {Object} opts
     * @param {string} opts.idCliente
     * @param {StateService} opts.stateService
     * @param {MenuController} opts.menuController
     * @param {Object} opts.orderService
     * @param {Function} opts.buildCatalogo - async (jid) => [{trigger,title,price}]
     * @param {Function} opts.buildContexto  - async (jid) => texto de contexto adicional (pedido, horarios, faq)
     * @param {Object} opts.ai              - config ai_config (estilo, promptCustom, instrucciones)
     * @param {string} opts.negocio         - nombre del negocio
     * @param {boolean} [opts.sinCarrito]   - true para bots tipo FAQ/consulta: no existe carrito de compras.
     * @param {string} [opts.tipoBot]       - tipo de bot: 'CARRITO' | 'TURNOS' | 'FAQ'.
     * @param {number} [opts.temperature]   - temperatura del clasificador (default 0.6; 0 para benchmarks).
     */
    constructor({ idCliente, stateService, menuController, orderService, buildCatalogo, buildContexto, ai, negocio, sinCarrito, tipoBot, temperature }) {
        this.idCliente = idCliente;
        this.stateService = stateService;
        this.menuController = menuController || null;
        this.orderService = orderService || null;
        this.buildCatalogo = buildCatalogo || (async () => []);
        this.buildContexto = buildContexto || (async () => '');
        this.ai = ai || {};
        this.negocio = negocio || idCliente;
        this.sinCarrito = !!(sinCarrito);
        this.tipoBot = tipoBot || (sinCarrito ? 'FAQ' : 'CARRITO');
        this.temperature = temperature;
        this.quotaBlocked = false;
    }

    /**
     * Intenciones válidas según el modo del bot.
     * FAQ/consulta (sinCarrito): no existen intenciones de carrito ni de pago.
     */
    _getIntenciones() {
        if (this.sinCarrito) {
            return ['CONSULTAR_MENU', 'CONSULTAR_HORARIOS', 'CHARLA_GENERAL'];
        }
        return INTENCIONES.filter(i => i !== 'FALLO');
    }

    /**
     * Prompt de sistema para el clasificador de intenciones.
     * El LLM SOLO referencia triggers del catálogo real; nunca escribe nombres,
     * precios ni acciones libres. El texto base se lee de Neon (con default en código).
     */
    async _buildSystemPrompt(message, catalogo, contexto) {
        const ai = this.ai;
        const estilo = (ai.estilo && ESTILO_MAP[ai.estilo]) || ai.promptCustom || 'Cordial y profesional, usando "usted", con tono respetuoso y claro.';
        const intenciones = this._getIntenciones();
        const catalogoTxt = catalogo.length
            ? catalogo.map((c, i) => `${i + 1}. trigger "${c.trigger}" → ${c.title}${c.seccion ? ' (SECCIÓN)' : ''}${c.price ? ` ($${c.price})` : ''}`).join('\n')
            : '(sin productos en el nivel actual)';

        const reglasFAQ = this.sinCarrito
            ? `- MODO CONSULTA (FAQ): este bot NO vende ni tiene carrito de compras. No existen intenciones de agregar/quitar/ver carrito ni de finalizar/pagar pedido. Si el cliente expresa interés en una ficha del catálogo real (por ejemplo "quiero la casa de 3 habitaciones", "me interesa el departamento", "cuánto cuesta la casa", "quiero alquilar esa"), usá "CONSULTAR_MENU" con el "trigger" de ese ítem en "items" (el sistema mostrará la ficha/información completa). Las preguntas generales van como CONSULTA (CONSULTAR_MENU o CHARLA_GENERAL). NUNCA uses intenciones de carrito: no existen en este bot.\n`
            : '';
        const reglasTurnos = this.tipoBot === 'TURNOS'
            ? `- MODO TURNOS (agenda): este bot gestiona RESERVAS DE TURNOS; NO vende productos ni tiene carrito de compras. Si el cliente quiere reservar, cambiar, cancelar o ver sus turnos, NUNCA uses "AGREGAR_AL_CARRITO", "QUITAR_DEL_CARRITO", "VER_CARRITO" ni "FINALIZAR_PEDIDO": usá "CONSULTAR_MENU" con el "trigger" real del ítem de turnos del catálogo (por ejemplo el de "reservar turno" o "mis turnos") para que el sistema abra ese flujo determinista. Las preguntas sobre horarios van como "CONSULTAR_HORARIOS".\n`
            : '';
        const reglasSeccion = this.sinCarrito
            ? `- SECCIONES del catálogo (marcadas "(SECCIÓN)") son sub-menús con más fichas. Si el cliente pide ver/entrar a una sección, usá "CONSULTAR_MENU" e incluí su trigger en "items". Los ítems que NO son sección son fichas/consultas individuales: si el cliente los pide por su nombre, usá "CONSULTAR_MENU" con su trigger para abrir la ficha.\n`
            : `- SECCIONES del catálogo (marcadas "(SECCIÓN)") son sub-menús, NO productos vendibles. Si el cliente pide ver/consultar/entrar a una sección ("quiero alquilar", "me interesa la venta", "mostrame los departamentos"), usá "CONSULTAR_MENU" e incluí en "items" el trigger de esa SECCIÓN para que el sistema navegue a ella. NUNCA uses "AGREGAR_AL_CARRITO" ni "QUITAR_DEL_CARRITO" con el trigger de una SECCIÓN.\n`;

        const template = await llmPromptService.getPrompt('clasificador');
        const prompt = llmPromptService.renderPrompt(template, {
            negocio: this.negocio,
            intenciones: intenciones.join(', '),
            reglas_faq: reglasFAQ,
            reglas_turnos: reglasTurnos,
            reglas_seccion: reglasSeccion,
            estilo,
            contexto: contexto || '',
            catalogo: catalogoTxt
        });

        // Few-shot examples from synthetic pipeline (Neon).
        let fewShotBlock = '';
        try {
            const examples = await aiFewShotService.getExamples(this.idCliente);
            if (examples.length > 0) {
                const lines = examples.map(ex => {
                    const itemsStr = (ex.items || []).length
                        ? ` → ítems: ${ex.items.map(i => `${i.trigger}${i.cantidad > 1 ? '×' + i.cantidad : ''}`).join(', ')}`
                        : '';
                    return `  - "${ex.userInput}" → ${ex.intent}${itemsStr}`;
                });
                fewShotBlock = `\nEJEMPLOS CORREGIDOS (aprendé de estos casos):\n${lines.join('\n')}\n`;
            }
        } catch (_) { /* Neon no disponible, skip few-shot */ }

        return prompt + fewShotBlock;
    }

    _toolDefinition() {
        return [{
            type: 'function',
            function: {
                name: 'clasificar_intencion',
                description: 'Clasifica la intención del cliente y extrae los ítems/pedido relevante.',
                parameters: {
                    type: 'object',
                    properties: {
                        intencion: {
                            type: 'string',
                            enum: this._getIntenciones(),
                            description: 'Intención detectada del mensaje.'
                        },
                        items: {
                            type: 'array',
                            description: this.sinCarrito
                                ? 'Ítems reales del catálogo que el cliente pide ver o consultar (fichas o SECCIONES): para CONSULTAR_MENU, el ítem/ficha que el cliente pidió o la SECCIÓN (sub-menú) que quiere explorar. Devolvés el trigger tal como figura en el catálogo.'
                                : 'Ítems o SECCIONES del catálogo real: para AGREGAR_AL_CARRITO / QUITAR_DEL_CARRITO, el producto vendible; para CONSULTAR_MENU, la SECCIÓN (sub-menú) que el cliente pide ver. Devolvés el trigger tal como figura en el catálogo.',
                            items: {
                                type: 'object',
                                properties: {
                                    trigger: { type: 'string', description: 'Trigger exacto del producto o sección en el catálogo real.' },
                                    cantidad: { type: 'number', description: 'Cantidad de unidades (default 1).' },
                                    nota: { type: 'string', description: 'Aclaración en texto libre (opcional).' }
                                },
                                required: ['trigger']
                            }
                        },
                        respuesta_conversacional: {
                            type: 'string',
                            description: 'Respuesta breve y amigable confirmando la intención.'
                        }
                    },
                    required: ['intencion', 'respuesta_conversacional']
                }
            }
        }];
    }

    /**
     * Ejecuta la llamada al LLM y devuelve la clasificación normalizada.
     * Devuelve { intencion, items, respuesta_conversacional } o
     * { intencion: 'FALLO', ... } ante cualquier fallo/inválido.
     */
    async clasificar(jid, message, onTokens) {
        if (this.quotaBlocked) return { intencion: 'FALLO', items: [], respuesta_conversacional: '' };

        const catalogo = await this.buildCatalogo(jid).catch(() => []);
        const contexto = await this.buildContexto(jid).catch(() => '');
        const systemPrompt = await this._buildSystemPrompt(message, catalogo, contexto);

        let captured = null;
        const executeTool = async (name, args) => {
            if (name !== 'clasificar_intencion') return 'Error: herramienta desconocida';
            captured = args || {};
            return JSON.stringify(captured);
        };

        try {
            await llmChatService.chat({
                systemPrompt,
                messages: [{ role: 'user', content: String(message) }],
                tools: this._toolDefinition(),
                executeTool,
                onTokens,
                toolChoice: 'required',
                earlyStop: (name) => name === 'clasificar_intencion',
                temperature: this.temperature
            });
            // La clasificación viene en la tool call (captured), no en el texto final.
            return this._normalizarClasificacion(captured, catalogo);
        } catch (err) {
            if (err && err.isQuotaExceeded) {
                this.quotaBlocked = true;
                console.warn(`[IntentRouter] ${this.idCliente}: bloqueado por cuota`);
            } else {
                console.error(`[IntentRouter] ${this.idCliente}: error clasificando:`, err.message);
            }
            return { intencion: 'FALLO', items: [], respuesta_conversacional: '' };
        }
    }

    /**
     * Verifica si la intención devuelta por el LLM es válida según el modo.
     * 'FALLO' siempre es aceptable (es el fallback interno del sistema).
     */
    _esIntencionValida(intencion) {
        return intencion === 'FALLO' || this._getIntenciones().includes(intencion);
    }

    /**
     * Interpreta la clasificación (args de la tool call o fallback al resultado).
     * Valida contra el catálogo real.
     */
    _normalizarClasificacion(input, catalogo) {
        let parsed = null;

        if (input && typeof input === 'object' && !Array.isArray(input)) {
            if (typeof input.content === 'string' && typeof input.intencion !== 'string') {
                // Viene de un resultado de chat: intentar parsear el JSON del contenido.
                try {
                    parsed = JSON.parse(input.content);
                } catch (err) {
                    const m = input.content.match(/\{[\s\S]*\}/);
                    if (m) { try { parsed = JSON.parse(m[0]); } catch (_) { parsed = null; } }
                }
            } else {
                // Viene de los args de la tool call.
                parsed = input;
            }
        }

        if (!parsed || typeof parsed.intencion !== 'string' || !this._esIntencionValida(parsed.intencion)) {
            return { intencion: 'FALLO', items: [], respuesta_conversacional: '' };
        }

        // Validar triggers contra el catálogo real (anti-alucinación)
        const triggersValidos = new Set((catalogo || []).map(c => String(c.trigger).toLowerCase()));
        const items = Array.isArray(parsed.items) ? parsed.items : [];
        const itemsValidos = items
            .filter(it => it && typeof it.trigger === 'string' && triggersValidos.has(String(it.trigger).toLowerCase()))
            .map(it => ({
                trigger: String(it.trigger).toLowerCase(),
                cantidad: Number(it.cantidad) > 0 ? Number(it.cantidad) : 1,
                nota: typeof it.nota === 'string' ? it.nota : ''
            }));

        return {
            intencion: parsed.intencion,
            items: itemsValidos,
            respuesta_conversacional: typeof parsed.respuesta_conversacional === 'string' ? parsed.respuesta_conversacional : ''
        };
    }
}

const ESTILO_MAP = {
    profesional: 'Cordial y profesional, usando "usted", con tono respetuoso y claro. Sin emojis excesivos.',
    cercano: 'Cercana y descontracturada, usando "vos", con emojis y tono cálido.',
    formal: 'Formal, directa y concisa, sin emojis ni rodeos.'
};

module.exports = IntentRouterService;
