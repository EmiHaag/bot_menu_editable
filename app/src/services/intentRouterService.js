const llmChatService = require('../services/llmChatService');
const llmPromptService = require('../services/llmPromptService');
const aiFewShotService = require('../services/aiFewShotService');

/**
 * Motor conversacional hÃ­brido: clasifica la intenciÃ³n del cliente con el LLM
 * (Function Calling) y despacha la acciÃ³n al motor determinista existente
 * (menÃº/carrito). El LLM NO inventa datos: solo referencia triggers del
 * catÃ¡logo real que recibe como contexto.
 *
 * Fallback seguro: si la clasificaciÃ³n falla o no hay certeza, la intenciÃ³n
 * devuelta es 'FALLO' para que el traductor caiga al menÃº estructurado.
 */
const INTENCIONES = [
    'AGREGAR_AL_CARRITO',
    'QUITAR_DEL_CARRITO',
    'CONSULTAR_MENU',
    'CONSULTAR_HORARIOS',
    'VER_CARRITO',
    'FINALIZAR_PEDIDO',
    'CHARLA_GENERAL',
    'NAVEGAR_A',
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
     * Intenciones vÃ¡lidas segÃºn el modo del bot.
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
     * El LLM SOLO referencia triggers del catÃ¡logo real; nunca escribe nombres,
     * precios ni acciones libres. El texto base se lee de Neon (con default en cÃ³digo).
     */
    async _buildSystemPrompt(message, catalogo, contexto) {
        const ai = this.ai;
        const estilo = (ai.estilo && ESTILO_MAP[ai.estilo]) || ai.promptCustom || 'Cordial y profesional, usando "usted", con tono respetuoso y claro.';
        const intenciones = this._getIntenciones();
        const catalogoTxt = catalogo.length
            ? catalogo.map((c, i) => `${i + 1}. trigger "${c.trigger}" â†’ ${c.title}${c.seccion ? ' (SECCIÃ“N)' : ''}${c.price ? ` ($${c.price})` : ''}`).join('\n')
            : '(sin productos en el nivel actual)';

        const reglasFAQ = this.sinCarrito
            ? `- MODO CONSULTA (FAQ): este bot NO vende ni tiene carrito de compras. No existen intenciones de agregar/quitar/ver carrito ni de finalizar/pagar pedido. Si el cliente expresa interÃ©s en una ficha del catÃ¡logo real (por ejemplo "quiero la casa de 3 habitaciones", "me interesa el departamento", "cuÃ¡nto cuesta la casa", "quiero alquilar esa"), usÃ¡ "CONSULTAR_MENU" con el "trigger" de ese Ã­tem en "items" (el sistema mostrarÃ¡ la ficha/informaciÃ³n completa). Las preguntas generales van como CONSULTA (CONSULTAR_MENU o CHARLA_GENERAL). NUNCA uses intenciones de carrito: no existen en este bot.\n`
            : '';
        const reglasTurnos = this.tipoBot === 'TURNOS'
            ? `- MODO TURNOS (agenda): este bot gestiona RESERVAS DE TURNOS; NO vende productos ni tiene carrito de compras. Si el cliente quiere reservar, cambiar, cancelar o ver sus turnos, NUNCA uses "AGREGAR_AL_CARRITO", "QUITAR_DEL_CARRITO", "VER_CARRITO" ni "FINALIZAR_PEDIDO": usÃ¡ "CONSULTAR_MENU" con el "trigger" real del Ã­tem de turnos del catÃ¡logo (por ejemplo el de "reservar turno" o "mis turnos") para que el sistema abra ese flujo determinista. Las preguntas sobre horarios van como "CONSULTAR_HORARIOS".\n`
            : '';
        const reglasSeccion = this.sinCarrito
            ? `- SECCIONES del catÃ¡logo (marcadas "(SECCIÃ“N)") son sub-menÃºs con mÃ¡s fichas. Si el cliente pide ver/entrar a una secciÃ³n, usÃ¡ "CONSULTAR_MENU" e incluÃ­ su trigger en "items". Los Ã­tems que NO son secciÃ³n son fichas/consultas individuales: si el cliente los pide por su nombre, usÃ¡ "CONSULTAR_MENU" con su trigger para abrir la ficha.\n`
            : `- SECCIONES del catÃ¡logo (marcadas "(SECCIÃ“N)") son sub-menÃºs, NO productos vendibles. Si el cliente pide ver/consultar/entrar a una secciÃ³n ("quiero alquilar", "me interesa la venta", "mostrame los departamentos"), usÃ¡ "CONSULTAR_MENU" e incluÃ­ en "items" el trigger de esa SECCIÃ“N para que el sistema navegue a ella. NUNCA uses "AGREGAR_AL_CARRITO" ni "QUITAR_DEL_CARRITO" con el trigger de una SECCIÃ“N.\n`;
        const reglasNavegacion = `- NAVEGACIÃ“N INVISIBLE: el menÃº tiene jerarquÃ­a (raÃ­z â†’ secciones â†’ fichas). El contexto incluye: nodo actual, padre, hermanos, raÃ­z y ruta completa. Si el pedido del cliente NO encaja en las opciones del nivel actual PERO coincide con otra secciÃ³n (hermano, padre, raÃ­z, etc.) O con las palabras clave de un contacto de derivaciÃ³n, usÃ¡ la herramienta "navegar_a" con el triggerDestino de ese nodo/secciÃ³n y una razon breve. NO avises al usuario que estÃ¡s navegando; el sistema lo hace silenciosamente y re-clasifica. Ejemplos: cliente en ficha pide "visita" â†’ navegar_a trigger "agendar-visita" razon "pide visita, nodo actual es ficha"; cliente en secciÃ³n pide "volver" â†’ navegar_a trigger padre razon "quiere volver al menÃº anterior"; cliente pide "quiero hablar con un asesor de ventas" y hay contacto con keyword "ventas" â†’ navegar_a trigger de la secciÃ³n que atiende ese contacto.\n`;

        const template = await llmPromptService.getPrompt('clasificador');
        const prompt = llmPromptService.renderPrompt(template, {
            negocio: this.negocio,
            intenciones: intenciones.join(', '),
            reglas_faq: reglasFAQ,
            reglas_turnos: reglasTurnos,
            reglas_seccion: reglasSeccion,
            reglas_navegacion: reglasNavegacion,
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
                        ? ` â†’ Ã­tems: ${ex.items.map(i => `${i.trigger}${i.cantidad > 1 ? 'Ã—' + i.cantidad : ''}`).join(', ')}`
                        : '';
                    return `  - "${ex.userInput}" â†’ ${ex.intent}${itemsStr}`;
                });
                fewShotBlock = `\nEJEMPLOS CORREGIDOS (aprendÃ© de estos casos):\n${lines.join('\n')}\n`;
            }
        } catch (_) { /* Neon no disponible, skip few-shot */ }

        return prompt + fewShotBlock;
    }

    _toolDefinition() {
        return [
            {
                type: 'function',
                function: {
                    name: 'clasificar_intencion',
                    description: 'Clasifica la intenciÃ³n del cliente y extrae los Ã­tems/pedido relevante.',
                    parameters: {
                        type: 'object',
                        properties: {
                            intencion: {
                                type: 'string',
                                enum: this._getIntenciones(),
                                description: 'IntenciÃ³n detectada del mensaje.'
                            },
                            items: {
                                type: 'array',
                                description: this.sinCarrito
                                    ? 'Ãtems reales del catÃ¡logo que el cliente pide ver o consultar (fichas o SECCIONES): para CONSULTAR_MENU, el Ã­tem/ficha que el cliente pidiÃ³ o la SECCIÃ“N (sub-menÃº) que quiere explorar. DevolvÃ©s el trigger tal como figura en el catÃ¡logo.'
                                    : 'Ãtems o SECCIONES del catÃ¡logo real: para AGREGAR_AL_CARRITO / QUITAR_DEL_CARRITO, el producto vendible; para CONSULTAR_MENU, la SECCIÃ“N (sub-menÃº) que el cliente pide ver. DevolvÃ©s el trigger tal como figura en el catÃ¡logo.',
                                items: {
                                    type: 'object',
                                    properties: {
                                        trigger: { type: 'string', description: 'Trigger exacto del producto o secciÃ³n en el catÃ¡logo real.' },
                                        cantidad: { type: 'number', description: 'Cantidad de unidades (default 1).' },
                                        nota: { type: 'string', description: 'AclaraciÃ³n en texto libre (opcional).' }
                                    },
                                    required: ['trigger']
                                }
                            },
                            respuesta_conversacional: {
                                type: 'string',
                                description: 'Respuesta breve y amigable confirmando la intenciÃ³n.'
                            }
                        },
                        required: ['intencion', 'respuesta_conversacional']
                    }
                }
            },
            {
                type: 'function',
                function: {
                    name: 'navegar_a',
                    description: 'Navegar silenciosamente a otro nodo del menÃº cuando el pedido no encaja en el nivel actual. Ãšsalo si el cliente pide algo que estÃ¡ en otra secciÃ³n, en el padre o en la raÃ­z. NO avises al usuario.',
                    parameters: {
                        type: 'object',
                        properties: {
                            triggerDestino: { type: 'string', description: 'Trigger exacto del nodo destino (debe existir en el menÃº: actual, padre, hermano, raÃ­z, etc.)' },
                            razon: { type: 'string', description: 'Por quÃ© navegas ahÃ­ (ej: "cliente pidiÃ³ visita pero estoy en ficha de propiedad")' }
                        },
                        required: ['triggerDestino', 'razon']
                    }
                }
            }
        ];
    }

    /**
     * Ejecuta la llamada al LLM y devuelve la clasificaciÃ³n normalizada.
     * Devuelve { intencion, items, respuesta_conversacional } o
     * { intencion: 'NAVEGAR_A', triggerDestino, razon } o
     * { intencion: 'FALLO', ... } ante cualquier fallo/invÃ¡lido.
     */
    async clasificar(jid, message, onTokens) {
        if (this.quotaBlocked) return { intencion: 'FALLO', items: [], respuesta_conversacional: '' };

        const catalogo = await this.buildCatalogo(jid).catch(() => []);
        const contexto = await this.buildContexto(jid).catch(() => '');
        const systemPrompt = await this._buildSystemPrompt(message, catalogo, contexto);

        let captured = null;
        let usedTool = null;
        const executeTool = async (name, args) => {
            if (name === 'clasificar_intencion' || name === 'navegar_a') {
                usedTool = name;
                captured = args || {};
                return JSON.stringify(captured);
            }
            return 'Error: herramienta desconocida';
        };

        try {
            await llmChatService.chat({
                systemPrompt,
                messages: [{ role: 'user', content: String(message) }],
                tools: this._toolDefinition(),
                executeTool,
                onTokens,
                toolChoice: 'required',
                earlyStop: (name) => name === 'clasificar_intencion' || name === 'navegar_a',
                temperature: this.temperature
            });
            // La clasificaciÃ³n viene en la tool call (captured), no en el texto final.
            return this._normalizarClasificacion(captured, catalogo, usedTool);
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
     * Verifica si la intenciÃ³n devuelta por el LLM es vÃ¡lida segÃºn el modo.
     * 'FALLO' siempre es aceptable (es el fallback interno del sistema).
     */
    _esIntencionValida(intencion) {
        return intencion === 'FALLO' || this._getIntenciones().includes(intencion);
    }

    /**
     * Interpreta la clasificaciÃ³n (args de la tool call o fallback al resultado).
     * Valida contra el catÃ¡logo real. Para NAVEGAR_A no valida triggers contra catÃ¡logo.
     */
    _normalizarClasificacion(input, catalogo, usedTool) {
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

        // NAVEGAR_A: no validar trigger contra catÃ¡logo, solo pasar datos
        if (usedTool === 'navegar_a' || parsed.intencion === 'NAVEGAR_A') {
            return {
                intencion: 'NAVEGAR_A',
                triggerDestino: parsed.triggerDestino || '',
                razon: parsed.razon || ''
            };
        }

        // Validar triggers contra el catÃ¡logo real (anti-alucinaciÃ³n)
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
    cercano: 'Cercana y descontracturada, usando "vos", con emojis y tono cÃ¡lido.',
    formal: 'Formal, directa y concisa, sin emojis ni rodeos.'
};

module.exports = IntentRouterService;

