const llmChatService = require('../services/llmChatService');

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
     */
    constructor({ idCliente, stateService, menuController, orderService, buildCatalogo, buildContexto, ai, negocio }) {
        this.idCliente = idCliente;
        this.stateService = stateService;
        this.menuController = menuController || null;
        this.orderService = orderService || null;
        this.buildCatalogo = buildCatalogo || (async () => []);
        this.buildContexto = buildContexto || (async () => '');
        this.ai = ai || {};
        this.negocio = negocio || idCliente;
        this.quotaBlocked = false;
    }

    /**
     * Prompt de sistema para el clasificador de intenciones.
     * El LLM SOLO referencia triggers del catálogo real; nunca escribe nombres,
     * precios ni acciones libres.
     */
    _buildSystemPrompt(message, catalogo, contexto) {
        const ai = this.ai;
        const estilo = (ai.estilo && ESTILO_MAP[ai.estilo]) || ai.promptCustom || 'Cordial y profesional, usando "usted", con tono respetuoso y claro.';
        const catalogoTxt = catalogo.length
            ? catalogo.map((c, i) => `${i + 1}. trigger "${c.trigger}" → ${c.title}${c.price ? ` ($${c.price})` : ''}`).join('\n')
            : '(sin productos en el nivel actual)';

        return `Sos el CLASIFICADOR de intenciones del bot de WhatsApp de "${this.negocio}".\n` +
            `NO actuás por tu cuenta: tu ÚNICA tarea es analizar el mensaje del cliente y llamar a la herramienta "clasificar_intencion" con los datos estructurados. El sistema determinista ejecuta la acción.\n\n` +
            `REGLAS (obligatorias):\n` +
            `- Elegí UNA de estas intenciones: ${INTENCIONES.filter(i => i !== 'FALLO').join(', ')}.\n` +
            `- DISTINGUÍ CONSULTA DE COMPRA (obligatorio): cada negocio es distinto (comida, propiedades, servicios, turnos, etc.) y este bot vende lo que figura en el CATÁLOGO REAL de abajo. Una PREGUNTA o consulta ("¿qué ofrecen?", "¿cuánto cuesta?", "¿tenés X?", "¿está disponible?", "¿me pasás el precio?", "¿en qué horarios atienden?") es SIEMPRE "CONSULTAR_MENU" con "respuesta_conversacional" informativa. Las consultas NO se agregan al carrito, NO son compras y NUNCA derivan a un humano.\n` +
            `- AGREGAR_AL_CARRITO SOLO cuando el cliente pide COMPRAR/ADQUIRIR/ENCARGAR un producto o servicio CONCRETO con intención de compra real (ej. "quiero comprar/encargar [ITEM del catálogo]", "me llevo [ITEM]", "quiero contratar [SERVICIO]"). Si el ITEM pedido está en el CATÁLOGO REAL, usá "AGREGAR_AL_CARRITO" con su "trigger". NUNCA uses "CONSULTAR_MENU" ni "CHARLA_GENERAL" cuando el cliente ya nombró qué quiere comprar.\n` +
            `- Solo usá "CONSULTAR_MENU" cuando el cliente pida VER el menú, las opciones generales o haga una consulta sin intención de compra concreta ("qué tienen", "mostrá el menú", "opciones").\n` +
            `- Para AGREGAR_AL_CARRITO / QUITAR_DEL_CARRITO: solo podés usar productos listados en el CATÁLOGO REAL de abajo. Devolvé SIEMPRE el "trigger" del producto (no inventes nombres ni triggers). "cantidad" es el número de unidades (default 1). "nota" (opcional) es una aclaración en texto libre.\n` +
            `- Si menciona algo que no está en el catálogo, o hay AMBIGÜEDAD entre varios productos, NO inventes: usá intencion "FALLO" o "CONSULTAR_MENU" y dejala al sistema.\n` +
            `- FINALIZAR_PEDIDO: cuando el cliente quiere terminar/pagar ("listo", "nada más", "quiero pagar", "no listo", etc.) y tiene ítems en el pedido.\n` +
            `- CONSULTAR_MENU / CONSULTAR_HORARIOS / VER_CARRITO / CHARLA_GENERAL: para consultas o charla. "respuesta_conversacional" debe ser breve y amigable, SIEMPRE en el estilo: ${estilo}\n` +
            `- NUNCA inventes precios, productos, horarios ni descuentos. Si no lo sabés, no lo afirmes.\n` +
            `- Si el mensaje no encaja con certeza alta o no se entiende, usá intencion "FALLO".\n\n` +
            `${contexto}\n\n` +
            `CATÁLOGO REAL DEL NIVEL ACTUAL:\n${catalogoTxt}\n`;
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
                            enum: INTENCIONES,
                            description: 'Intención detectada del mensaje.'
                        },
                        items: {
                            type: 'array',
                            description: 'Ítems relevantes para AGREGAR_AL_CARRITO / QUITAR_DEL_CARRITO.',
                            items: {
                                type: 'object',
                                properties: {
                                    trigger: { type: 'string', description: 'Trigger exacto del producto en el catálogo real.' },
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
        const systemPrompt = this._buildSystemPrompt(message, catalogo, contexto);

        let captured = null;
        const executeTool = async (name, args) => {
            if (name !== 'clasificar_intencion') return 'Error: herramienta desconocida';
            captured = args || {};
            return JSON.stringify(captured);
        };

        try {
            const result = await llmChatService.chat({
                systemPrompt,
                messages: [{ role: 'user', content: String(message) }],
                tools: this._toolDefinition(),
                executeTool,
                onTokens
            });
            // La clasificación viene en la tool call (captured), no en el texto final.
            return this._normalizarClasificacion(captured || result, catalogo);
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

        if (!parsed || typeof parsed.intencion !== 'string' || !INTENCIONES.includes(parsed.intencion)) {
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
