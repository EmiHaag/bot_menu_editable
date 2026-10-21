const userService = require('../services/userService');
const botConfigService = require('../services/botConfigService');
const aiUsageService = require('../services/aiUsageService');
const llmChatService = require('../services/llmChatService');
const llmPromptService = require('../services/llmPromptService');
const jevService = require('../services/jevService');

const ESTILOS = {
    profesional: 'Cordial y profesional, usando "usted", con tono respetuoso y claro. Sin emojis excesivos.',
    cercano: 'Cercana y descontracturada, usando "vos", con emojis y tono cálido.',
    formal: 'Formal, directa y concisa, sin emojis ni rodeos.'
};

const TAGS = ['##TURNO##', '##PEDIDO##', '##CANTIDAD##', '##DATOS##', '##ARCHIVO##', '##FINALIZAR##', '##COMPLETAR##', '##PAGAR##'];

// Umbral de fallos consecutivos de traducción antes de derivar a un humano
const MAX_TRANSLATION_FAILS = 3;

// Tope de candidatos de navegación que Jev puede elegir (nivel actual +
// hermanos + menú principal + ramas profundas). Limita el prompt y mantiene la
// confianza alta.
const MAX_CANDIDATOS_NAVEGACION = 45;

// Palabras vacías del español/inglés comunes en pedidos de menú. Se usan para
// el matching determinista (_matchOption) y para el scoring de relevancia de
// candidatos profundos (_scoreRelevancia).
const STOPWORDS = new Set(['nada', 'mas', 'más', 'solo', 'sola', 'una', 'un', 'dos', 'tres', 'el', 'la', 'los', 'las', 'y', 'e', 'mi', 'para', 'por', 'con', 'de', 'del', 'que', 'quiero', 'me', 'te', 'se', 'es', 'en', 'a', 'o', 'pero', 'cuanto', 'hay', 'tiene', 'tienen', 'trae', 'dame', 'dar', 'otra', 'otro', 'cada', 'otras', 'otros', 'seria', 'sería', 'todo']);

// Profundidad de ramas que se despliegan como candidatos para Jev (hijos,
// nietos, ...). Si en el primer nivel no hay coincidencia fuerte, Jev puede
// elegir un nodo más profundo del subárbol del nivel actual. Configurable por
// entorno (JEV_PROFUNDIDAD_NAVEGACION).
const PROFUNDIDAD_NAVEGACION = (() => {
    const n = Number(process.env.JEV_PROFUNDIDAD_NAVEGACION);
    return (Number.isInteger(n) && n >= 1 && n <= 6) ? n : 3;
})();

// Cantidad máxima de niveles que Jev puede "descender" dentro de una sección
// elegida. Si la opción destino es una sección con sub-opciones, se evalúan
// esas sub-opciones: si alguna coincide con confianza de navegación, se navega
// a ella (y se repite, hasta este tope). Si ninguna coincide, se queda en la
// sección elegida.
const MAX_DESCENSO_NAVEGACION = (() => {
    const n = Number(process.env.JEV_DESCENSO_NAVEGACION);
    return (Number.isInteger(n) && n >= 0 && n <= 5) ? n : 3;
})();

class AITranslatorController {
    /**
     * @param {Object} opts
     * @param {string} opts.idCliente
     * @param {GoogleSheetsService} opts.googleSheetsService
     * @param {StateService} opts.stateService
     * @param {OrderService} opts.orderService
     * @param {MenuController} opts.menuController
     *
     * Rol: TRADUCTOR entre lenguaje natural y el MENÚ del negocio. NO ejecuta
     * acciones sobre el menú (no navega, no agrega al carrito, no finaliza).
     * El menú es SIEMPRE el handler. Este controller solo:
     *   1. reformulate(rawText, jid): reformula las salidas del menú en tono
     *      amable y sin números/triggers (usado por el wrapper de sock.sendMessage).
     *   2. handleMessage(...): interpreta el texto del cliente, busca en el menú
     *      actual la opción correspondiente y devuelve el trigger que el menú
     *      espera (o false para que el menú procese el texto directo).
     * Mantiene además: derivar a vendedor (loop de no-match) y silencio post-pedido.
     */
    constructor({ idCliente, googleSheetsService, stateService, orderService, menuController }) {
        this.idCliente = idCliente;
        this.googleSheetsService = googleSheetsService;
        this.stateService = stateService;
        this.orderService = orderService;
        this.menuController = menuController || null;
        // Circuit breaker en memoria: si OpenAI devuelve 429 (insufficient_quota),
        // dejamos de golpear la API y pasamos a modo menú hasta reiniciar.
        // OpenAI solo se usa para reformular a lenguaje natural (reformulate).
        this.quotaBlocked = false;
        // Tipo de bot según la config (CARRITO/TURNOS/FAQ). Se actualiza en cada
        // handleMessage; la IA lo usa para saber si existe o no el flujo de carrito.
        this._botType = 'CARRITO';
    }

    /**
     * Inicializa (lazy) el router de intenciones con el catálogo/contexto reales.
     */
    _delay(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    async _sendTyping(sock, jid, replyLen = 20) {
        try {
            await sock.sendPresenceUpdate('paused', jid);
            await this._delay(process.env.TIEMPO_ESPERA_RESPUESTA || 500);
            await sock.sendPresenceUpdate('composing', jid);
            const minMs = Number(process.env.TIEMPO_BOT_ESTA_ESCRIBIENDO) || 1200;
            const extra = Math.min(2500, Math.max(0, replyLen * 40));
            await this._delay(minMs + extra);
        } catch {}
    }

    _phoneToJid(telefono) {
        if (!telefono) return null;
        const numero = String(telefono).trim().split('@')[0].replace(/\+/g, '');
        if (!numero) return null;
        return numero.includes('@') ? numero : `${numero}@s.whatsapp.net`;
    }

    _limpiarTags(texto) {
        if (!texto) return '';
        let t = String(texto);
        for (const tag of TAGS) t = t.split(tag).join('').trim();
        return t;
    }

    async _getNodeById(id) {
        try {
            return await this.googleSheetsService.getNodeById(id);
        } catch (err) {
            console.error('[AI] Error getNodeById:', err.message);
            return null;
        }
    }

    async _getChildren(parentId) {
        try {
            return await this.googleSheetsService.getNodesByParent(parentId);
        } catch (err) {
            console.error('[AI] Error getNodesByParent:', err.message);
            return [];
        }
    }

    /**
     * Detecta si el nodo es un "paso" del checkout de qué tipo.
     */
    _tipoPaso(node) {
        if (!node || !node.message) return null;
        const m = String(node.message);
        if (m.includes('##PAGAR##')) return 'pagar';
        if (m.includes('##DATOS##')) return 'datos';
        if (m.includes('##ARCHIVO##')) return 'foto';
        if (m.includes('##FINALIZAR##')) return 'finalizar';
        return null;
    }

    _describirPaso(tipo) {
        switch (tipo) {
            case 'datos': return '[paso: DATO en texto]';
            case 'foto': return '[paso: COMPROBANTE en imagen]';
            case 'finalizar': return '[paso: CONFIRMAR/FINALIZAR pedido]';
            case 'pagar': return '[paso: INICIO DEL PAGO]';
            default: return '';
        }
    }

    _esPasoCheckout(node) {
        return !!this._tipoPaso(node);
    }

    /**
     * ¿Una opción del catálogo es una SECCIÓN (categoría navegable, con hijos
     * en el menú) y no una hoja/producto final? Se usa para saber si el cliente
     * que nombra/consulta un tema quiere DESPLEGAR su lista (navegar) en lugar
     * de comprar algo concreto.
     */
    async _esSeccionCatalogo(jid, trigger) {
        try {
            if (!trigger) return false;
            const nodeId = this.stateService.getUserState(jid) || 'root';
            const opciones = await this._opcionesNivel(jid, nodeId);
            const opt = (opciones || []).find(o => String(o.trigger) === String(trigger));
            return !!(opt && opt.seccion);
        } catch (err) {
            return false;
        }
    }

    /**
     * Convierte un texto de una opción del menú a un trigger limpio
     * (el menú acepta dígitos, letras o palabras como "p", "v", "0").
     */
    _normalizarMatch(t) {
        return String(t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
    }

    /**
     * Detecta si el mensaje es un saludo típico de inicio de conversación.
     */
    _esSaludo(t) {
        return /\b(hola|buenas|buen dia|buenos dias|buenas tardes|buenas noches|hello|hey|hi|que tal|que onda|como estas|como anda|como andas|como te va|como te viene|saludos)\b/.test(this._normalizarMatch(t));
    }

    /**
     * ¿Es un saludo "puro"? El mensaje solo saluda/agradece, sin intención
     * adicional (no pide nada, no consulta, no navega). Si viene acompañado de
     * una intención ("hola, quiero alquilar"), NO es un saludo puro: la intención
     * debe capturarse y procesarse (compra, consulta, etc.).
     */
    _esSaludoPuro(t) {
        const n = this._normalizarMatch(t);
        if (!this._esSaludo(t)) return false;
        // Si hay intención explícita además del saludo, no es puro.
        // Se usan RAÍCES sin límite de fin de palabra (y género de palabras
        // completas) para que también matcheen plurales ("alquileres",
        // "departamentos") y gerundios ("consultando", "buscando"): si no, un
        // primer mensaje como "hola estoy consultando por alquileres" se
        // trataba como saludo puro y se perdía la intención.
        if (/\b(?:quier[oaes]|gustari[ao]|necesit[ao]|busc|consult|averigu|pregunt|tengo\s+una\s+(?:consulta|duda)|interesa|ando\s+buscando|estoy\s+buscando|queria\s+saber|quería\s+saber|a\s+que\s+hora|cuanto\s+cuesta|cuanto\s+vale|preci|disponib|compr|vend|contrat|reserv|turn|pedir|encarg|listo\s+para|pago|pagar)/i.test(n)) {
            return false;
        }
        return true;
    }

    /**
     * Detecta si el mensaje es una consulta/pregunta/negación aunque el LLM
     * lo haya clasificado como AGREGAR_AL_CARRITO. Patrones como "no tenés
     * más?", "qué más tenés", "otras opciones?", etc. son preguntas claras,
     * NO intención de compra. Si devuelve true, la intención debe forzarse a
     * CONSULTAR_MENU para evitar agregar al carrito por error.
     */
    _esConsultaImplicita(text) {
        const n = this._normalizarMatch(text);
        // Preguntas directas
        if (/\b(?:que (?:mas|mas opciones|otras opciones|otro|otra|opcion|opciones|tenes|tienen)|hay (?:mas|otras|otros)|(?:tenes|tienen|hay) (?:mas|otras|otros|algo mas|mas opciones)|(?:otras?|mas) (?:opciones?|propiedades?|inmuebles?)|(?:cuanto|cuesta|vale|precio|disponibilidad|contacto|telefono|whatsapp|mail|correo|horario|direccion|donde|ubicacion|mapa))\b/.test(n)) return true;
        // Negaciones + pregunta
        if (/\b(?:no (?:hay|tenes|tienen|tengo|disponible|encuentro|veo)|que (?:pasa|sucede|hay))\b/.test(n)) return true;
        // Preguntas con "?" al final
        if (/\?\s*$/.test(text.trim())) {
            // Si además contiene palabras de consulta (no es "quiero X" que sería compra)
            if (/\b(?:que|cuando|donde|como|cuanto|quien|por que|porque|haber|hay|existe|disponible|opciones?|alternativas?|info|informacion|detalles?|mas|otras?|algo)\b/.test(n)) return true;
        }
        return false;
    }

    /**
     * ¿El bot es de tipo FAQ/consulta (sin carrito de compras)?
     */
    _esFAQ() {
        return this._botType === 'FAQ';
    }

    /**
     * ¿El bot NO tiene carrito de compras? FAQ y TURNOS no venden productos ni
     * arman pedidos: navegan/abren fichas. Se usa para que la clasificación de
     * Jev y el procesador de intenciones no intenten agregar/quitar/finalizar.
     */
    _esSinCarrito() {
        return this._esFAQ() || this._botType === 'TURNOS';
    }

    /**
     * Tipo de bot en curso (CARRITO/TURNOS/FAQ). Se actualiza en cada mensaje.
     * Lo usa app.js para NO interpretar los triggers devueltos como "agregar al
     * carrito" en bots sin carrito (FAQ/TURNOS), donde son navegación/ficha/turno.
     */
    get botType() {
        return this._botType || 'CARRITO';
    }

    /**
     * Registra la razón por la que el traductor resolvió el mensaje SIN consultar
     * a Jev, para mostrarla en la línea [Jev][skip] de observabilidad.
     */
    _setJevRazon(jid, razon) {
        if (!this._jevSkipRazon) this._jevSkipRazon = {};
        this._jevSkipRazon[jid] = razon;
    }

    /**
     * Lista normalizada de contactos de derivación configurados en el dashboard.
     * Cada contacto: { id, nombre, telefono, areas }. Migra automáticamente el
     * formato legacy (vendedor.nombre/telefono sin lista) a un único contacto
     * para que ningún bot existente cambie de comportamiento.
     */
    _listarContactosVendedor(ai) {
        const v = (ai && ai.vendedor) || {};
        const msj = (v.mensaje && String(v.mensaje).trim()) || '';
        let contactos = Array.isArray(v.contactos) ? v.contactos : [];
        if (contactos.length === 0 && v.telefono && String(v.telefono).trim()) {
            const nombre = (v.nombre && String(v.nombre).trim()) || 'asesor';
            contactos = [{ id: 'contacto-1', nombre, telefono: String(v.telefono).trim(), areas: '', palabrasClave: '' }];
        }
        const lista = contactos
            .filter(c => c && c.telefono && String(c.telefono).trim())
            .map((c, idx) => ({
                id: (c && c.id) ? String(c.id) : `contacto-${idx + 1}`,
                nombre: (c && c.nombre && String(c.nombre).trim()) ? String(c.nombre).trim() : `contacto-${idx + 1}`,
                telefono: String(c.telefono).trim(),
                areas: (c && c.areas) ? String(c.areas) : '',
                palabrasClave: (c && c.palabrasClave) ? String(c.palabrasClave) : ''
            }));
        return { msj, contactos: lista };
    }

    /**
     * Teléfono del primer contacto de derivación configurado (o '' si no hay).
     * Gate booleano idéntico al anterior (vendedor.telefono).
     */
    _telefonoVendedor(ai) {
        const { contactos } = this._listarContactosVendedor(ai);
        return (contactos[0] && contactos[0].telefono) || '';
    }

    /**
     * ¿El mensaje del cliente es un pedido EXPLÍCITO de hablar con un humano
     * (asesor/vendedor/persona)? Devuelve la "frase de área" (lo dicho después
     * del marco) ya normalizada, o '' si no es una petición de asesor.
     * Evita falsos positivos como "que me asesores" (pedir consejo, no persona).
     */
    _solicitaAsesor(text) {
        const n = this._normalizarMatch(text);
        if (!n) return '';
        // 1) Marcos explícitos de contacto ("hablar con", "me pasás con",
        //    "atendé/atiendas", "necesito/quiero un asesor", "atención con").
        //    Los frames de transferencia ("pasame", "me pasás", "me comunicás")
        //    EXIGEN "con": "pasame con ventas" es pedir persona, pero "pasame
        //    fotos/precio/ubicación" es pedir información y NO debe derivar.
        const marco = n.match(/(?:hablar\s+con|pas(?:ame|a|e|as|[aá]s)\s+con|me\s*(?:pas|comunic|contact|deriv)[aáeé]?s?\s+con|atend|atiend[aáeé]?[sz]*|atencion\s+(?:con|de)|contactar\s+con|necesito\s+(?:hablar|que\s+me\s+atienda[nsz]*|un\s+asesor|una\s+asesora|una\s+visita|agendar\s+visita|coordinar\s+visita|programar\s+visita|solicitar\s+visita|pedir\s+visita|reservar\s+visita)|quiero\s+(?:hablar|que\s+me\s+atienda[nsz]*|un\s+asesor|una\s+asesora|una\s+visita|visitar|agendar\s+visita|coordinar\s+visita|programar\s+visita|solicitar\s+visita|pedir\s+visita|reservar\s+visita)|agendar\s+visita|coordinar\s+visita|programar\s+visita|solicitar\s+visita|pedir\s+visita|reservar\s+visita)\s*(.*)$/);
        let frase = '';
        if (marco) {
            frase = (marco[1] || '');
        } else {
            // 2) "asesor [de] <área>" o "un asesor <área>". \b tras el sustantivo
            //    excluye las conjugaciones del verbo "asesorar" ("asesores",
            //    "asesoraba", "asesorar") y los plurales de persona.
            const asesor = n.match(/(?:el\s+|la\s+|un\s+|una\s+|los\s+|las\s+)?(?:asesor|asesora)\b(?:\s+(?:de|para|por|en))?\s*$/);
            const asesorArea = n.match(/(?:el\s+|la\s+|un\s+|una\s+|los\s+|las\s+)?(?:asesor|asesora)\b(?:\s+(?:de|para|por|en))\s+(.+)$/)
                || n.match(/(?:el\s+|la\s+|un\s+|una\s+|los\s+|las\s+)?(?:asesor|asesora)\b\s+(.+)$/);
            if (asesor && !asesorArea) return '';
            if (!asesorArea) return '';
            frase = asesorArea[1];
        }
        const limpia = frase
            .replace(/\b(?:me|te|le|les|nos|lo|un|una|unos|unas|el|la|los|las|al|del|de|para|por|en|a|con)\b/g, ' ')
            .replace(/\b(?:por\s+favor|please|gracias|dale|ok|sipi?|claro|bueno|genial)\b/g, ' ')
            .replace(/[?!.,;:()]+/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
        return limpia ? limpia : ((marco || frase) ? 'asesor' : '');
    }

    /**
     * Devuelve la lista de áreas/palabras clave de los contactos (para mostrar
     * en el mensaje "No tengo esa opción"). Devuelve [] si no hay contactos.
     */
    _listaAreasDisponibles(contactos) {
        const areasSet = new Set();
        for (const c of contactos) {
            const cats = String(c.areas || '')
                .split(/[,;\n]+/)
                .map(s => s.trim())
                .filter(Boolean);
            for (const cat of cats) {
                areasSet.add(cat);
            }
            const keys = String(c.palabrasClave || '')
                .split(/[,;\n]+/)
                .map(s => s.trim())
                .filter(Boolean);
            for (const key of keys) {
                areasSet.add(key);
            }
        }
        return Array.from(areasSet);
    }

    /**
     * ¿La "frase de área" es genérica (sin categoría específica nombrada)?
     * "hablar con un asesor" -> genérica. "asesor de venta mayorista" -> no.
     */
    _esAreaGenerica(frase) {
        const n = this._normalizarMatch(frase || '');
        if (!n || n === 'asesor') return true;
        const generic = ['asesor', 'asesora', 'vendedor', 'vendedora', 'persona', 'alguien', 'humano', 'alguno', 'alguien que me atienda', 'con alguien'];
        return generic.some(g => n === g);
    }

    /**
     * Elige el contacto de derivación cuya CATEGORÍA (area) o PALABRAS CLAVE
     * coinciden con el texto del cliente. Puntúa por cuántas de sus áreas/palabras
     * clave aparecen en el texto normalizado: gana el de mayor puntaje
     * (empate -> primero). Devuelve el contacto elegido o null si ninguno matchea.
     */
    _matchearCategoria(texto, contactos) {
        if (!texto || !contactos || contactos.length === 0) return null;
        const n = this._normalizarMatch(texto);
        if (!n) return null;
        let mejor = null;
        let mejorScore = 0;
        for (const c of contactos) {
            let score = 0;
            const palabras = [];
            const cats = String(c.areas || '').split(/[,;\n]+/).map(s => s.trim()).filter(Boolean);
            for (const cat of cats) palabras.push(cat);
            const keys = String(c.palabrasClave || '').split(/[,;\n]+/).map(s => s.trim()).filter(Boolean);
            for (const key of keys) palabras.push(key);
            for (const p of palabras) {
                const np = this._normalizarMatch(p);
                if (!np) continue;
                // Match flexible: prefijo o contención (ej: "administrativo" matchea "administracion").
                // Evita falsos positivos muy cortos (< 3 chars).
                if (np.length >= 3 && (n.includes(np) || np.startsWith(n.slice(0, np.length)))) {
                    score += np.length;
                }
            }
            if (score > mejorScore) {
                mejorScore = score;
                mejor = c;
            }
        }
        return mejorScore > 0 ? mejor : null;
    }

    /**
     * ¿La intención clasificada es una CONSULTA (no una compra)? Las consultas
     * se responden conversacionalmente: no agregan al carrito ni derivan.
     */
    _esConsulta(intencion) {
        // CONSULTAR_MENU ya NO es una "consulta conversacional": es la intención
        // de NAVEGAR a una opción del menú. Solo horarios/charla general se
        // responden conversando.
        return intencion === 'CONSULTAR_HORARIOS' || intencion === 'CHARLA_GENERAL';
    }

    /**
     * ¿El mensaje consulta el PRECIO de algo ("¿cuánto cuesta?", "¿qué precio
     * tiene?", "¿a cómo está?", "precio", "costo", "tarifa")? Se usa para la
     * respuesta especial cuando la ficha consultada no tiene precio definido.
     */
    _esConsultaPrecio(text) {
        const t = this._normalizarMatch(text);
        if (!t) return false;
        if (/\bcuant(a|o|os)\b/.test(t) &&
            /\b(cuesta|cuestan|sale|salen|vale|valen|cobran|cobras|costo|costa|estara|estan|estarian|esta|este|anda|andan|es|son|piden|pide)\b/.test(t)) return true;
        return /\b(?:precio|precios|costo|costos|cotizacion|cotizas|tarifa|tarifas|importe|valor|valores|cual\s+es\s+el\s+(?:precio|costo|valor|importe)|cual\s+es\s+su\s+(?:precio|costo|valor)|que\s+valor|cuanto\s+tenes|a\s+cuanto|a\s+como|en\s+cuanto)\b/.test(t);
    }

    /**
     * ¿El cliente ACEPTA la oferta de hablar con un asesor
     * ("sí", "dale", "me interesa", "sí, por favor")?
     * Primero los heurísticos deterministas (rápidos, sin costo); si no son
     * concluyentes, Jev decide con un noul (probabilidad calibrada de sí), y
     * solo se acepta si supera el umbral seguro (>= 0.85). Ante cualquier
     * error de Jev se mantiene el comportamiento tradicional (rechazo).
     */
    async _aceptaOfertaAsesor(text) {
        const t = this._normalizarMatch(text);
        if (!t) return false;
        if (/\b(?:no|nop|nope|mejor\s+no|para\s+nada)\b/.test(t)) return false;
        if (this._esAfirmacion(text)) return true;
        if (/\b(?:me\s+interesa|me\s+gusta|si\s+(?:me|quiero|por\s+favor|dale)|pasame|pasame\s+con\s+(?:el|una)|hablar\s+con\s+(?:el|un|una|la)\s+(?:asesor|asesora|persona))\b/.test(t)) return true;
        // Heurísticos no concluyentes: Jev evalúa (noul) si el cliente acepta.
        try {
            const respuesta = await jevService.consultarJev({
                oferta: 'El asistente del negocio recién preguntó al cliente: "Te interesa que te pase con un asesor?"',
                respuesta_cliente: text
            }, {
                acepta: { type: 'noul', instructions: '¿El cliente ACEPTA hablar ahora con un asesor humano (sí/confirmación clara), en lugar de rechazarlo o desviar la conversación?' }
            });
            const noul = jevService.obtenerNoul(respuesta, 'acepta');
            if (typeof noul !== 'number') return false;
            const acepta = noul >= jevService.UMBRAL_CONFIANZA;
            console.log(`[Jev] ${this.idCliente}: oferta asesor -> noul ${noul.toFixed(2)} (${acepta ? 'acepta' : 'rechaza'}) | msg: "${text}"`);
            return acepta;
        } catch (err) {
            console.error(`[Jev] Error _aceptaOfertaAsesor ${this.idCliente}:`, err.message);
            return false;
        }
    }

    /**
     * ¿El cliente RECHAZA la oferta de hablar con un asesor
     * ("no", "no, gracias", "no me interesa", "mejor no")?
     */
    _rechazaOfertaAsesor(text) {
        const t = this._normalizarMatch(text);
        if (!t) return false;
        return /\b(?:no|nop|nope|mejor\s+no|para\s+nada|cancelar|descartar|no\s+gracias|gracias\s+pero\s+no|no\s+me\s+interesa|no\s+lo\s+necesito|no\s+quiero)\b/.test(t);
    }

    /**
     * ¿El mensaje es SOLO una negación a la oferta de asesor (sin otra
     * intención a cuestas)? Se distingue de "no, [otra cosa]" ("no, cuanto
     * cuesta la de las heras") para no cortar la respuesta cuando el cliente
     * rechaza PERO además pregunta algo. Es "no" puro / "no, gracias" /
     * "no me interesa" / "mejor no", sin nada más después.
     */
    _esNegacionPura(text) {
        const t = this._normalizarMatch(text).replace(/[?!.]+$/g, '').replace(/,+/g, ' ').replace(/\s+/g, ' ').trim();
        if (!t) return false;
        return /^(?:no|nop|nope|no\s+gracias|gracias\s+pero\s+no|no\s+me\s+interesa|no\s+lo\s+necesito|no\s+quiero|mejor\s+no|para\s+nada|cancelar|descartar)(?:[.!,-]*)$/.test(t);
    }

    /**
     * Manejo determinístico de la consulta de PRECIO de una ficha SIN precio
     * definido (bot FAQ, ej. inmobiliaria). Devuelve { handled, result }:
     *   - handled true  -> ya respondió (y quizá ofreció pasar con un asesor);
     *                      result es lo que handleMessage debe devolver.
     *   - handled false -> el flujo normal de la conversación continúa.
     */
    async _manejarPrecioSinDefinir(sock, jid, pushName, text, options, matchSimple, celularVendedor) {
        if (!this._esFAQ() || !this._esConsultaPrecio(text)) {
            return { handled: false };
        }

        // 1) Ficha consultada: por match directo del nivel o por el último tema.
        let trig = '';
        let title = '';
        if (matchSimple) {
            const opt = (options || []).find(o => String(o.trigger).toLowerCase() === String(matchSimple).toLowerCase());
            if (opt && !opt.seccion) {
                trig = String(matchSimple);
                title = opt.title || '';
            } else if (opt) {
                // La opción es una SECCIÓN (no una ficha con precio): el flujo
                // normal muestra su submenú; no caemos al fallback de interés.
                return { handled: false };
            }
        }
        if (!trig) {
            const sesionInteres = this.stateService.getChatSession(jid) || {};
            const ultimo = sesionInteres.interes;
            if (ultimo && ultimo.trigger) {
                const nodeId = this.stateService.getUserState(jid) || 'root';
                const nodoActual = await this._getNodeById(nodeId).catch(() => null);
                const esFichaActual = !!(nodoActual && String(nodoActual.trigger) === String(ultimo.trigger));
                const esOpcion = (options || []).some(o => String(o.trigger).toLowerCase() === String(ultimo.trigger).toLowerCase());
                if (esOpcion || esFichaActual) {
                    trig = String(ultimo.trigger);
                    title = ultimo.title || '';
                }
            }
        }
        if (!trig) return { handled: false };

        // 2) ¿La ficha tiene precio definido? Si sí, respondemos DIRECTAMENTE
        //    con el precio (en vez de dejar que el LLM lo redacte en otra voz/
        //    formalidad) y guardamos la posición (interes) para que los
        //    seguimientos deícticos ("y esa?", "¿y las fotos?") sigan anclados.
        let conPrecio = false;
        let precioNivel = '';
        let tituloNivel = title;
        const optNivel = (options || []).find(o => String(o.trigger).toLowerCase() === trig.toLowerCase());
        if (optNivel) {
            conPrecio = !!(optNivel.price) || !!optNivel.seccion;
            if (optNivel.price) {
                precioNivel = optNivel.price;
                tituloNivel = optNivel.title || title || trig;
            }
        } else {
            const nodo = await this._getNodeById(this.stateService.getUserState(jid) || 'root').catch(() => null);
            if (nodo && String(nodo.trigger).toLowerCase() === trig.toLowerCase()) {
                conPrecio = !!(nodo.price) || !!nodo.seccion;
                if (nodo.price) {
                    precioNivel = nodo.price;
                    tituloNivel = nodo.title || title || trig;
                }
            }
        }
        if (conPrecio) {
            if (precioNivel) {
                this._setInteres(jid, trig, tituloNivel);
                this.stateService.clearTranslationFails(jid);
                await this._sendFriendly(sock, jid, `El *${tituloNivel}* cuesta *$${precioNivel}*.\n\n¿Querés que te muestre las fotos?`);
                console.log(`[AI] Bot ${this.idCliente}: precio definido "${trig}" -> respuesta directa ($${precioNivel})`);
                return { handled: true, result: { derivado: true } };
            }
            // Sección (sin precio propio): el flujo normal despliega su submenú.
            return { handled: false };
        }

        // 3) Respuesta especial + oferta de asesor (si hay vendedor configurado).
        this._setInteres(jid, trig, title);
        const precioRespondido = 'No tengo en mi base de datos esa información.';
        if (celularVendedor) {
            const sesion = this.stateService.getChatSession(jid) || { history: [], nodeId: 'root' };
            this.stateService.setChatSession(jid, { ...sesion, ofreciendoAsesor: { trigger: trig, title } });
            await this._sendFriendly(sock, jid, precioRespondido + '\n\nTe interesa que te pase con un asesor?');
            console.log(`[AI] Bot ${this.idCliente}: precio sin definir en "${trig}" -> sin precio + oferta de asesor`);
        } else {
            await this._sendFriendly(sock, jid, precioRespondido);
            console.log(`[AI] Bot ${this.idCliente}: precio sin definir en "${trig}" -> sin precio (sin asesor configurado)`);
        }
        return { handled: true, result: { derivado: true } };
    }

    /**
     * Resuelve una referencia POSICIONAL a un ítem de la lista desplegada
     * ("el primero", "el 1ro", "la 2", "el segundo", "el tercero de la lista")
     * contra las opciones reales del nivel actual. Devuelve el índice (0-based)
     * o -1 para "el último", o null si no se detectó una posición válida.
     */
    _resolverPosicionLista(text, options) {
        if (!Array.isArray(options) || options.length === 0) return null;
        const t = this._normalizarMatch(text);
        if (!t) return null;

        const ORDINALES = {
            primero: 0, primera: 0,
            segundo: 1, segunda: 1,
            tercero: 2, tercera: 2,
            cuarto: 3, cuarta: 3,
            quinto: 4, quinta: 4,
            sexto: 5, sexta: 5,
            septimo: 6, septima: 6,
            octavo: 7, octava: 7,
            noveno: 8, novena: 8,
            decimo: 9, decima: 9
        };

        // 1. Ordinal textual con artículo: "el primero", "la segunda".
        //    El artículo es obligatorio para no matchear "primero" en uso adverbial
        //    ("primero quiero ver el listado").
        const mOrd = t.match(/\b(?:el|la|los|las|del)\s+(primero|primera|segundo|segunda|tercero|tercera|cuarto|cuarta|quinto|quinta|sexto|sexta|septimo|septima|octavo|octava|noveno|novena|decimo|decima|ultimo|ultima)\b/);
        if (mOrd) {
            const w = mOrd[1];
            return (w === 'ultimo' || w === 'ultima') ? -1 : ORDINALES[w];
        }
        // 2. Ordinal al final como sustantivo con contexto "de la lista"/"de las
        //    opciones" ("el primero de la lista").
        const mOrd2 = t.match(/\b(primero|primera|segundo|segunda|tercero|tercera|cuarto|cuarta|quinto|quinta|sexto|sexta|septimo|septima|octavo|octava|noveno|novena|decimo|decima|ultimo|ultima)\s+(?:de\s+la\s+)?(?:lista|listado|opciones)\b/);
        if (mOrd2) {
            const w = mOrd2[1];
            return (w === 'ultimo' || w === 'ultima') ? -1 : ORDINALES[w];
        }

        // 3. Número de la lista: "el 1", "la 2", "del 4to", "item 3", "1ro", "1°", "1er".
        const mNum = t.match(/\b(?:el|la|los|las|del|item|items|opcion|opciones|numero|nro|num)\s*(\d{1,2})(?:to|ta|ro|er|do|da|°|º)?\b|(\d{1,2})(?:to|ta|ro|er|do|da|°|º)\b/);
        if (mNum) {
            const n = parseInt(mNum[1] || mNum[2], 10);
            if (!isNaN(n)) return n - 1;
        }

        return null;
    }

    /**
     * Consulta de PRECIO sobre un ítem por POSICIÓN en la lista desplegada
     * ("¿cuánto cuesta el primero?", "a cómo el 2"). Devuelve
     * { trigger, title, precio } del ítem resuelto o null. No pasa por el LLM.
     */
    _resolverPrecioPorPosicion(text, options) {
        if (!this._esConsultaPrecio(text)) return null;
        const idx = this._resolverPosicionLista(text, options);
        if (idx === null) return null;
        let indice = idx === -1 ? options.length - 1 : idx;
        if (indice < 0 || indice >= options.length) return null;
        const item = options[indice];
        if (!item || item.seccion) return null;
        const precio = (item.price != null && String(item.price).trim() !== '')
            ? parseFloat(String(item.price).replace(',', '.')) || null
            : null;
        return { trigger: item.trigger, title: item.title, precio };
    }

    /**
     * Fast-path de clasificación con Jev (System One).
     *
     * Jev evalúa el estado del mensaje y devuelve DOS decisiones tipadas
     * (choice) en un solo POST rápido y barato:
     *   1. `intencion`: qué quiere lograr el cliente.
     *   2. `categoria_seleccionada`: a qué categoría/sección del menú se refiere
     *      (candidatos extraídos dinámicamente del menú actual + hermanos +
     *      menú principal + default MENU_PRINCIPAL).
     *
     * Si la confianza supera el umbral seguro (JEV_UMBRAL, default 0.85) se
     * usa el destino de Jev (incluso en otro nivel) y se navega directo a la
     * sección elegida; si la consulta es amplia/general (MENU_PRINCIPAL), si la
     * confianza es baja o si el ítem no se resuelve contra el catálogo real,
     * devolvemos null y quien llama muestra el menú determinista con opciones
     * numeradas. OpenAI NO participa en la clasificación.
     *
     * @returns {Promise<Object|null>} { intencion, items, respuesta_conversacional }
     *   o null para hacer fallback al menú.
     */
    async _clasificarConJev(jid, text, onTokens) {
        if (this._jevConsultadoPorJid) this._jevConsultadoPorJid[jid] = true;
        try {
            const nodeId = this.stateService.getUserState(jid) || 'root';
            const options = await this._opcionesNivel(jid, nodeId).catch(() => []);

            const esFAQ = this._esFAQ();
            // Bots sin carrito (FAQ y TURNOS) solo NAVEGAN entre las opciones
            // del menú: la única pregunta de Jev es a qué nodo ir.
            const soloNavega = esFAQ || this._botType === 'TURNOS';
            const intencionesPermitidas = soloNavega
                ? ['CONSULTAR_MENU']
                : ['AGREGAR_AL_CARRITO', 'QUITAR_DEL_CARRITO', 'CONSULTAR_MENU',
                   'CONSULTAR_HORARIOS', 'VER_CARRITO', 'FINALIZAR_PEDIDO',
                   'CHARLA_GENERAL'];

            const DESCRIPCIONES = {
                AGREGAR_AL_CARRITO: 'el cliente pide comprar, agregar, pedir o encargar un producto del nivel actual',
                QUITAR_DEL_CARRITO: 'el cliente pide quitar, sacar o borrar algo de su pedido actual',
                CONSULTAR_MENU: 'el cliente quiere ver el menú, entrar a una sección, ver una ficha/propiedad, o consultar las opciones disponibles',
                CONSULTAR_HORARIOS: 'el cliente pregunta por horarios de atención, días que abren o cierran, o turnos disponibles',
                VER_CARRITO: 'el cliente quiere ver su pedido actual / lo que ya agregó',
                FINALIZAR_PEDIDO: 'el cliente quiere pagar, finalizar, confirmar o cerrar su pedido',
                CHARLA_GENERAL: 'el cliente saluda, agradece o conversa en general sin pedir algo del menú'
            };
            const criteria = {};
            for (const i of intencionesPermitidas) {
                criteria[i] = DESCRIPCIONES[i] || null;
            }

            const nodoActual = await this._getNodeById(nodeId).catch(() => null);
            const modo = this._esFAQ()
                ? 'BOT DE CONSULTAS (FAQ): no vende ni tiene carrito; solo informa fichas del catálogo y navega el menú.'
                : (this._botType === 'TURNOS'
                    ? 'BOT DE TURNOS: gestiona reservas de turnos; no tiene carrito de compras.'
                    : 'BOT DE VENTAS: vende productos del menú y tiene carrito.');
            const nivel = nodoActual && nodoActual.title
                ? `PANTALLA ACTUAL: "${nodoActual.title}"`
                : 'PANTALLA ACTUAL: menú raíz';

            // Candidatos de navegación: nivel actual + menú principal + hermanos.
            const candidatos = await this._candidatosNavegacion(jid, nodeId, options, text);
            const padreHermanos = (nodoActual && nodoActual.parentId && nodoActual.parentId !== 'root')
                ? ((await this._getNodeById(nodoActual.parentId).catch(() => null)) || {}).title || ''
                : '';
            const listaCandidatos = candidatos.length
                ? 'OPCIONES DE NAVEGACIÓN (clave→título):\n' + candidatos.map((c) => `  ${c.key}→${this._describirCandidato(c, padreHermanos)}`).join('\n')
                : 'OPCIONES DE NAVEGACIÓN: (ninguna)';
            const order = this.stateService.getUserOrder(jid) || [];
            const pedidoTxt = order.length
                ? 'PEDIDO EN CURSO: ' + order.map(it => `${it.quantity}x${it.text}`).join(', ')
                : 'PEDIDO EN CURSO: (vacío)';

            const state = [
                `PEDIDO DEL CLIENTE: "${text}"`,
                modo,
                nivel,
                listaCandidatos,
                pedidoTxt
            ].join('\n');

            const nodoCriteria = {};
            for (const c of candidatos) {
                nodoCriteria[c.key] = this._describirCandidato(c, padreHermanos);
            }
            // Categoría por defecto: cuando la consulta NO apunta a ninguna
            // categoría/sección concreta (consulta amplia/general), Jev elige
            // MENU_PRINCIPAL con alta confianza y el bot responde el menú general.
            nodoCriteria.MENU_PRINCIPAL = 'La consulta es amplia o general y no apunta a ninguna categoría/sección concreta del menú';

            console.log(`[Jev][ctx] ${this.idCliente}: estado enviado a Jev =>\n${state}\n[Jev][ctx] intención: ${soloNavega ? '(no aplica: el bot solo navega entre opciones del menú)' : Object.keys(criteria).join(' | ')}\n[Jev][ctx] criterios navegación (${Object.keys(nodoCriteria).length}): ${Object.keys(nodoCriteria).join(' | ')}`)

            const preguntasJev = {
                categoria_seleccionada: {
                    type: 'choice',
                    instructions: 'Determiná a cuál de las categorías/secciones/fichas del menú (claves de OPCIONES DE NAVEGACIÓN) se refiere el usuario basándote en SU CONSULTA. Incluso las consultas amplias o de búsqueda (ej. "qué opciones tenés para X?", "tenés algo de Y?") apuntan a UNA opción concreta si una encaja por tema; elegí EXACTAMENTE la clave de esa opción (puede ser de otro nivel o de una rama profunda: el bot navega allí). Si NINGUNA opción trata el tema pedido, NO fuerces una: elegí MENU_PRINCIPAL. Si el cliente pide ver, consultar o preguntar por SUS turnos o reservas YA hechos (ej. "mis turnos", "cuáles son mis turnos", "qué turnos tengo", "ver mis reservas"), elegí SIEMPRE la opción titulada "Mis turnos" (NO "Reservar turno" ni "Horarios").',
                    criteria: nodoCriteria
                }
            };
            // Los bots sin carrito (FAQ y TURNOS) solo NAVEGAN entre las opciones del
            // menú: no hay pregunta de intención (horarios/charla general quedan
            // fuera); la navegación la resuelve la categoría. El bot de ventas
            // sí clasifica la intención (comprar, quitar, pagar...).
            if (!soloNavega) {
                preguntasJev.intencion = {
                    type: 'choice',
                    instructions: '¿Cuál es la intención principal del mensaje del cliente? Elegí UNA. Si el pedido no encaja en ninguna opción del nivel actual sino en otra sección del menú, usá la intención que mejor describa lo que el cliente quiere lograr (ajustar por contexto).',
                    criteria
                };
            }

            const respuesta = await jevService.consultarJev(state, preguntasJev);

            const usage = jevService.tokensUsados(respuesta);
            if (usage > 0 && typeof onTokens === 'function') {
                onTokens(usage);
            }

            const _ic = jevService.obtenerChoice(respuesta, 'intencion');
            const _cc = jevService.obtenerChoice(respuesta, 'categoria_seleccionada');
            console.log(`[Jev][resp] ${this.idCliente}: intención=${_ic ? `${_ic.choice} (${Number(_ic.confidence || 0).toFixed(2)})` : '—'} | categoría=${_cc ? `${_cc.choice} (${Number(_cc.confidence || 0).toFixed(2)})` : '—'}`)
            console.log(`[Jev][resp] probabilidades intención: ${_ic && _ic.probabilities ? JSON.stringify(_ic.probabilities) : '—'}`)
            console.log(`[Jev][resp] probabilidades categoría: ${_cc && _cc.probabilities ? JSON.stringify(_cc.probabilities) : '—'}`)

            const choice = jevService.obtenerChoice(respuesta, 'intencion');
            let intencion;
            let confianzaIntencion;
            if (soloNavega) {
                // Sin carrito (FAQ/TURNOS): la única decisión es a qué opción del
                // menú navegar. No hay pregunta de intención; la navegación la
                // resuelve la categoría.
                intencion = 'CONSULTAR_MENU';
                confianzaIntencion = 1;
            } else {
                if (!choice || typeof choice.confidence !== 'number') {
                    console.log(`[Jev] ${this.idCliente}: sin intención resuelta (sin respuesta) -> menú | msg: "${text}"`);
                    return null;
                }
                intencion = choice.choice;
                if (!intencionesPermitidas.includes(intencion)) return null;

                // Para NAVEGAR el menú exigimos el umbral laxo
                // (UMBRAL_NAVEGACION): el cliente quiere que el bot siempre entre
                // y baje a la rama que mejor encaja. Para ACCIONES
                // (agregar/quitar/pagar) mantenemos el umbral estricto.
                const umbralIntencion = (intencion === 'CONSULTAR_MENU')
                    ? jevService.UMBRAL_NAVEGACION
                    : jevService.UMBRAL_CONFIANZA;
                if (choice.confidence < umbralIntencion) {
                    console.log(`[Jev] ${this.idCliente}: confianza intención ${choice.confidence.toFixed(2)} < ${umbralIntencion} -> menú | msg: "${text}"`);
                    return null;
                }
                confianzaIntencion = choice.confidence;
            }

            // Resolución del ítem/destino: Jev decide a qué categoría/sección ir
            // (segunda decisión `categoria_seleccionada`, en el MISMO POST). Si
            // la CONFIANZA DE NAVEGACIÓN (laxa) se alcanza y la clave es un
            // candidato real, ese es el ítem destino (puede estar en otro nivel:
            // 'raiz'/'hermano'): el bot entra y baja a esa rama. Si elige
            // MENU_PRINCIPAL (consulta amplia/general), el menú general responde.
            // Si no alcanza ni el umbral laxo, cae al match determinista.
            const items = [];
            if (intencion === 'CONSULTAR_MENU' || intencion === 'AGREGAR_AL_CARRITO' || intencion === 'QUITAR_DEL_CARRITO') {
                const catChoice = jevService.obtenerChoice(respuesta, 'categoria_seleccionada');
                const umbralCategoria = (intencion === 'CONSULTAR_MENU')
                    ? jevService.UMBRAL_NAVEGACION
                    : jevService.UMBRAL_CONFIANZA;
                const catConfiable = catChoice && typeof catChoice.confidence === 'number' &&
                    catChoice.confidence >= umbralCategoria && catChoice.choice &&
                    nodoCriteria[catChoice.choice];
                if (catConfiable && catChoice.choice === 'MENU_PRINCIPAL') {
                    console.log(`[Jev] ${this.idCliente}: destino MENU_PRINCIPAL (confianza ${catChoice.confidence.toFixed(2)}) -> menú general | msg: "${text}"`);
                    return null;
                }
                if (catConfiable) {
                    let cand = candidatos.find((c) => c.key === catChoice.choice);
                    if (cand) {
                        // El destino puede ser una sección con sub-opciones y el
                        // cliente estar buscando algo puntual DENTRO de ella. Si
                        // una sub-opción coincide con confianza de navegación,
                        // bajamos a esa en vez de detenernos en la sección.
                        if (intencion === 'CONSULTAR_MENU') {
                            cand = await this._descenderCandidato(jid, text, cand, onTokens);
                        }
                        const cantidad = (intencion === 'CONSULTAR_MENU') ? 1 : this._detectarCantidad(text);
                        items.push({ trigger: cand.trigger, scope: cand.scope, nodeId: cand.nodeId || '', cantidad });
                        console.log(`[Jev] ${this.idCliente}: destino "${cand.key}" (confianza categoría ${catChoice.confidence.toFixed(2)}) | msg: "${text}"`);
                    }
                }
                if (!items.length) {
                    const match = this._matchOption(text, options);
                    if (match) {
                        const cantidad = (intencion === 'CONSULTAR_MENU') ? 1 : this._detectarCantidad(text);
                        items.push({ trigger: match, scope: 'actual', cantidad });
                    } else if (intencion === 'AGREGAR_AL_CARRITO' || intencion === 'QUITAR_DEL_CARRITO') {
                        // Compra/quito SIN producto concreto identifiable: no resuelto.
                        console.log(`[Jev] ${this.idCliente}: intención ${intencion} sin ítem determinista -> menú | msg: "${text}"`);
                        return null;
                    }
                    // CONSULTAR_MENU sin match: items vacíos => el menú re-muestra opciones.
                }
            }

            console.log(`[Jev] ${this.idCliente}: intención "${intencion}" (confianza ${Number(confianzaIntencion).toFixed(2)}${items.length ? ', items: ' + items.map(i => `${i.cantidad}x${i.scope}:${i.trigger}`).join('+') : ''}) -> acción determinista | msg: "${text}"`);
            return { intencion, items, respuesta_conversacional: '' };
        } catch (err) {
            console.error(`[Jev] Error en _clasificarConJev ${this.idCliente}:`, err.message);
            return null;
        }
    }

    /**
     * Clasifica el mensaje con Jev (System One). Devuelve la clasificación
     * resuelta por confianza o null si Jev no tiene certeza / no está
     * disponible (sin TYPESAFE_API_KEY, timeout, error). Cuando devuelve null,
     * quien llama deriva SIEMPRE al menú determinista (opciones numeradas):
     * OpenAI ya no participa en la clasificación, solo reformula a lenguaje
     * natural la salida del menú (ver reformulate()).
     */
    async _clasificarConLaIA(user, ai, jid, text) {
        if (this.quotaBlocked) return null;
        try {
            return await this._clasificarConJev(jid, text, (t) => {
                aiUsageService.addTokens(this.idCliente, t || 0);
            });
        } catch (err) {
            console.error(`[Jev] Error en clasificación ${this.idCliente}:`, err.message);
            if (err && err.isQuotaExceeded) {
                this.quotaBlocked = true;
                console.warn(`[Jev] Bot ${this.idCliente}: bloqueado por cuota (menú directo)`);
            }
            return null;
        }
    }

    /**
     * Recuerda la última sección/producto sobre el que el cliente estuvo
     * consultando (trigger + título). Se usa para resolver pedidos deícticos
     * tipo "mostrame cuales tenes" navegando a esa sección del menú.
     */
    _setInteres(jid, trigger, title) {
        if (!trigger) return;
        try {
            const sesion = this.stateService.getChatSession(jid) || { history: [], nodeId: 'root' };
            const prev = sesion.interes || {};
            this.stateService.setChatSession(jid, {
                ...sesion,
                interes: { trigger, title: title || prev.title || '' }
            });
        } catch (err) {
            console.error(`[AI] Error guardando interes ${this.idCliente}:`, err.message);
        }
    }

    /**
     * ¿El mensaje es una afirmación simple ("si", "dale", "ok", "obvio",
     * "claro que si")? Se usa para aceptar la oferta que el asistente hizo
     * (por ejemplo "¿Le muestro las propiedades?") navegando al último tema.
     */
    _esAfirmacion(text) {
        const t = this._normalizarMatch(text);
        if (!t) return false;
        if (/\b(no|nop|nope|para nada|no gracias|cancelar|mejor no)\b/.test(t)) return false;
        if (/^(?:s[ií]|d[aá]le|ok+|obvio|segu[íi]|adelante|excelente|buen[oa]|perfecto|claro|[aá]ndale|de[ ]?una)\b/.test(t) && !/\b(precio|cuanto|horario|promo|descuento|cu[aá]nto|como|donde|cuando|pasar|pagar|alquiler\s+de|costo)\b/.test(t)) {
            // Frases de confirmación ofrecidas por un humano o asistente
            if (/^(?:s[ií]|d[aá]le|ok+|obvio|segu[íi]|adelante|claro|[aá]ndale|de[ ]?una|buen[oa]|perfecto|excelente)\b/.test(t)) return true;
            // "si quiero", "si me mostras", "si por favor"
            if (/^s[ií]\s+(?:quiero|quer[eé]s?|me\s+mostr|por\s+favor|dale|claro|segu[íi])/.test(t)) return true;
            // "dale mostrame", "dale, mostrame"
            if (/^(?:d[aá]le|claro|ok)\s+(?:mostr|dale|vamos)/.test(t)) return true;
        }
        return false;
    }

    /**
     * ¿El mensaje expresa interés deíctico sobre el último ítem visto ("me
     * interesa", "esa me gusta", "quiero esa", "estoy interesado") sin volver
     * a nombrarlo? Se resuelve con el último tema (interes) de la sesión.
     * Entendible como intención de compra cuando va acompañado de vendedor.
     */
    _esDeicticoInteres(text) {
        const t = String(text || '').toLowerCase().trim();
        if (!t) return false;
        // Consultas y preguntas no son un interés de compra deíctico.
        if (/\b(?:saber|ver|cu[aá]nto\b|cuesta|vale|precio|info|informaci[oó]n|pregunt|consult|detalle|dudas?|horario|direcci[oó]n|ubicaci[oó]n|m[aá]s\s+opciones)\b/.test(t)) return false;
        // Interés deíctico: no nombra el ítem, se refiere a "esa/esa opción/la".
        return /\b(?:me\s+interesa|me\s+gusta|me\s+gustar[ií]a|estoy\s+interesad[oa]|esta\s+me\s+(?:interesa|gusta)|esa\s+me\s+(?:interesa|gusta)|la\s+quiero|lo\s+quiero|quiero\s+esa|me\s+interesa\s+alquilar|quiero\s+alquilar\s+esa|mucho\s+me\s+interesa)\b/.test(t) ||
            /^me\s+interesa$/.test(t) ||
            /^me\s+gusta$/.test(t) ||
            /^(?:esa|esta)\s+(?:casa|propiedad|inmueble|departamento|opci[oó]n)\s*(?:me\s+)?(?:interesa|gusta)/.test(t) ||
            /^(?:esa|esta)\s+(?:me\s+)?(?:interesa|gusta)/.test(t);
    }

    /**
     * ¿El mensaje expresa interés EXPLÍCITO por un ítem/ficha concreto
     * ("me interesa la de las heras", "me gusta la casa", "estoy interesado
     * en el depto")? A diferencia de _esDeicticoInteres (que se refiere al
     * último ítem sin nombrarlo), acá se nombra o se aclara la opción, y no
     * es una mera pregunta de información.
     */
    _esInteresExplicito(text) {
        const t = this._normalizarMatch(text);
        if (!t) return false;
        // Preguntas/consultas de información NO son un interés de compra/contacto.
        if (/\b(?:cuanto\s+cuesta|cuanto\s+vale|precio|horario|dudas?|consult|pregunt|mas\s+opciones|m[áa]s\s+informaci[oó]n|saber\s+mas|detalle|informaci[oó]n)\b/.test(t)) return false;
        return /\b(?:me\s+interesa|me\s+interesan|me\s+gusta|me\s+gustar[ií]a|estoy\s+interesad[oa]|quisiera|me\s+encant|me\s+quedo\s+con|la\s+quiero|lo\s+quiero|quiero\s+esa|quiero\s+ese)\b/.test(t) ||
            /^me\s+interesa/.test(t) ||
            /^me\s+gusta/.test(t);
    }

    /**
     * Resuelve la navegación deíctica: si el cliente pidió "ver el listado"
     * ("mostrame cuales tenes") o confirmó la oferta ("si, mostralo") y hay un
     * último tema (interes) que sea una opción navegable del nivel actual,
     * devuelve el trigger para que el menú muestre esa sección. Si no, null.
     */
    /**
     * ¿El mensaje pregunta por HORARIOS/atención del local ("atienden mañana?",
     * "a qué hora abren", "qué horario manejás", "hasta cuándo atienden")?
     * Se usa para mensajes COMPUESTOS donde además se menciona una sección.
     */
    _esPeticionHorarios(text) {
        const t = this._normalizarMatch(text);
        return /\b(horario|horarios|atende|atiende|atienden|abren|cierran|a que hora|que hora|cuando abren|qu[eé] horario|manej(?:a|as|an)|turno de atencion|cuanto abren)\b/.test(t);
    }

    /**
     * Detecta la sección/ficha del nivel actual mencionada en el mensaje.
     * Fallback por raíz compartida (verbo↔sustantivo: "alquilar"→"Alquileres",
     * "comprar"→"Ventas", "pedir"→"Pedidos").
     */
    _seccionMencionada(text, options) {
        if (!options || !options.length) return null;
        const directo = this._matchOption(text, options);
        if (directo) return directo;
        const texto = this._normalizarMatch(text);
        const palabras = texto.split(/\s+/).filter(w => w.length >= 5);
        if (!palabras.length) return null;
        for (const opt of options) {
            const titulo = this._normalizarMatch(opt.title);
            const tituloPalabras = titulo.split(/\s+/).filter(w => w.length >= 5);
            for (const w of palabras) {
                for (const tw of tituloPalabras) {
                    let p = 0;
                    const m = Math.min(w.length, tw.length);
                    while (p < m && w[p] === tw[p]) p++;
                    // Raíz compartida fuerte: ≥6 letras y ≥60% del término más
                    // largo. Evita falsos positivos ("propiedad"↔"propio",
                    // "viviendas"↔"ventas") aunque capta verbo↔sustantivo
                    // ("alquilar"↔"alquileres").
                    if (p >= 6 && p >= 0.6 * Math.max(w.length, tw.length)) return opt.trigger;
                }
            }
        }
        return null;
    }

    /**
     * ¿El mensaje pide VER el listado/opciones de lo que estaba hablando
     * ("mostrame cuales tenes", "dame las opciones", "que hay")? Deíctico:
     * se resuelve con el último tema (interes) del cliente.
     */
    _esPeticionListado(text) {
        const t = this._normalizarMatch(text);
        if (/\b(horari|precios?|precio|cuanto cuesta|promo|descuento|com[oó] (es|funciona)|entrega|direcci[oó]n|pago|pagas)\b/.test(t)) return false;
        return /\b(mostr(ar|ame)?|muestrame|cuales\s+(son|tenes|tienen|hay|manej|sonantas)|que\s+(opciones|ten[eé]s|hay)\b|ver\s+(las?|mis)?\s*opciones|opciones\b|listad[oa]\b|dejame\s*ver|cupon|de que [a-z]+ (tenes|tienen))\b/.test(t) ||
            /^(?:s[ií],?)?\s*mostr[ae]/i.test(t) ||
            /^(?:no\s*,\s*)?(?:ya\s*)?(?:lo\s*)?mostrame/i.test(t) ||
            /^(?:no\s*,\s*)?(?:ya\s*)?quier(?:o|és|es)\s*ver/i.test(t) ||
            /^(?:no\s*,\s*)?(?:ya\s*)?cuales/i.test(t);
    }

    /**
     * Detección de navegación por frases (no solo exacta): "hola, quiero
     * hacer un pedido", "mostrame el menú", "necesito volver atrás".
     * Devuelve el trigger (0/v/p/vaciar) o null.
     */
    _navPorFrase(navKey) {
        if (!navKey) return null;
        if (navKey.includes('opciones') || navKey.includes('catalogo') ||
            navKey.includes('carta') || navKey.includes('que hay') || navKey.includes('que tienen')) return 'PEDIDO';
        if (navKey.includes('menu') || navKey.includes('inicio') || navKey.includes('listado')) return '0';
        if (navKey.includes('pedir') || navKey.includes('pedido') || navKey.includes('encargar') ||
            navKey.includes('comprar') || navKey.includes('hacer un pedido')) return 'PEDIDO';
        if (navKey.includes('volver') || navKey.includes('atras') ||
            navKey.includes('regresar')) return 'v';
        if (navKey.includes('pagar') || navKey.includes('pago') ||
            navKey.includes('abonar') || navKey.includes('finalizar')) return 'p';
        // Fin de pedido: "nada mas", "eso seria todo", "solo eso", "listo" ->
        // detener de agregar y pasar al pago/checkout.
        if (navKey === 'nada mas' || navKey === 'nada más' || navKey === 'nada' ||
            navKey.includes('nada mas') || navKey.includes('nada más') ||
            navKey.includes('eso seria todo') || navKey.includes('eso es todo') ||
            navKey.includes('solo eso') || navKey === 'listo' || navKey === 'nada mas quiero' ||
            navKey === 'ya esta' || navKey === 'ya está' || navKey === 'ya esta todo' ||
            navKey.includes('ya estaria') || navKey.includes('ya está todo') ||
            navKey.includes('termine') || navKey.includes('terminé') ||
            navKey.includes('es todo') || navKey.includes('quiero pagar') ||
            navKey.includes('dale pago') || navKey.includes('dale, pago') ||
            navKey.includes('no quiero nada mas') || navKey.includes('no quiero nada más') ||
            navKey.includes('pasar a pagar') || navKey.includes('pagar ya')) return 'p';
        if (navKey.includes('vaciar') || navKey.includes('limpiar') ||
            navKey.includes('borrar pedido')) return 'vaciar';
        return null;
    }

    /**
     * Matching simple contra opciones del nivel actual del menú.
     * Devuelve el trigger (string) de la coincidencia o null.
     */
    _matchOption(input, options) {
        const texto = this._normalizarMatch(input);
        if (!texto) return null;

        // 1. Coincidencia exacta del título
        for (const opt of options) {
            const titulo = this._normalizarMatch(opt.title);
            if (titulo === texto) return opt.trigger;
        }
        // 2. Coincidencia por inclusión completa del input en un título
        for (const opt of options) {
            const titulo = this._normalizarMatch(opt.title);
            if (texto.length >= 3 && titulo.includes(texto)) return opt.trigger;
        }
        // 3. Coincidencia por inclusión del título en el input
        for (const opt of options) {
            const titulo = this._normalizarMatch(opt.title);
            if (titulo.length >= 3 && texto.includes(titulo)) return opt.trigger;
        }
        // 4. Coincidencia por palabras clave (término más largo del input que esté en el título)
        const palabras = texto.split(/\s+/).filter(w => w.length >= 3 && !STOPWORDS.has(w));
        for (const opt of options) {
            const titulo = this._normalizarMatch(opt.title);
            for (const w of palabras) {
                if (titulo.includes(w)) return opt.trigger;
            }
        }
        // 5. Coincidencia tolerando plural/raíz ("cocas" → "coca", "muzzarellas" → "muzzarella")
        for (const opt of options) {
            const titulo = this._normalizarMatch(opt.title);
            const raices = new Set();
            for (const w of palabras) {
                raices.add(w);
                if (w.length > 4 && w.endsWith('s')) raices.add(w.slice(0, -1));
            }
            for (const r of raices) {
                if (titulo.includes(r)) return opt.trigger;
            }
        }
        // 6. Coincidencia tolerando letras dobles ("muzzarella" → "muzarella",
        //    "pepperoni" → "peperoni") y su combinación con plural/raíz.
        const colapsar = s => s.replace(/(.)\1+/g, '$1');
        for (const opt of options) {
            const tituloColapsado = colapsar(this._normalizarMatch(opt.title));
            const raices = new Set();
            for (const w of palabras) {
                const col = colapsar(w);
                raices.add(col);
                if (col.length > 4 && col.endsWith('s')) raices.add(col.slice(0, -1));
            }
            for (const r of raices) {
                if (r.length >= 4 && tituloColapsado.includes(r)) return opt.trigger;
            }
        }
        return null;
    }

    /**
     * Opciones navegables del nodo actual (con trigger), filtrando pasos de
     * checkout y opciones no disponibles. Devuelve [{trigger, title, price}].
     * Un nodo con tag de checkout que tiene HIJOS es una categoría navegable
     * (ej. "##PAGAR##" + productos), no un paso hoja: se conserva como opción.
     */
    async _opcionesNivel(jid, nodeId) {
        const children = await this._getChildren(nodeId);
        const order = this.stateService.getUserOrder(jid) || [];
        const node = await this._getNodeById(nodeId);
        const hasPagar = node && node.message && node.message.includes('##PAGAR##');
        const res = [];
        for (const c of children) {
            if (c.message && c.message.includes('##FINALIZAR##')) {
                if (hasPagar) continue;
                if (order.length === 0) continue;
            }
            if (c.disponible === 'false') continue;
            if (this._esPasoCheckout(c)) {
                // Solo se excluye si es un paso hoja (sin hijos que navegar)
                const grandchildren = await this._getChildren(c.id);
                if (grandchildren.length === 0) continue;
            }
            // ¿Es una SECCIÓN (sub-menú) o un producto vendible hoja? eso
            // permite al router distinguir "navegar a Alquileres" de "comprar X".
            let esSeccion = false;
            try {
                const hijos = await this._getChildren(c.id);
                esSeccion = hijos.some((h) => !this._esPasoCheckout(h));
            } catch (err) {
                esSeccion = false;
            }
            res.push({ trigger: c.trigger, title: c.title, price: c.price, seccion: esSeccion, funcion: c.funcion || '' });
        }
        // "Mis turnos" NO es un nodo de la tabla: el menú lo agrega de forma
        // dinámica para bots de TURNOS con la opción habilitada (input 'm').
        // Lo exponemos a Jev como opción del nivel raíz para que "ver mis turnos"
        // navegue a él en vez de caer en "Reservar turno".
        const cc = this._calendarConfig || {};
        if (this._botType === 'TURNOS' && nodeId === 'root' &&
            cc.mis_turnos_enabled !== false &&
            !res.some(o => String(o.trigger).toLowerCase() === 'm')) {
            res.push({ trigger: 'm', title: 'Mis turnos', price: '', seccion: false, funcion: 'Ver los turnos/reservas ya reservados por el cliente' });
        }
        return res;
    }

    /**
     * Filtro de nodos "navegables" para presentárselos a Jev (mismas reglas
     * que _opcionesNivel: sin pasos de finalización ocultos, sin no-disponibles).
     */
    _filtrarNavegables(nodes, hasPagar, jid) {
        const order = this.stateService.getUserOrder(jid) || [];
        const res = [];
        for (const c of nodes || []) {
            if (c.message && c.message.includes('##FINALIZAR##')) {
                if (hasPagar) continue;
                if (order.length === 0) continue;
            }
            if (c.disponible === 'false') continue;
            res.push(c);
        }
        return res;
    }

    /**
     * Score de relevancia (0..~100+) de un candidato de navegación contra el
     * texto del cliente. Se usa para ORDENAR/DESCARTAR candidatos profundos
     * cuando el subárbol supera MAX_CANDIDATOS_NAVEGACION (Opción B: recorte
     * por relevancia en vez de por orden de llegada). Reutiliza la misma
     * lógica de matching que _matchOption (exacto, inclusión, palabras clave,
     * raíz/plural y colapso de letras dobles).
     */
    _scoreRelevancia(texto, cand) {
        const t = this._normalizarMatch(texto);
        if (!t) return 0;
        const titulo = this._normalizarMatch(cand.title || '');
        const funcion = this._normalizarMatch(cand.funcion || '');
        if (!titulo && !funcion) return 0;

        let score = 0;

        // Coincidencia exacta o por inclusión: máxima relevancia.
        if (titulo && (titulo === t || (t.length >= 3 && titulo.includes(t)) || (titulo.length >= 3 && t.includes(titulo)))) {
            return 100;
        }

        // Palabras del input presentes en el título (o en la función declarada).
        const palabras = t.split(/\s+/).filter(w => w.length >= 3 && !STOPWORDS.has(w));
        if (palabras.length === 0) return 0;

        const raices = new Set();
        for (const w of palabras) {
            raices.add(w);
            if (w.length > 4 && w.endsWith('s')) raices.add(w.slice(0, -1));
        }
        const colapsar = s => s.replace(/(.)\1+/g, '$1');
        const tituloColapsado = colapsar(titulo);
        const funcionColapsada = colapsar(funcion);

        let coincidencias = 0;
        for (const r of raices) {
            if (titulo.includes(r) || funcion.includes(r)) {
                coincidencias++;
            } else {
                const rc = colapsar(r);
                if (rc.length >= 4 && (tituloColapsado.includes(rc) || funcionColapsada.includes(rc))) {
                    coincidencias++;
                }
            }
        }
        score = (coincidencias / raices.size) * 80;

        // Bonus: cuantas más palabras del input calzan, más seguro es el destino.
        score += Math.min(coincidencias, 3) * 5;

        return score;
    }

    /**
     * Arma los candidatos de navegación que Jev puede elegir como destino:
     * opciones del nivel actual (scope 'actual') + secciones del menú principal
     * (scope 'raiz') + secciones hermanas de la sección donde está el cliente
     * (scope 'hermano'). Cada candidato lleva un key único {scope}:{trigger}
     * para que Jev pueda referenciar sin ambigüedad incluso si dos niveles
     * comparten el mismo trigger.
     */
    async _candidatosNavegacion(jid, nodeId, optionsActual, text) {
        const nodoActual = await this._getNodeById(nodeId).catch(() => null);
        const candidatos = [];
        const vistos = new Set();

        const agregar = (scope, trigger, title, price, seccion, funcion, ruta, nodeIdCand) => {
            const t = trigger == null ? '' : String(trigger).trim();
            if (!t) return;
            const key = (scope === 'nodo' && nodeIdCand) ? `nodo:${nodeIdCand}` : `${scope}:${t}`;
            if (vistos.has(key)) return;
            vistos.add(key);
            candidatos.push({
                key, scope, trigger: t, title: title || '', price: price || '',
                seccion: !!seccion, funcion: funcion || '', ruta: ruta || '', nodeId: nodeIdCand || ''
            });
        };

        // Nivel actual (lo que el cliente ve en pantalla).
        for (const o of optionsActual || []) {
            agregar('actual', o.trigger, o.title, o.price, o.seccion, o.funcion, '', '');
        }

        // "Mis turnos" (bots de TURNOS): no es un nodo de la tabla, el menú lo
        // resuelve con el input 'm'. Se lo exponemos a Jev como candidato en
        // TODOS los niveles (no solo root) para que frases como "cuáles son mis
        // turnos" naveguen a él en vez de confundirse con "Reservar turno". En
        // root ya entra como 'actual:m' vía _opcionesNivel; el guard evita el
        // duplicado.
        const ccTurnos = this._calendarConfig || {};
        if (this._botType === 'TURNOS' && ccTurnos.mis_turnos_enabled !== false &&
            !candidatos.some((c) => String(c.trigger).toLowerCase() === 'm')) {
            agregar('especial', 'm', 'Mis turnos', '', false,
                'Ver los turnos/reservas ya reservados por el cliente', '', '');
        }

        // Ramas profundas: BFS del subárbol del nodo actual hasta
        // PROFUNDIDAD_NAVEGACION. El nivel 1 ya quedó como 'actual'; desde el
        // nivel 2 cada nodo se agrega con scope 'nodo' y su id, para que Jev
        // pueda elegir una coincidencia que no está en el primer nivel (hijos,
        // nietos, ...) y el bot navegue directo a ese nodo. Aplica a los bots
        // sin carrito (FAQ y TURNOS): navegan entre las ramas del menú. En el
        // bot de ventas (CARRITO) un ítem profundo debe agregarse al carrito,
        // no navegarse al abrir la categoría, así que se deja fuera.
        //
        // IMPORTANTE: el BFS NO corta por cantidad durante el recorrido (eso
        // descartaba hojas relevantes de ramas anchas, ver MAX_CANDIDATOS).
        // Recolecta todo el subárbol a profundidad y el recorte se hace al
        // final por score de relevancia contra el texto del cliente (Opción B),
        // para que una hoja profunda y pertinente compita por cupo aunque su
        // rama venga tarde en el orden de hijos.
        const candidatosProfundos = [];
        if (this._esFAQ() || this._botType === 'TURNOS') {
            let pendientes = (await this._getChildren(nodeId).catch(() => [])).map((n) => ({ node: n, ruta: [] }));
            for (let d = 2; d <= PROFUNDIDAD_NAVEGACION; d++) {
                const siguientes = [];
                for (const { node: padre, ruta } of pendientes) {
                    const tienePagar = !!(padre.message && padre.message.includes('##PAGAR##'));
                    const hijos = this._filtrarNavegables(await this._getChildren(padre.id).catch(() => []), tienePagar, jid);
                    for (const h of hijos) {
                        const rutaHijo = [...ruta, padre.title].filter(Boolean);
                        const hijosH = await this._getChildren(h.id).catch(() => []);
                        // Los pasos de checkout solo se listan si tienen sub-ramas.
                        if (this._esPasoCheckout(h) && hijosH.length === 0) continue;
                        const esSeccion = hijosH.some((x) => !this._esPasoCheckout(x));
                        const candidato = {
                            key: `nodo:${h.id}`,
                            scope: 'nodo', trigger: String(h.trigger || '').trim(),
                            title: h.title || '', price: h.price || '', seccion: esSeccion,
                            funcion: h.funcion || '', ruta: rutaHijo, nodeId: h.id
                        };
                        if (candidato.trigger && !vistos.has(candidato.key)) {
                            vistos.add(candidato.key);
                            candidatos.push(candidato);
                            candidatosProfundos.push(candidato);
                        }
                        siguientes.push({ node: h, ruta: rutaHijo });
                    }
                }
                pendientes = siguientes;
                if (!pendientes.length) break;
            }
        }

        // Menú principal: secciones raíz navegables. SOLO cuando estamos en un
        // nivel distinto a root (si está parado en root, actual ya las lista y
        // duplicarlas dividiría la probabilidad de Jev en dos claves iguales).
        const rootNode = await this._getNodeById('root').catch(() => ({ message: '' }));
        const raiz = await this._getChildren('root').catch(() => []);
        const rootTienePagar = rootNode && rootNode.message && rootNode.message.includes('##PAGAR##');
        if (String(nodeId) !== 'root') {
            const raizFiltrada = this._filtrarNavegables(raiz, rootTienePagar, jid);
            for (const c of raizFiltrada) {
                agregar('raiz', c.trigger, c.title, c.price, true, c.funcion || '', '', '');
            }
        }

        // Hermanos: si el cliente está dentro de una sección, sus secciones vecinas.
        if (nodoActual && nodoActual.parentId && nodoActual.parentId !== 'root') {
            const padre = await this._getNodeById(nodoActual.parentId).catch(() => null);
            const tienePagar = padre && padre.message && padre.message.includes('##PAGAR##');
            const hermanos = await this._getChildren(nodoActual.parentId).catch(() => []);
            for (const c of this._filtrarNavegables(hermanos, tienePagar, jid)) {
                agregar('hermano', c.trigger, c.title, c.price, true, c.funcion || '', '', '');
            }
        }

        // Si el total de candidatos supera el tope, recortamos por relevancia
        // (Opción B). Los candidatos "no profundos" (nivel actual, especial,
        // raíz, hermano) van SIEMPRE: son pocos, visibles en pantalla o son el
        // menú vecino. Solo los profundos (scope 'nodo') compiten por cupo
        // según su score contra el texto del cliente, en vez de ganar por orden
        // de llegada. Así una hoja pertinente de una rama ancha no se pierde.
        if (candidatos.length > MAX_CANDIDATOS_NAVEGACION) {
            const fijos = candidatos.filter((c) => c.scope !== 'nodo');
            const profundos = candidatosProfundos
                .map((c) => ({ ...c, _score: this._scoreRelevancia(text, c) }))
                .sort((a, b) => b._score - a._score)
                .slice(0, Math.max(0, MAX_CANDIDATOS_NAVEGACION - fijos.length))
                .map(({ _score, ...c }) => c);
            // Mezclamos fijos + los mejores profundos; el orden final no importa
            // porque Jev recibe todos como criterios (clave→descripción).
            const recortados = [...fijos, ...profundos];
            for (const c of profundos) vistos.add(c.key);
            candidatos.length = 0;
            candidatos.push(...recortados);
        }

        return candidatos.slice(0, MAX_CANDIDATOS_NAVEGACION);
    }

    /**
     * Descripción humana de cada candidato para el criteria `categoria_seleccionada`
     * de Jev: título (+ precio si tiene), la función declarada (si existe), la
     * ruta dentro del menú (para los nodos de ramas profundas) y el indicador
     * del nivel al que pertenece.
     */
    _describirCandidato(cand, nombrePadre) {
        const precio = cand.price ? ` ($${cand.price})` : '';
        const funcion = cand.funcion ? ` — ${cand.funcion}` : '';
        let nivel = '';
        if (cand.scope === 'raiz') nivel = ' [menú principal]';
        if (cand.scope === 'hermano') nivel = nombrePadre ? ` [sección ${nombrePadre}]` : ' [sección vecina]';
        const ruta = (cand.ruta && cand.ruta.length) ? `${cand.ruta.join(' › ')} › ` : '';
        return `${ruta}${cand.title || cand.trigger}${precio}${funcion}${nivel}`.trim();
    }

    /**
     * Resuelve el NODO completo de un candidato de navegación (scope + trigger,
     * o su id para los nodos de ramas profundas) para poder saltar a otro nivel
     * con processNode. Devuelve el nodo o null.
     */
    async _resolverNodoPorCandidato(jid, scope, trigger, nodeIdCand) {
        if (nodeIdCand) {
            const n = await this._getNodeById(String(nodeIdCand)).catch(() => null);
            if (n) return n;
        }
        const nodeId = this.stateService.getUserState(jid) || 'root';
        const t = String(trigger || '').trim().toLowerCase();
        let pool = [];
        if (scope === 'raiz') {
            pool = await this._getChildren('root').catch(() => []);
        } else if (scope === 'hermano') {
            const nodoActual = await this._getNodeById(nodeId).catch(() => null);
            const parentId = nodoActual && nodoActual.parentId ? nodoActual.parentId : 'root';
            pool = await this._getChildren(parentId).catch(() => []);
        } else {
            pool = await this._getChildren(nodeId).catch(() => []);
        }
        return pool.find((n) => String(n.trigger || '').trim().toLowerCase() === t) || null;
    }

    /**
     * Si el destino elegido por Jev es una SECCIÓN con sub-opciones, evalúa esas
     * sub-opciones con Jev: el cliente puede estar buscando algo puntual DENTRO
     * de la sección (p. ej. un artículo concreto) y no la sección en sí. Si una
     * sub-opción coincide con la confianza de navegación, se navega a ella (y se
     * repite mientras siga habiendo una coincidencia fuerte, hasta
     * MAX_DESCENSO_NAVEGACION niveles). Si ninguna coincide, se mantiene el
     * destino original.
     */
    async _descenderCandidato(jid, text, cand, onTokens, profundidad = 0) {
        if (profundidad >= MAX_DESCENSO_NAVEGACION) return cand;
        try {
            const nodo = await this._resolverNodoPorCandidato(jid, cand.scope, cand.trigger, cand.nodeId);
            if (!nodo || !nodo.id) return cand;

            const tienePagar = !!(nodo.message && nodo.message.includes('##PAGAR##'));
            const hijos = await this._getChildren(nodo.id).catch(() => []);
            const navegables = this._filtrarNavegables(hijos, tienePagar, jid);

            const subCands = [];
            for (const h of navegables) {
                const t = String(h.trigger || '').trim();
                if (!t) continue;
                const nietos = await this._getChildren(h.id).catch(() => []);
                subCands.push({
                    key: `sub:${t}`,
                    trigger: t,
                    title: h.title || t,
                    nodeId: h.id,
                    funcion: h.funcion || '',
                    seccion: nietos.some((g) => !this._esPasoCheckout(g))
                });
            }
            if (subCands.length === 0) return cand;

            const tituloNodo = nodo.title || cand.title || cand.trigger;
            const claveQuedarse = 'QUEDARSE';
            const criteria = {
                [claveQuedarse]: `quedarse en "${tituloNodo}" (la consulta es general o ninguna sub-opción coincide)`
            };
            const lineasSub = [];
            for (const s of subCands) {
                criteria[s.key] = `acceder a "${s.title}"${s.funcion ? ` — ${s.funcion}` : ''}`;
                lineasSub.push(`  ${s.key}→${s.title}${s.funcion ? ` — ${s.funcion}` : ''}`);
            }

            const estado = [
                `CONSULTA DEL CLIENTE: "${text}"`,
                `El cliente está por entrar a "${tituloNodo}", que tiene sub-opciones.`,
                'SUB-OPCIONES (clave→título):',
                lineasSub.join('\n'),
                `  ${claveQuedarse}→quedarse en "${tituloNodo}"`
            ].join('\n');

            const respuesta = await jevService.consultarJev(estado, {
                subcategoria: {
                    type: 'choice',
                    instructions: 'Determiná si la consulta del cliente apunta a ALGUNA de las sub-opciones (buscaba algo puntual dentro de la sección) o si se refiere a la sección en general. Si una sub-opción coincide claramente, elegí su clave; si ninguna coincide o la consulta era general, elegí QUEDARSE.',
                    criteria
                }
            });

            const usage = jevService.tokensUsados(respuesta);
            if (usage > 0 && typeof onTokens === 'function') onTokens(usage);

            const ch = jevService.obtenerChoice(respuesta, 'subcategoria');
            if (ch && ch.choice && ch.choice !== claveQuedarse &&
                typeof ch.confidence === 'number' && ch.confidence >= jevService.UMBRAL_NAVEGACION) {
                const sub = subCands.find((s) => s.key === ch.choice);
                if (sub) {
                    console.log(`[Jev] ${this.idCliente}: descenso "${tituloNodo}" -> "${sub.title}" (confianza ${ch.confidence.toFixed(2)}) | msg: "${text}"`);
                    const elegido = {
                        key: sub.key,
                        scope: 'nodo',
                        trigger: sub.trigger,
                        title: sub.title,
                        price: '',
                        funcion: sub.funcion,
                        seccion: sub.seccion,
                        ruta: [...(cand.ruta || []), tituloNodo],
                        nodeId: sub.nodeId
                    };
                    // Si la sub-opción también es una sección, probamos bajar un nivel más.
                    return await this._descenderCandidato(jid, text, elegido, onTokens, profundidad + 1);
                }
            }
            return cand;
        } catch (err) {
            console.error(`[Jev] Error descendiendo candidato ${this.idCliente}:`, err.message);
            return cand;
        }
    }

    /**
     * ¿El mensaje pide FOTOS de un ítem ("tenés fotos?", "pasame fotos de la de
     * las heras", "y las fotos de esa propiedad?", "quiero ver imagenes")?
     * Bot FAQ (ej. inmobiliaria): las fotos viven en la ficha del nodo y se
     * envían por WhatsApp; esto detecta el pedido para abrir esa ficha.
     */
    _esPeticionFotos(text) {
        const t = this._normalizarMatch(text);
        if (!t) return false;
        if (!/\b(?:foto|fotos|imagen|imagenes|pics|fotitos)\b/.test(t)) return false;
        return /\b(?:pasar|pasa|pasame|pasarme|manda|mandar|mandame|mandas|mostrar|mostrame|muestra|muestrame|tenes|tienes|tengan|hay|quiero|quiere|necesito|busco|conseguir|ver|veo|mira|ves|existe|disponible|esa|esa\s+propiedad|tambien|de\s+la)\b/.test(t);
    }

    /**
     * Resuelve el NODO (ficha/sección) cuyas fotos pide el cliente si hay un
     * ítem concreto identificable: match directo del nivel ("la de las heras"),
     * o el último ítem de interés (interes) ya sea como opción del nivel actual
     * o como la ficha sobre la que ya está parado el cliente. Devuelve el nodo
     * completo o null (=> no se puede saber cuál, sigue el flujo normal).
     */
    async _resolverNodoFotos(text, options, jid, nodeId) {
        const directo = this._matchOption(text, options);
        const hijos = await this._getChildren(nodeId);
        if (directo) {
            const h = (hijos || []).find(x => String(x.trigger).toLowerCase() === String(directo).toLowerCase());
            if (h) return h;
        }
        const sesion = this.stateService.getChatSession(jid) || {};
        const u = sesion.interes;
        if (u && u.trigger) {
            const trig = String(u.trigger);
            const h = (hijos || []).find(x => String(x.trigger).toLowerCase() === trig.toLowerCase());
            if (h) return h;
            const actual = await this._getNodeById(nodeId).catch(() => null);
            if (actual && String(actual.trigger).toLowerCase() === trig.toLowerCase()) return actual;
        }
        return null;
    }

    /**
     * Detecta si estamos en un flujo especial que el menú ya está manejando
     * (esperando datos, cantidad, archivo o turno). Si es así, el traductor NO
     * debe interpretar: el menú procesa el input directo.
     * Devuelve 'datos' | 'archivo' | 'cantidad' | 'turno' | null.
     */
    _detectSpecialFlow(jid, text) {
        if (this.stateService.getWaitingForData(jid)) return 'datos';
        if (this.stateService.getWaitingForFile(jid)) return 'archivo';
        if (this.stateService.getPendingQuantityItem(jid)) return 'cantidad';
        // "Mis turnos" y la confirmación del turno seleccionado son estados de
        // "teclado": SOLO bloquean el flujo si el cliente responde una selección
        // (número, confirmar/cancelar o salir/volver). Si pregunta otra cosa, lo
        // dejamos pasar para que la IA pueda responderle sin quedar atrapado en
        // la lista o en el detalle del turno.
        if (this.stateService.getMisTurnos(jid) && this._esSeleccionListaTurnos(text)) return 'turno';
        if (this.stateService.getMisTurnoSeleccionado(jid) && this._esAccionTurnoSeleccionado(text)) return 'turno';
        if (this.stateService.getWaitingTurnoDate(jid) ||
            this.stateService.getWaitingTurnoSlot(jid) ||
            this.stateService.getWaitingTurnoConfirm(jid) ||
            this.stateService.getWaitingTurnoReminder(jid) ||
            this.stateService.getWaitingTurnoCascada(jid) ||
            this.stateService.getWaitingTurnoWaitlistName(jid) ||
            this.stateService.getWaitingTurnoReprogram(jid)) return 'turno';
        return null;
    }

    /** ¿El texto es una selección válida dentro de la lista de "mis turnos"? */
    _esSeleccionListaTurnos(text) {
        const t = String(text || '').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
        return /^\d+$/.test(t) || /^(0|v|salir|volver|volver atras|atras|regresar|inicio|menu|menu principal)$/.test(t);
    }

    /** ¿El texto es una acción válida sobre el turno seleccionado (1/2/0)? */
    _esAccionTurnoSeleccionado(text) {
        const t = String(text || '').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
        return /^\d+$/.test(t) || /^(0|v|salir|volver|volver atras|atras|regresar|inicio|menu|menu principal|si|s|no|n|ok|dale|confirmar|confirmo|aceptar|acepto|cancelar|cancelo|anular|pasar|pasarlo|siguiente|listo|dejarlo|dejar)$/.test(t);
    }

    /**
     * Envía un mensaje del traductor. Usamos saltando el wrapper de traducción
     * marcando el flag _translated para evitar re-trarducir.
     * (El wrapper en app.js chequea este flag.)
     * Todos los mensajes del asistente IA se prefijan con ✨ para distinguirlos
     * de los mensajes deterministas del menú.
     */
    _sendRaw(sock, jid, text) {
        const marcado = `✨ ${String(text || '')}`.trim();
        return sock.sendMessage(jid, { text: marcado }).catch(() => {});
    }

    /**
     * Envía mensaje con espera de escritura (tiping) como el menú normal.
     */
    async _sendFriendly(sock, jid, text) {
        await this._sendTyping(sock, jid, (text || '').length);
        await this._sendRaw(sock, jid, text);
    }

    /**
     * Deriva al cliente a un vendedor humano configurado (avalado por el plan
     * premium). Usado cuando el asistente detecta intención de compra o entra en
     * bucle (no encuentra lo que el usuario busca). Corta el flujo: avisa al
     * vendedor por WhatsApp con los datos del pedido y le muestra al cliente el
     * mensaje de derivación configurado en el dashboard (o el texto por defecto).
     * Devuelve true si pudo derivar, false si no hay vendedor configurado.
     */
    async _derivarVendedor(sock, jid, pushName, opts) {
        const cfg = await botConfigService.getBotConfig(this.idCliente).catch(() => ({}));
        const ai = (cfg && cfg.ai_config) || {};
        const vendedor = ai.vendedor || {};
        const { msj, contactos } = this._listarContactosVendedor(ai);
        if (!contactos || contactos.length === 0) return false;

        // Contacto destino: 1) explícito (opts.contacto), 2) por categoría
        // (texto del cliente), 3) primer contacto (comportamiento actual).
        let contacto = (opts && opts.contacto) || null;
        if (!contacto && opts && opts.texto) {
            contacto = this._matchearCategoria(opts.texto, contactos) || contactos[0];
        }
        if (!contacto) contacto = contactos[0];
        const telVendedor = String(contacto.telefono || '').trim();

        const itemsV = this.stateService.getUserOrder(jid) || [];
        let totalV = 0;
        const lineasV = itemsV.map(it => {
            totalV += (it.price || 0) * (it.quantity || 1);
            return `• ${it.quantity} x ${it.text}` + (it.price ? ` ($${it.price * it.quantity})` : '');
        });
        const interesV = (opts && opts.interes) || null;
        const telefonoClienteV = String(jid).split('@')[0] || '';
        const datosV = this.stateService.getDatosText(jid);
        const nombreVendedor = contacto.nombre ? String(contacto.nombre).trim() : 'asesor';

        // Por qué se deriva (opts.motivo) con respaldo claro por defecto.
        const motivo = (opts && opts.motivo && String(opts.motivo).trim())
            ? String(opts.motivo).trim()
            : 'El cliente necesita atención humana para resolver su consulta.';

        // Referencia del ítem: el interés puntual declarado (título) o, si no
        // hay, el primer ítem del pedido actual. El disparador queda como
        // respaldo solo si no existe título.
        const primeroV = itemsV[0] || null;
        const refTitle = (interesV && interesV.title) ? String(interesV.title) : (primeroV ? String(primeroV.text || '') : '');
        const refTrig = (interesV && interesV.trigger) ? String(interesV.trigger) : (primeroV && primeroV.trigger ? String(primeroV.trigger) : '');
        const referenciaV = refTitle ? refTitle : refTrig;

        const msgVendedor =
            `🛒 *Cliente derivado - ${nombreVendedor}*\n\n` +
            `*Negocio:* ${this.idCliente}\n` +
            `*Cliente:* ${pushName ? pushName : (datosV || 'sin nombre')}\n` +
            `*Teléfono:* ${telefonoClienteV}\n` +
            (datosV ? `*Datos:* ${datosV}\n` : '') +
            `*Motivo:* ${motivo}\n` +
            (referenciaV ? `*Referencia:* ${referenciaV}\n` : '') +
            (lineasV.length ? `*Pedido:*\n${lineasV.join('\n')}\n*Total:* $${totalV}\n` : '') +
            `\nContactalo para resolver su consulta.`;
        const vendedorJid = this._phoneToJid(telVendedor);
        if (vendedorJid) {
            await sock.sendMessage(vendedorJid, { text: msgVendedor })
                .catch(err => console.error(`[AI] Error avisando vendedor ${this.idCliente}:`, err.message));
        }

        // Mensaje al cliente: configurable desde el dashboard (vendedor.mensaje),
        // con un texto de respaldo por defecto.
        const mensajeCliente =
            (msj && String(msj).trim()) ||
            'Voy a comunicarte con una persona de nuestro equipo para agilizar tu consulta.';
        await this._sendFriendly(sock, jid, mensajeCliente);

        const sesionV = this.stateService.getChatSession(jid) || { history: [], nodeId: 'root' };
        this.stateService.setChatSession(jid, { ...sesionV, derivado: true });

        // El bot queda en silencio tras derivar: deja la conversación en manos
        // del asesor. En producción hasta el final del día (no responde más ese
        // día); en local, unos minutos (para poder seguir probando).
        const ttlSilencio = this._ttlSilencioAsesor();
        this.stateService.setSilencioAsesor(jid, ttlSilencio);
        console.log(`[AI] Bot ${this.idCliente}: derivado a asesor -> bot en silencio ${ttlSilencio}s`);
        return true;
    }

    /**
     * Duración (segundos) del silencio del bot tras derivar a un asesor humano.
     * Producción: hasta la próxima medianoche (no vuelve a responder ese día).
     * Local/dev: 5 minutos.
     */
    _ttlSilencioAsesor() {
        if (process.env.NODE_ENV === 'production') {
            const ahora = new Date();
            const manana = new Date(ahora);
            manana.setHours(24, 0, 0, 0); // próxima medianoche (hora local)
            return Math.max(60, Math.floor((manana.getTime() - ahora.getTime()) / 1000));
        }
        return 5 * 60;
    }

    /**
     * (Solo desarrollo/pruebas) Borra TODA la sesión del cliente: estado del
     * menú, pedido, datos, chat de la IA, turnos, archivos y flags. Se activa
     * con RESET_SESION_AL_SALUDAR=1 (fuera de producción) al recibir "hola".
     */
    _resetSesion(jid) {
        if (!this.stateService) return;
        try {
            this.stateService.resetUserState(jid);
            this.stateService.clearChatSession(jid);
            this.stateService.clearUserIntent(jid);
            this.stateService.clearTranslationFails(jid);
            this.stateService.clearPedidoFinalizado(jid);
            this.stateService.clearSilencioAsesor(jid);
            this.stateService.clearWaitingForData(jid);
            this.stateService.clearWaitingForFile(jid);
            this.stateService.clearPendingQuantityItem(jid);
            this.stateService.clearPendingOrderItem(jid);
            this.stateService.clearBookingFlow(jid);
            this.stateService.clearWaitingTurnoReminder(jid);
            this.stateService.clearWaitingTurnoCascada(jid);
            this.stateService.clearWaitingTurnoWaitlistName(jid);
            this.stateService.clearMisTurnos(jid);
            this.stateService.clearMisTurnoSeleccionado(jid);
            this.stateService.clearWaitingTurnoReprogram(jid);
        } catch (err) {
            console.error(`[AI] Error reseteando sesión ${this.idCliente}:`, err.message);
        }
    }

    /**
     * Callback inyectado en el MenuController para intervenir cuando el menú
     * cambia a un nodo de checkout/cierre de compra (##FINALIZAR## / ##PAGAR##).
     * Si hay vendedor configurado, deriva al vendedor y devuelve { detener: true }
     * para que el menú no continúe con _finalizeOrder/redirección. Si no hay
     * vendedor o no corresponde, devuelve null para que el menú siga normal.
     */
    async intervenirNodoCheckout(sock, jid, pushName, context) {
        const cfg = await botConfigService.getBotConfig(this.idCliente).catch(() => ({}));
        const ai = (cfg && cfg.ai_config) || {};

        // Rama "nodo asesor": el cliente eligió una opción del menú que pide
        // hablar con un humano (ej. "Hablar con asesor administrativo"). Deriva
        // al contacto cuya categoría coincide con el título del nodo, igual que
        // en el texto libre. Sin contactos configurados no actúa y el nodo hoja
        // muestra su mensaje normal.
        if (context && context.tipo === 'asesor') {
            return this._intervenirNodoAsesor(sock, jid, pushName, ai, context.node);
        }

        const order = this.stateService.getUserOrder(jid) || [];
        if (order.length === 0) return null;

        // Sugerencia de complemento antes de pagar (solo con IA activa y checkbox).
        // Si el asistente ofreció un complemento, el menú se detiene y la
        // conversación IA continúa hasta que el cliente confirme pago o agregue.
        if (await this._sugerirComplementoSiCorresponde(sock, jid)) {
            console.log(`[AI] Bot ${this.idCliente}: interceptor checkout -> sugerencia de complemento`);
            return { detener: true };
        }

        const { contactos } = this._listarContactosVendedor(ai);
        if (!contactos || contactos.length === 0) return null;

        const derivado = await this._derivarVendedor(sock, jid, pushName, { motivo: 'Quiere pagar/confirmar su pedido' });
        if (derivado) {
            console.log(`[AI] Bot ${this.idCliente}: interceptor checkout -> derivación a vendedor`);
            return { detener: true };
        }
        return null;
    }

    /**
     * (Menú) El cliente eligió un nodo que pide hablar con un humano
     * ("Hablar con asesor administrativo"): deriva al contacto cuya categoría
     * coincide con el título del nodo, igual que en el texto libre. Sin
     * contactos configurados no actúa (el nodo muestra su mensaje normal).
     * Devuelve { detener: true } cuando deriva (el contacto ya envió el mensaje
     * al cliente) o null para que el nodo siga su flujo normal.
     */
    async _intervenirNodoAsesor(sock, jid, pushName, ai, node) {
        const { contactos } = this._listarContactosVendedor(ai);
        if (!contactos || contactos.length === 0) return null;

        const titulo = (node && node.title) ? String(node.title) : '';
        const fraseArea = this._solicitaAsesor(titulo) || 'asesor';

        // 1) Categoría matcheada con el título del nodo -> deriva a ese contacto.
        const contactoMatch = this._matchearCategoria(`${fraseArea} ${titulo}`, contactos);
        if (contactoMatch) {
            const derivado = await this._derivarVendedor(sock, jid, pushName, {
                contacto: contactoMatch,
                motivo: `Solicitó hablar con ${contactoMatch.nombre} desde el menú (${titulo})`,
                texto: titulo || fraseArea
            });
            if (derivado) {
                console.log(`[AI] Bot ${this.idCliente}: nodo asesor "${titulo}" -> contacto "${contactoMatch.nombre}" (categoría matcheada)`);
                return { detener: true };
            }
            return null;
        }

        // 2) Área específica sin contacto configurado -> "No tengo esa opción."
        if (!this._esAreaGenerica(fraseArea)) {
            const areas = this._listaAreasDisponibles(contactos);
            const lista = areas.length ? '\n' + areas.map(a => `- ${a}`).join('\n') : '';
            await this._sendFriendly(sock, jid, `No tengo esa opción. Las opciones disponibles son:${lista}`);
            console.log(`[AI] Bot ${this.idCliente}: nodo asesor "${titulo}" -> categoría sin contacto: "No tengo esa opción"`);
            return { detener: true };
        }

        // 3) Genérico (el título pide un asesor sin área): contacto principal.
        const derivadoGen = await this._derivarVendedor(sock, jid, pushName, {
            motivo: `Solicitó hablar con un asesor desde el menú (${titulo})`,
            texto: titulo || fraseArea
        });
        if (derivadoGen) {
            console.log(`[AI] Bot ${this.idCliente}: nodo asesor "${titulo}" -> contacto principal`);
            return { detener: true };
        }
        return null;
    }

    /**
     * Consulta al LLM si conviene sugerir un producto/servicio complementario
     * antes de que el cliente confirme el pago. Usa el catálogo REAL del nivel
     * actual como única fuente de productos (anti-alucinación) y, si el negocio
     * lo indicó en "Instrucciones", respeta esa regla. Devuelve
     * { sugerir, mensaje } o null ante cualquier fallo.
     */
    async _consultarSugerenciaComplemento(jid, ai) {
        const orden = this.stateService.getUserOrder(jid) || [];
        if (!ai.enabled) return null;
        const negocio = this.idCliente;
        const catalogo = await this._buildCatalogo(jid).catch(() => []);
        const catalogoTxt = catalogo.length
            ? catalogo.map((c, i) => `${i + 1}. "${c.trigger}" → ${c.title}${c.price ? ` ($${c.price})` : ''}`).join('\n')
            : '(sin productos en el nivel actual)';
        let pedidoTxt = '(sin ítems)';
        if (orden.length) {
            let total = 0;
            const lineas = orden.map(it => {
                const sub = (it.price || 0) * (it.quantity || 1);
                total += sub;
                return `- ${it.quantity} x ${it.text}` + (it.price ? ` ($${sub})` : '');
            });
            pedidoTxt = `${lineas.join('\n')}\nTOTAL: $${total}`;
        }
        const instrucciones = (ai.instrucciones && String(ai.instrucciones).trim())
            ? `Instrucciones del negocio: ${String(ai.instrucciones).trim()}\n`
            : '';
        const template = await llmPromptService.getPrompt('sugerir_complemento');
        const systemPrompt = llmPromptService.renderPrompt(template, {
            negocio,
            instrucciones,
            pedido: pedidoTxt,
            catalogo: catalogoTxt
        });
        try {
            const result = await llmChatService.chat({
                systemPrompt,
                messages: [{ role: 'user', content: '¿Conviene sugerir un complemento para este pedido?' }],
                tools: [],
                executeTool: null,
                onTokens: (n) => aiUsageService.addTokens(this.idCliente, n)
            });
            const content = result && result.content ? result.content.trim() : '';
            if (!content) return null;
            const jsonMatch = content.match(/\{[\s\S]*\}/);
            if (!jsonMatch) return null;
            const parsed = JSON.parse(jsonMatch[0]);
            const sugerir = parsed && parsed.sugerir === true;
            const mensaje = (parsed && parsed.mensaje && String(parsed.mensaje).trim()) || '';
            if (!sugerir || !mensaje) return { sugerir: false, mensaje: '' };
            return { sugerir: true, mensaje };
        } catch (err) {
            console.error(`[AI] Error consultando sugerencia de complemento ${this.idCliente}:`, err.message);
            if (err && err.isQuotaExceeded) {
                this.quotaBlocked = true;
                console.warn(`[AI] Bot ${this.idCliente}: se bloqueó el traductor por cuota agotada (sin sugerencia de complemento)`);
            }
            return null;
        }
    }

    /**
     * Regla genérica "sugerir complemento al finalizar": solo con IA activa y
     * checkbox activado. Si el cliente ya recibió la oferta (sesión con
     * "complementoSugerido") y vuelve a confirmar, borra el flag y devuelve
     * false para que el flujo siga a pagar/derivar (la próxima vez ofrecerá de
     * nuevo). Devuelve true si envió la oferta (el nodo checkout debe detenerse).
     */
    async _sugerirComplementoSiCorresponde(sock, jid) {
        const cfg = await botConfigService.getBotConfig(this.idCliente).catch(() => ({}));
        const ai = (cfg && cfg.ai_config) || {};
        if (!ai.enabled || !ai.sugerirComplemento) return false;
        const orden = this.stateService.getUserOrder(jid) || [];
        if (orden.length === 0) return false;

        const sesion = this.stateService.getChatSession(jid) || { history: [], nodeId: 'root' };
        if (sesion.complementoSugerido) {
            const { complementoSugerido, ...resto } = sesion;
            this.stateService.setChatSession(jid, resto);
            return false;
        }
        const decision = await this._consultarSugerenciaComplemento(jid, ai);
        if (decision && decision.sugerir && decision.mensaje) {
            this.stateService.setChatSession(jid, { ...sesion, complementoSugerido: true });
            await this._sendFriendly(sock, jid, decision.mensaje);
            return true;
        }
        return false;
    }

    /**
     * Extrae las opciones de un menú desde el texto técnico generado por el
     * menú (una por línea, con trigger entre asteriscos). Devuelve:
     * [{ trigger, title, price, sinStock }] ignorando párrafos/footer.
     */
    _parseOpciones(rawText) {
        const opciones = [];
        for (const l of String(rawText).split(/\r?\n/)) {
            const trim = l.trim();
            if (!trim || trim === '---') continue;
            let linea = trim;
            let sinStock = false;
            if (linea.includes('(sin stock)')) { sinStock = true; linea = linea.replace(/\(sin stock\)/g, ''); }
            linea = linea.replace(/^~/, '').replace(/~$/, '').trim();
            const m = linea.match(/^\*([^*]+)\*\.\s+(.+?)(?:\s*\((\$?[\d.,]+)\))?$/);
            if (m) {
                opciones.push({
                    trigger: String(m[1]).trim().toLowerCase(),
                    title: m[2].trim(),
                    price: m[3] ? String(m[3]).trim() : '',
                    sinStock
                });
            }
        }
        return opciones;
    }

    /**
     * Devolución determinística sin LLM: lista las opciones por nombre/precio
     * (sin números) y un cierre de navegación amable. Se usa como RESPUESTA
     * SEGURA cuando el LLM omite opciones, para que el cliente SIEMPRE las vea.
     */
    _formatearFriendly(rawText, opciones) {
        const lines = String(rawText).split(/\r?\n/);
        const mensaje = [];
        for (const l of lines) {
            const trim = l.trim();
            if (!trim) continue;
            if (/^\*[^*]+\*\./.test(trim)) break;
            if (/^---/.test(trim)) break;
            mensaje.push(trim);
        }
        const pie = opciones.filter(o => /^(0|p|v|vaciar|mis\s*turnos|m)$/i.test(o.trigger));
        const nodos = opciones.filter(o => !/^(0|p|v|vaciar|mis\s*turnos|m)$/i.test(o.trigger));

        let out = (mensaje.join(' ') || '').trim();
        if (nodos.length > 0) {
            out += `${out ? '\n\n' : ''}Estas son tus opciones:\n`;
            out += nodos.map(o => `• ${o.title}${o.price ? ` (${o.price})` : ''}${o.sinStock ? ' (sin stock)' : ''}`).join('\n');
        }
        const closing = [];
        if (pie.some(o => /^(v)$/i.test(o.trigger))) closing.push('volver atrás');
        if (pie.some(o => /^(p)$/i.test(o.trigger))) closing.push('ir a pagar');
        if (pie.some(o => /^(vaciar)$/i.test(o.trigger))) closing.push('vaciar el pedido');
        if (closing.length > 0) {
            out += `\n\nPodés pedirme que ${closing.join(' o que ')}.`;
        } else {
            out += `\n\nPodés pedirme que vuelva al inicio o que retroceda, o mencionar qué querés.`;
        }
        return out;
    }

    /**
     * Verifica que la salida del LLM conserva al menos el nombre de cada
     * opción del menú (comparación normalizada). Si algún nombre no aparece,
     * consideramos que el LLM omitió opciones y usamos el fallback seguro.
     */
    _opcionesPresentes(output, opciones) {
        if (!output) return false;
        const normOut = this._normalizarMatch(output);
        const nodos = opciones.filter(o => !/^(0|p|v|vaciar|mis\s*turnos|m)$/i.test(o.trigger));
        return nodos.every(o => {
            const title = this._normalizarMatch(o.title);
            if (!title) return true;
            return normOut.includes(title);
        });
    }

    /**
     * Quita un saludo de bienvenida que el LLM suele INVENTAR al inicio de la
     * reescritura del menú ("¡Hola! 😊", "Hola, buen día", "Hi 👋") porque ese
     * texto no existe en el rawText original y queda "pegado" en la pantalla.
     * Solo se aplica cuando el nodo muestra opciones (el menú ya lleva su propio
     * mensaje real). Conserva el resto del contenido.
     */
    _recortarSaludoInventado(text) {
        if (!text || typeof text !== 'string') return text;
        const original = text;
        let out = text.replace(
            /^(?:¡?\s*hola!?|hola!?|hi!?|buenas!\b|buenos\s+d[ií]as!?|buenas\s+tardes!?|buenas\s+noches!?)\b/i,
            ''
        );
        if (out === original) return text.trim();
        // Quita emojis de saludo y signos de puntuación colgantes del inicio.
        out = out.replace(/^[\s,:!¡?¿]*(?:[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}])*/u, '');
        // Una eventual pregunta de relleno y ofrecimiento genérico inmediatos
        // ("¿Cómo estás?", "Si necesitás ayuda... no dudes en decírmelo").
        out = out.replace(/^¿?\s*c[oó]mo\s+(?:est[aá]s|est[aá]s\s+el\s+d[ií]a|and[aá]s|te\s+va)\s*.?\s*/i, '');
        out = out.replace(/^(?:si\s+necesit[aá]s\s+ayuda\s*(?:con\s+lo\s+que\s+sea|con\s+algo)?\s*,\s*)?no\s+dudes\s+en\s+consultarme\s*.?\s*/i, '');
        out = out.replace(/^(?:si\s+necesit[aá]s\s+ayuda\s*(?:con\s+lo\s+que\s+sea|con\s+algo)?\s*,\s*)?no\s+dudes\s+en\s+dec[ií]rmelo\s*.?\s*/i, '');
        out = out.trim();
        // Si tras quitar el saludo no queda nada útil, devolvemos el original sin saludo.
        return out || original.trim();
    }

    /**
     * Existe un solo brazo de menú navegable (ej. "1. Hace tu pedido") y el
     * cliente quiere PEDIR/VER OPCIONES: devolvemos su trigger para entrar
     * directo y mostrar los productos. Si hay más de uno, o ninguno, queda en 0.
     */
    _resolverTriggerPedido(options) {
        if (options && options.length === 1) return options[0].trigger;
        if (options && options.length > 1) return null;
        return null;
    }

    /**
     * Detecta los mensajes de "teclado" de los flujos de turno: piden una
     * respuesta literal (número o palabra clave) y NO deben reformularse.
     */
    _esPromptTeclado(rawText) {
        const t = String(rawText || '');
        return /Escribí el número|Respondé \*1\*|¿Qué querés hacer\?|Aceptar \/ confirmar|Cancelar turno|¿Confirmás la reserva\?|¿Querés confirmar tu asistencia\?|¿Lo querés para vos\?|reprogramar|Recordatorio de tu turno|Confirmar asistencia|Tus turnos:|Horarios disponibles/i.test(t);
    }

    /**
     * (PÚBLICO) Reformula un mensaje de SALIDA del menú hacia el cliente:
     * si parece un menú con opciones numeradas, lo reescribe en tono amable
     * y SIN los números/triggers. Si no parece un menú, devuelve el texto tal cual.
     * Falla silenciosamente: cualquier error devuelve el texto original.
     */
    async reformulate(rawText, jid) {
        if (!rawText || typeof rawText !== 'string') return rawText;

        // Los prompts de "teclado" de los flujos de turno (confirmar/cancelar,
        // elegir horario, mis turnos, lista de espera, recordatorio) esperan que
        // el cliente responda un NÚMERO y el menú lo interpreta literal. Si los
        // reescribimos "amablemente" pierden los números y el cliente queda sin
        // saber qué responder (pedía "respondé 1" cuando nunca mostró el 1).
        if (this._esPromptTeclado(rawText)) return rawText;

        const tieneNodos = /[\s\S]*\*[^\*]+\*[\.\)]?\s/.test(rawText) &&
            /(?:^|\n)\*[a-z0-9]+\*\.\s+\S+/i.test(rawText);
        if (!tieneNodos) return rawText;

        // Bots de TURNOS: el menú numerado es la UI de navegación (el cliente
        // elige por número o por nombre). La reescritura le quita los números y
        // lo deja sin referencia para responder, así que devolvemos el menú tal
        // cual (con sus opciones numeradas).
        if (this._botType === 'TURNOS') return rawText;

        // Gates premium/ai/quota: sin ellos, el menú se muestra tal cual.
        const user = await userService.getUserByIdCliente(this.idCliente).catch(() => null);
        if (!user || user.plan !== 'premium') return rawText;
        const cfg = await botConfigService.getBotConfig(this.idCliente).catch(() => ({ ai_config: {} }));
        const ai = (cfg && cfg.ai_config) || {};
        if (!ai.enabled || this.quotaBlocked) return rawText;

        const style = ESTILOS[ai.estilo] || ai.promptCustom || ESTILOS.profesional;
        const negocio = user.nombreCliente || user.businessName || this.idCliente;
        const opcionesMenu = this._parseOpciones(rawText);

        const template = await llmPromptService.getPrompt('reescritor_menu');
        const systemPrompt = llmPromptService.renderPrompt(template, { negocio, estilo: style });

        try {
            const result = await llmChatService.chat({
                systemPrompt,
                messages: [{ role: 'user', content: rawText }],
                tools: [],
                executeTool: null,
                onTokens: (n) => aiUsageService.addTokens(this.idCliente, n)
            });
            const content = result && result.content ? result.content.trim() : '';
            // Seguridad: jamás dejar que el LLM se "coma" las opciones del menú.
            // Si la reescritura no conserva todas las opciones, usamos la respuesta
            // determinística (lista por nombre/precio) para que el cliente SIEMPRE
            // las vea y el bot no parezca vacío.
            if (content && this._opcionesPresentes(content, opcionesMenu)) {
                console.log(`[OpenAI] ${this.idCliente}: reformuló menú a lenguaje natural (${opcionesMenu.length} opciones)`);
                return opcionesMenu.length > 0 ? this._recortarSaludoInventado(content) : content;
            }
            if (opcionesMenu.length > 0) {
                return this._formatearFriendly(rawText, opcionesMenu);
            }
            return content || rawText;
        } catch (err) {
            console.error(`[AI] Error reformulando menú ${this.idCliente}:`, err.message);
            if (err && err.isQuotaExceeded) {
                this.quotaBlocked = true;
                console.warn(`[AI] Bot ${this.idCliente}: se bloqueó el traductor por cuota agotada (menú sin traducir)`);
            }
            return rawText;
        }
    }

    async _buildPrompt(ai, cfg, user, pushName, seccion, nodeId) {
        const style = ESTILOS[ai.estilo] || ai.promptCustom || ESTILOS.profesional;
        const negocio = user.nombreCliente || user.businessName || this.idCliente;
        const template = await llmPromptService.getPrompt('traductor');
        return llmPromptService.renderPrompt(template, {
            negocio,
            estilo: style,
            instrucciones: (ai.instrucciones ? `Instrucciones especiales del negocio (solamente tono/restricciones de negocio, NO afectan el formato ni la navegación):\n${ai.instrucciones}\n\n` : ''),
            nodo: nodeId,
            seccion
        });
    }

    /**
     * Usa el LLM para interpretar el texto del cliente contra la sección actual.
     * Devuelve {trigger, cantidad} o {trigger: null}.
     */
    async _interpretWithAI(ai, cfg, user, pushName, seccion, nodeId, text) {
        const systemPrompt = await this._buildPrompt(ai, cfg, user, pushName, seccion, nodeId);
        const result = await llmChatService.chat({
            systemPrompt,
            messages: [{ role: 'user', content: text }],
            tools: [],
            executeTool: null,
            onTokens: (n) => aiUsageService.addTokens(this.idCliente, n)
        });
        const content = result && result.content ? result.content.trim() : '';
        if (!content) return { trigger: null };
        const jsonMatch = content.match(/\{[\s\S]*\}/);
        if (!jsonMatch) return { trigger: null };
        try {
            const parsed = JSON.parse(jsonMatch[0]);
            const trigger = (parsed && parsed.trigger != null) ? String(parsed.trigger) : null;
            if (!trigger) return { trigger: null };
            return { trigger, cantidad: parsed.cantidad != null ? Number(parsed.cantidad) : undefined };
        } catch {
            return { trigger: null };
        }
    }

    /**
     * (PÚBLICO) Entry point. Interpreta el texto del cliente y decide:
     *   - false: el menú debe procesar el texto tal cual (flujo especial, no premium, etc.)
     *   - un trigger (string): el menú debe recibir ese trigger
     *   - { derivado: true }: el traductor ya derivó a un humano (y escribió respuesta)
     */
    async handleMessage(sock, jid, text, opts) {
        // Observabilidad: registra si Jev fue consultado en esta resolución. Si
        // un fast-path determinista resuelve el mensaje antes de llegar a Jev,
        // se emite una línea [Jev][skip] con el resultado (el motivo concreto es
        // la línea [AI] inmediatamente anterior en el log).
        if (!this._jevConsultadoPorJid) this._jevConsultadoPorJid = {};
        if (!this._jevSkipMuted) this._jevSkipMuted = {};
        if (!this._jevSkipRazon) this._jevSkipRazon = {};
        this._jevConsultadoPorJid[jid] = false;
        let resultado;
        try {
            resultado = await this._handleMessageInner(sock, jid, text, opts);
        } finally {
            // Los mensajes de un flujo especial en curso (ej. agenda de turnos:
            // fecha/horario/confirmación) pasan al menú por diseño y NO deben
            // ensuciar el log con [Jev][skip].
            const mute = !!this._jevSkipMuted[jid];
            if (this._jevConsultadoPorJid[jid] === false && !mute) {
                const resumen = resultado === false
                    ? 'menú/flujo normal'
                    : (resultado && typeof resultado === 'object'
                        ? JSON.stringify(resultado)
                        : `trigger "${resultado}"`);
                const razon = this._jevSkipRazon[jid] ? ` | razón: ${this._jevSkipRazon[jid]}` : '';
                console.log(`[Jev][skip] ${this.idCliente}: no consultado -> resuelto por fast-path determinista (${resumen})${razon}`);
            }
            delete this._jevConsultadoPorJid[jid];
            delete this._jevSkipMuted[jid];
            delete this._jevSkipRazon[jid];
        }
        return resultado;
    }

    async _handleMessageInner(sock, jid, text, opts) {
        if (!text || typeof text !== 'string') { this._setJevRazon(jid, 'texto inválido'); return false; }
        const pushName = (opts && opts.pushName) ? String(opts.pushName) : '';

        // Silencio por derivación a un asesor humano: el bot no interviene.
        if (this.stateService.getSilencioAsesor(jid)) {
            console.log(`[AI] Bot ${this.idCliente}: silencio por derivación a asesor, no interviene`);
            this._setJevRazon(jid, 'silencio por derivación a asesor');
            return false;
        }

        // Gates premium + toggle + cuota + límite (igual que el agente anterior)
        const user = await userService.getUserByIdCliente(this.idCliente).catch(() => null);
        if (!user || user.plan !== 'premium') { this._setJevRazon(jid, 'cuenta no premium'); return false; }
        const cfg = await botConfigService.getBotConfig(this.idCliente);
        this._botType = cfg.bot_type || 'CARRITO';
        this._menuConfig = cfg.menu_config || {};
        this._calendarConfig = cfg.calendar_config || {};
        const ai = cfg.ai_config || {};
        const celularVendedor = this._telefonoVendedor(ai);
        if (!ai.enabled) { this._setJevRazon(jid, 'asistente IA desactivado'); return false; }
        if (this.quotaBlocked) { this._setJevRazon(jid, 'cuota bloqueada'); return false; }
        const used = await aiUsageService.getTokensUsed(this.idCliente, ai.activadoEn);
        if (used >= aiUsageService.LIMIT_TOKENS) { this._setJevRazon(jid, 'límite de tokens alcanzado'); return false; }

        // (Solo desarrollo/pruebas) Al decir "hola" se borra la sesión anterior
        // para poder probar el bot desde cero. Activación: RESET_SESION_AL_SALUDAR=1
        // y NODE_ENV distinto de "production" (en Koyeb jamas se activa).
        if (process.env.RESET_SESION_AL_SALUDAR === '1' &&
            process.env.NODE_ENV !== 'production' &&
            this._esSaludo(text)) {
            this._resetSesion(jid);
            console.log(`[AI] Bot ${this.idCliente}: modo prueba local -> "hola" reinicia la sesión del cliente`);
        }

        const session = this.stateService.getChatSession(jid) || { history: [], nodeId: 'root' };

        // Silencio post-pedido: no interfieramos en la conversación dueño/cliente
        if (this.stateService.getPedidoFinalizado(jid)) {
            console.log(`[AI] Bot ${this.idCliente}: silencio post-pedido activo, no interviene`);
            this._setJevRazon(jid, 'silencio post-pedido');
            return false;
        }
        if (session.derivado) {
            console.log(`[AI] Bot ${this.idCliente}: cliente derivado a vendedor, modo menú`);
            this._setJevRazon(jid, 'cliente derivado a vendedor (modo menú)');
            return false;
        }

        // Flujo especial: el menú ya está esperando un dato/cantidad/archivo/turno.
        // El traductor NO interpreta; el menú procesa el input tal cual.
        const special = this._detectSpecialFlow(jid, text);
        if (special) {
            // En el flujo de turnos (fecha/horario/confirmación) este pasaje al
            // menú es lo esperado: no se emite [Jev][skip].
            if (special === 'turno' && this._jevSkipMuted) this._jevSkipMuted[jid] = true;
            console.log(`[AI] Bot ${this.idCliente}: flujo especial (${special}), pasa directo al menú`);
            this._setJevRazon(jid, `flujo especial (${special})`);
            return false;
        }
        // Estando en "mis turnos" (lista o confirmación) el cliente pidió OTRA
        // cosa: salimos de ese contexto para que la IA/menú puedan responderle
        // sin quedar atrapado.
        if (this.stateService.getMisTurnos(jid)) this.stateService.clearMisTurnos(jid);
        if (this.stateService.getMisTurnoSeleccionado(jid)) this.stateService.clearMisTurnoSeleccionado(jid);

        // Oferta de asesor pendiente ("Te interesa que te pase con un asesor?"):
        // si el cliente confirma, se deriva y asigna al vendedor/asesor; si
        // rechaza o responde otra cosa, se descarta y continúa el flujo normal.
        if (session && session.ofreciendoAsesor && session.ofreciendoAsesor.trigger) {
            if (await this._aceptaOfertaAsesor(text)) {
                const oferta = session.ofreciendoAsesor;
                this.stateService.setChatSession(jid, { ...session, ofreciendoAsesor: null });
                this._setInteres(jid, oferta.trigger, oferta.title || '');
                const motivoOferta = `Consultó el precio de ${oferta.title || oferta.trigger} y no está definido`;
                const derivado = await this._derivarVendedor(sock, jid, pushName, { interes: oferta, motivo: motivoOferta, texto: text });
                if (derivado) {
                    console.log(`[AI] Bot ${this.idCliente}: acepta hablar con asesor -> derivado (${oferta.trigger})`);
                    return { derivado: true };
                }
                // Vendedor no alcanzable: abrimos la ficha consultada igual.
                this.stateService.clearTranslationFails(jid);
                this.stateService.setUserIntent(jid, { trigger: oferta.trigger, cantidad: null });
                console.log(`[AI] Bot ${this.idCliente}: acepta asesor sin vendedor alcanzable -> abre ficha ${oferta.trigger}`);
                return oferta.trigger;
            }
            if (this._rechazaOfertaAsesor(text)) {
                if (this._esNegacionPura(text)) {
                    this.stateService.setChatSession(jid, { ...session, ofreciendoAsesor: null });
                    await this._sendFriendly(sock, jid, '¡No hay problema! ¿Necesitás algo más?');
                    console.log(`[AI] Bot ${this.idCliente}: rechaza hablar con asesor`);
                    return { derivado: true };
                }
                // Rechazo con OTRA intención a cuestas ("no, cuanto cuesta la de
                // las heras"): se descarta la oferta y el flujo normal continúa
                // con esa intención en vez de cortar la respuesta.
                console.log(`[AI] Bot ${this.idCliente}: borra oferta de asesor y continúa con "${text}"`);
                this.stateService.setChatSession(jid, { ...session, ofreciendoAsesor: null });
            }
            // Respuesta que no aborda la oferta: se descarta y sigue el flujo.
            this.stateService.setChatSession(jid, { ...session, ofreciendoAsesor: null });
        }

        // Primer contacto. El asistente SIEMPRE se presenta con el nombre del
        // negocio (para que el cliente sepa que habló al número correcto),
        // igual que lo hace el primer nodo del menú. Diferencia clave:
        //   - Saludo puro ("hola", "buenas"): solo la bienvenida y corta.
        //   - Saludo + intención ("hola, quiero alquilar"): envía la bienvenida
        //     y DESPUÉS continúa el flujo para capturar la intención (navegar a
        //     la sección, agregar al carrito, etc.) en vez de perderla.
        if ((!session.history || session.history.length === 0) && this._esSaludo(text)) {
            const negocio = user.nombreCliente || user.businessName || this.idCliente;
            const bienvenida = `Hola, bienvenido a ${negocio}. ¿En qué puedo ayudarte?`;
            this.stateService.setChatSession(jid, { history: [{ role: 'assistant', content: bienvenida }], nodeId: 'root' });
            await this._sendFriendly(sock, jid, bienvenida);
            if (this._esSaludoPuro(text)) {
                console.log(`[AI] Bot ${this.idCliente}: primer saludo puro "${text}" -> bienvenida con nombre del negocio`);
                return { derivado: true };
            }
            console.log(`[AI] Bot ${this.idCliente}: primer saludo + intención "${text}" -> bienvenida + continúa el flujo`);
        }

        // El MENÚ es el handler y mantiene la posición real del cliente en
        // getUserState(jid) (setUserState lo actualiza en cada navegación).
        // El chat-sesion no se actualiza con el menú, así que SIEMPRE leemos
        // de getUserState para saber en qué pantalla está el cliente.
        const nodeId = this.stateService.getUserState(jid) || session.nodeId || 'root';

        // Navegación por lenguaje natural → trigger directo (sin gastar tokens).
        const navMap = {
            'menu': '0', 'menu principal': '0', 'inicio': '0', 'ir al inicio': '0',
            'mostrar menu': '0', 'mostrame el menu': '0', 'ver menu': '0', 'ver el menu': '0',
            'volver': 'v', 'volver atras': 'v', 'atras': 'v', 'regresar': 'v',
            'pagar': 'p', 'pago': 'p', 'ir a pagar': 'p',
            'vaciar': 'vaciar', 'vaciar carrito': 'vaciar',
            'finalizar': 'p', 'finalizar pedido': 'p',
        };
        // Intención de PEDIR/ENCARGAR: entrar directo al submenú de productos
        // si hay un único brazo navegable (ej. "1. Hace tu pedido").
        const orderMap = {
            'hacer un pedido': 1, 'hacer pedido': 1, 'quiero hacer un pedido': 1,
            'quiero hacer una compra': 1, 'comprar': 1, 'encargar': 1,
            'que tienen': 1, 'que hay': 1, 'que opciones hay': 1, 'opciones': 1,
            'menu de productos': 1,
        };
        const options = await this._opcionesNivel(jid, nodeId);

        const navKey = this._normalizarMatch(text);
        let navTrigger = navMap[navKey];
        if (orderMap[navKey] && this._resolverTriggerPedido(options)) {
            navTrigger = this._resolverTriggerPedido(options);
        } else if (this._navPorFrase(navKey) && this._navPorFrase(navKey) === 'PEDIDO' && this._resolverTriggerPedido(options)) {
            navTrigger = this._resolverTriggerPedido(options);
        } else if (!navTrigger) {
            navTrigger = this._navPorFrase(navKey);
        }
        if (navTrigger && navTrigger !== 'PEDIDO') {
            this.stateService.clearTranslationFails(jid);
            // Intención de compra clara al querer pagar/finalizar con pedido no
            // vacío: el asistente corta el flujo y deriva al vendedor (si hay
            // vendedor configurado). Si no hay vendedor, se comporta normal.
            if (navTrigger === 'p') {
                const ordenNav = this.stateService.getUserOrder(jid) || [];
                if (ordenNav.length > 0) {
                    // Sugerencia de complemento antes de pagar (si aplica).
                    if (await this._sugerirComplementoSiCorresponde(sock, jid)) {
                        console.log(`[AI] Bot ${this.idCliente}: querer pagar "${text}" -> sugerencia de complemento`);
                        return { derivado: true };
                    }
                    const derivado = await this._derivarVendedor(sock, jid, pushName, { motivo: 'Quiere pagar su pedido', texto: text });
                    if (derivado) {
                        console.log(`[AI] Bot ${this.idCliente}: querer pagar "${text}" -> derivación a vendedor`);
                        return { derivado: true };
                    }
                }
            }
            this.stateService.setUserIntent(jid, { trigger: navTrigger, cantidad: this._detectarCantidad(text) });
            console.log(`[AI] Bot ${this.idCliente}: navegación "${text}" -> trigger "${navTrigger}"`);
            return navTrigger;
        }

        // Matching simple primero (rápido, sin costo de tokens si alcanza)

        // Antes de interpretar, si ya hubo fallos consecutivos, derivamos a un humano.
        const failsPrevios = this.stateService.getTranslationFails(jid);
        if (failsPrevios >= MAX_TRANSLATION_FAILS) {
            console.log(`[AI] Bot ${this.idCliente}: bucle detectado (${failsPrevios} fallos), deriva a humano`);
            const ok = await this._derivarVendedor(sock, jid, pushName, { motivo: 'No encontró lo que busca (varios intentos sin éxito)', texto: text });
            this.stateService.clearTranslationFails(jid);
            if (ok) {
                // _derivarVendedor ya envió al cliente el mensaje de derivación
                // (configurable) y avisó al vendedor por WhatsApp.
            }
            return { derivado: true };
        }

        // Multi-pedido: "una muzzarella y una coca" -> intención de compra con
        // varios productos. Si hay vendedor configurado, agregamos todos y
        // derivamos al vendedor (corte de flujo). Si no, mantenemos el flujo en
        // cadena actual (primer ítem + cola para el menú).
        const multi = await this._detectarMultiPedido(jid, text, options);
        // Sin vendedor, el multi-pedido se resuelve determinista (cadena).
        // Con vendedor, la IA (router) decide si es compra o consulta.
        // En bots FAQ/consulta (sinCarrito) no existe multi-pedido de compra.
        if (multi && multi.items.length >= 2 && !this._esFAQ() && !celularVendedor) {
            this.stateService.clearTranslationFails(jid);
            let todosAgregados = true;
            for (const it of multi.items) {
                const ok = await this.menuController.addItemDirect(sock, jid, it.trigger, it.cantidad, { silencioso: true });
                if (!ok) todosAgregados = false;
            }
            if (todosAgregados) {
                const derivado = await this._derivarVendedor(sock, jid, pushName, { motivo: `Quiere comprar ${multi.items.length} productos del menú`, texto: text });
                if (derivado) {
                    console.log(`[AI] Bot ${this.idCliente}: multi-compra "${text}" (${multi.items.length} ítems) -> derivación a vendedor`);
                    return { derivado: true };
                }
            }
            const primero = multi.items[0];
            const resto = multi.items.slice(1).map(it => ({ trigger: it.trigger, cantidad: it.cantidad }));
            this.stateService.setPendingOrderItems(jid, resto);
            this.stateService.setUserIntent(jid, { trigger: primero.trigger, cantidad: primero.cantidad });
            console.log(`[AI] Bot ${this.idCliente}: multi-pedido "${text}" -> ${multi.items.length} ítems, primero trigger "${primero.trigger}", ${resto.length} en cola`);
            return primero.trigger;
        }

        // Petición explícita de hablar con un HUMANO/asesor ("hablar con un
        // asesor", "me pasás con servicio técnico", "quiero un asesor técnico"):
        // ruteo determinista por CATEGORÍA entre los contactos del dashboard,
        // ANTES del matching del menú. Sin esto, una palabra clave de una opción
        // (ej. "hablar" en "quiero hablar con alguien de administracion"
        // coincide con el título "Hablar con asesor administrativo") secuestraba
        // el mensaje hacia la IA y la derivación nunca ocurría.
        // Si la categoría pedida no está configurada, respondemos "No tengo esa
        // opción." y listamos las áreas disponibles. Un pedido GENÉRICO (sin
        // categoría) deriva al primer contacto. Una mera mención de área sin
        // pedido de persona ("servicio tecnico") no matchea ningún marco y el
        // menú sigue navegando con normalidad.
        if (celularVendedor) {
            const fraseArea = this._solicitaAsesor(text);
            if (fraseArea) {
                const { contactos } = this._listarContactosVendedor(ai);
                if (contactos.length > 0) {
                    const contactoMatch = this._matchearCategoria(fraseArea + ' ' + text, contactos);
                    if (contactoMatch) {
                        this.stateService.clearTranslationFails(jid);
                        const derivado = await this._derivarVendedor(sock, jid, pushName, {
                            contacto: contactoMatch,
                            motivo: `Solicita contacto de ${contactoMatch.nombre} (${fraseArea})`,
                            texto: text
                        });
                        if (derivado) {
                            console.log(`[AI] Bot ${this.idCliente}: petición de asesor "${text}" -> contacto "${contactoMatch.nombre}" (categoría matcheada)`);
                            return { derivado: true };
                        }
                        this._setJevRazon(jid, 'petición de asesor: sin contacto alcanzable');
                        return false;
                    }
                    if (!this._esAreaGenerica(fraseArea)) {
                        this.stateService.clearTranslationFails(jid);
                        const areas = this._listaAreasDisponibles(contactos);
                        const lista = areas.length
                            ? '\n' + areas.map(a => `- ${a}`).join('\n')
                            : '';
                        await this._sendFriendly(sock, jid, `No tengo esa opción. Las opciones disponibles son:${lista}`);
                        console.log(`[AI] Bot ${this.idCliente}: petición de asesor "${text}" -> categoría sin contacto: "No tengo esa opción"`);
                        return { derivado: true };
                    }
                    // Petición genérica de asesor sin área: contacto principal.
                    this.stateService.clearTranslationFails(jid);
                    const derivadoGen = await this._derivarVendedor(sock, jid, pushName, {
                        motivo: 'Solicita hablar con un asesor',
                        texto: text
                    });
                    if (derivadoGen) {
                        console.log(`[AI] Bot ${this.idCliente}: petición de asesor genérica "${text}" -> contacto principal`);
                        return { derivado: true };
                    }
                }
            }
        }

        const matchSimple = this._matchOption(text, options);

        // Consulta puntual de PRECIO sobre un ítem de la lista desplegada
        // ("¿cuánto cuesta el primero?", "a cómo el 2", "precio del 3ro"):
        // se resuelve la posición contra las opciones reales del nivel y se
        // responde DIRECTAMENTE el precio, sin abrir la ficha completa ni
        // perder la pregunta objetiva del cliente. No consume tokens.
        const precioPorPosicion = this._resolverPrecioPorPosicion(text, options);
        if (precioPorPosicion) {
            this.stateService.clearTranslationFails(jid);
            this._setInteres(jid, precioPorPosicion.trigger, precioPorPosicion.title || '');
            if (precioPorPosicion.precio !== null) {
                await this._sendFriendly(sock, jid, `El *${precioPorPosicion.title || 'ítem'}* cuesta *$${precioPorPosicion.precio}*.`);
                console.log(`[AI] Bot ${this.idCliente}: precio por posición "${text}" -> ${precioPorPosicion.title || precioPorPosicion.trigger} ($${precioPorPosicion.precio})`);
            } else {
                await this._sendFriendly(sock, jid, `El *${precioPorPosicion.title || 'ítem'}* no tiene precio publicado en mi base por ahora.`);
                console.log(`[AI] Bot ${this.idCliente}: precio por posición "${text}" -> ${precioPorPosicion.title || precioPorPosicion.trigger} (sin precio publicado)`);
            }
            return { derivado: true };
        }

        // Consulta de PRECIO de una ficha SIN precio definido (bot FAQ, ej.
        // inmobiliaria): respondemos determinísticamente "No tengo en mi base de
        // datos esa información." y, si hay asesor configurado en el dashboard,
        // ofrecemos "Te interesa que te pase con un asesor?". No consume tokens
        // ni clasifica con el LLM.
        const precioSinDefinir = await this._manejarPrecioSinDefinir(sock, jid, pushName, text, options, matchSimple, celularVendedor);
        if (precioSinDefinir.handled) return precioSinDefinir.result;

        // Pedido de FOTOS (bot FAQ, ej. inmobiliaria): "tenés fotos?", "pasame
        // fotos de la de las heras", "y las fotos de esa propiedad?". Abre la
        // ficha consultada (que envía sus imágenes por WhatsApp) sin gastar
        // tokens; si no se puede identificar el ítem, sigue el flujo normal.
        if (this._esFAQ() && this._esPeticionFotos(text)) {
            const nodoFotos = await this._resolverNodoFotos(text, options, jid, nodeId);
            if (nodoFotos) {
                this.stateService.clearTranslationFails(jid);
                this._setInteres(jid, String(nodoFotos.trigger), nodoFotos.title || '');
                if (this.menuController && typeof this.menuController.processNode === 'function') {
                    console.log(`[AI] Bot ${this.idCliente}: fotos "${text}" -> abre "${nodoFotos.trigger}" (nodo ${nodoFotos.id}, envía sus imágenes)`);
                    await this.menuController.processNode(sock, jid, nodoFotos);
                    return { derivado: true };
                }
                console.log(`[AI] Bot ${this.idCliente}: fotos "${text}" -> navega a "${nodoFotos.trigger}"`);
                return String(nodoFotos.trigger);
            }
        }

        if (matchSimple) {
            this.stateService.clearTranslationFails(jid);
            const opt = options.find(o => o.trigger === matchSimple);
            const esSeccion = await this._esSeccionCatalogo(jid, matchSimple);

            // El cliente ya nombró una SECCIÓN del catálogo (ej. "alquileres"):
            // desplegamos directamente su lista, sin gastar tokens ni derivar,
            // tanto con como sin vendedor. Es "ir a lo que ya pidió ver".
            if (esSeccion) {
                this._setInteres(jid, matchSimple, opt ? opt.title : '');
                this.stateService.setUserIntent(jid, { trigger: matchSimple, cantidad: null });
                console.log(`[AI] Bot ${this.idCliente}: sección "${text}" -> despliega "${matchSimple}" (${opt ? opt.title : ''})`);
                return matchSimple;
            }

            if (!celularVendedor) {
                // Sin vendedor: no hay derivación posible; el menú agrega normalmente.
                this._setInteres(jid, matchSimple, opt ? opt.title : '');
                this.stateService.setUserIntent(jid, { trigger: matchSimple, cantidad: this._detectarCantidad(text) });
                console.log(`[AI] Bot ${this.idCliente}: match simple "${text}" -> trigger "${matchSimple}" (sin vendedor)`);
                return matchSimple;
            }

            // Interés EXPLÍCITO sobre una ficha concreta ("me interesa la de las
            // heras", "me gusta X"): no es una consulta genérica ni una compra de
            // carrito. Con FAQ + vendedor, abrimos la ficha (fotos + descripción)
            // y luego derivamos al vendedor señalándole esa propiedad. Sin FAQ,
            // es una compra/contacto que se resuelve con el clasificador normal.
            if (this._esInteresExplicito(text)) {
                this._setInteres(jid, matchSimple, opt ? opt.title : '');
                if (this._esFAQ() && this.menuController && typeof this.menuController.handleIncomingMessage === 'function') {
                    try {
                        await this.menuController.handleIncomingMessage(sock, jid, matchSimple);
                    } catch (err) {
                        console.error(`[AI] Error abriendo ficha "${matchSimple}":`, err.message);
                    }
                    const derivado = await this._derivarVendedor(sock, jid, pushName, { interes: { trigger: matchSimple, title: opt ? opt.title : '' }, motivo: `Interés explícito en ${opt ? opt.title : matchSimple}`, texto: text });
                    if (derivado) {
                        this.stateService.clearTranslationFails(jid);
                        console.log(`[AI] Bot ${this.idCliente}: interés explícito "${text}" sobre "${matchSimple}" (${opt ? opt.title : ''}) -> abre ficha y deriva a vendedor`);
                        return { derivado: true };
                    }
                    // Vendedor no alcanzable: al menos mostramos la ficha.
                    this.stateService.clearTranslationFails(jid);
                    this.stateService.setUserIntent(jid, { trigger: matchSimple, cantidad: 1 });
                    return matchSimple;
                }
                this.stateService.clearTranslationFails(jid);
                this.stateService.setUserIntent(jid, { trigger: matchSimple, cantidad: 1 });
                console.log(`[AI] Bot ${this.idCliente}: interés explícito "${text}" sobre "${matchSimple}" (${opt ? opt.title : ''}) -> abre la ficha`);
                return matchSimple;
            }

            // Con vendedor: la determinación consulta-vs-compra la toma la IA.
            const cls = await this._clasificarConLaIA(user, ai, jid, text);
            if (!cls) {
                // Sin certeza (FALLO/error/cuota): seguro, el menú responde normal y NO deriva.
                console.log(`[AI] Bot ${this.idCliente}: match simple "${text}" -> IA sin certeza, menú normal (sin derivar)`);
                this._setJevRazon(jid, 'match simple: Jev sin certeza');
                return false;
            }
            if (this._esConsulta(cls.intencion) && !(cls.items && cls.items.length)) {
                // Consulta: se responde conversacional, sin agregar al carrito ni derivar.
                this._setInteres(jid, matchSimple, opt ? opt.title : '');
                const texto = cls.respuesta_conversacional || '¡Claro! ¿En qué puedo ayudarte con eso?';
                await this._sendFriendly(sock, jid, texto);
                console.log(`[AI] Bot ${this.idCliente}: consulta "${text}" -> respuesta IA (sin derivar, intención ${cls.intencion})`);
                return { derivado: true };
            }
            // Compra/acción: delega al procesador (agrega silencioso + deriva si corresponde).
            const res = await this._procesarIntencion(sock, jid, pushName, cls);
            if (res === 'FALLO') { this._setJevRazon(jid, 'procesar intención FALLO (match simple)'); return false; }
            if (typeof res === 'string') {
                this.stateService.clearTranslationFails(jid);
                console.log(`[AI] Bot ${this.idCliente}: match simple "${text}" (con vendedor) -> intención "${cls.intencion}" -> trigger "${res}"`);
                return res;
            }
            this.stateService.clearTranslationFails(jid);
            return res;
        }

        // Petición deíctica de "ver el listado" ("mostrame cuales tenes", "dame
        // las opciones", "que opciones hay"): si el cliente estuvo consultando
        // una sección del menú (interes), navegamos ahí para que el menú muestre
        // sus opciones reales. Sin tokens y sin derivar (solo navegación).
        // También manejamos afirmaciones simples ("si", "dale", "ok") cuando el
        // asistente ofreció mostrar el listado (ej. "¿Le muestro las propiedades?").
        //
        // EXCEPCIÓN: si el mensaje NOMBRA una opción del nivel actual (ej. "y para
        // alquilar qué tenés?" → Alquileres), NO lo resolvemos con el último tema
        // visto: lo dejamos pasar para que lo decida Jev, que además considera la
        // función declarada de cada opción. Si no, navegaría al tema anterior.
        const opcionNombrada = this._seccionMencionada(text, options);
        if (!opcionNombrada && (this._esPeticionListado(text) || this._esAfirmacion(text))) {
            const sesion = this.stateService.getChatSession(jid) || {};
            const interes = sesion.interes;
            if (interes && interes.trigger) {
                const triggerValido = options.some(o => o.trigger === interes.trigger);
                if (triggerValido) {
                    this.stateService.clearTranslationFails(jid);
                    this.stateService.setUserIntent(jid, { trigger: interes.trigger, cantidad: null });
                    console.log(`[AI] Bot ${this.idCliente}: petición de listado/afirmación "${text}" -> navega a "${interes.trigger}" (${interes.title})`);
                    return interes.trigger;
                }
            }
        }

        // Interés deíctico sobre la última ficha/ítem visto ("me interesa", "me
        // gusta esa", "quiero esa"): el cliente se refiere a la propiedad que
        // acaba de ver en pantalla. Si hay vendedor configurado, es intención de
        // compra/contacto clara y se deriva; si no, se re-abre la ficha.
        const sesionInteres = this.stateService.getChatSession(jid) || {};
        const ultimoInteres = sesionInteres.interes || null;
        if (this._esDeicticoInteres(text) && ultimoInteres && ultimoInteres.trigger) {
            const trigInteres = String(ultimoInteres.trigger);
            const esSeccionInteres = await this._esSeccionCatalogo(jid, trigInteres);
            const esOpcionInteres = options.some(o => String(o.trigger).toLowerCase() === trigInteres.toLowerCase());
            // Si el cliente está viendo la ficha (el estado ya avanzó a ese nodo,
            // que es una hoja sin más opciones en el nivel actual), "me interesa"
            // se refiere a la propiedad que está en pantalla. Sin esto, con el
            // nivel actual ya agotado el bloque se saltaba y caía al clasificador.
            const nodoEstado = await this._getNodeById(this.stateService.getUserState(jid) || 'root').catch(() => null);
            const esLaFichaActual = !!(nodoEstado && String(nodoEstado.trigger) === trigInteres);
            if (esSeccionInteres || esOpcionInteres || esLaFichaActual) {
                // Si el último tema era una SECCIÓN, sigue siendo exploración:
                // navegamos a ella (igual que el bloque de listado/afirmación).
                if (esSeccionInteres) {
                    this.stateService.clearTranslationFails(jid);
                    this._setInteres(jid, trigInteres, ultimoInteres.title || '');
                    this.stateService.setUserIntent(jid, { trigger: trigInteres, cantidad: null });
                    console.log(`[AI] Bot ${this.idCliente}: interés deíctico "${text}" sobre SECCIÓN "${trigInteres}" -> navega`);
                    return trigInteres;
                }
                // Ficha/ítem concreto: intención de interés clara sobre esa opción.
                if (!celularVendedor) {
                    // Sin vendedor: re-abrimos la ficha; el menú la muestra completa.
                    this.stateService.clearTranslationFails(jid);
                    this._setInteres(jid, trigInteres, ultimoInteres.title || '');
                    this.stateService.setUserIntent(jid, { trigger: trigInteres, cantidad: 1 });
                    console.log(`[AI] Bot ${this.idCliente}: interés deíctico "${text}" sobre ficha "${trigInteres}" (${ultimoInteres.title}) -> abre la ficha`);
                    return trigInteres;
                }
                // Sin carrito (FAQ/TURNOS): derivamos al vendedor señalándole la
                // propiedad/ítem de interés.
                if (this._esSinCarrito()) {
                    const motivoDeictico = `Interés en ${ultimoInteres.title || trigInteres}`;
                    const derivado = await this._derivarVendedor(sock, jid, pushName, { interes: ultimoInteres, motivo: motivoDeictico, texto: text });
                    if (derivado) {
                        console.log(`[AI] Bot ${this.idCliente}: interés deíctico (${this._botType}) "${text}" sobre "${trigInteres}" -> deriva a vendedor`);
                        return { derivado: true };
                    }
                    // Sin vendedor alcanzable: abrimos la ficha.
                    this.stateService.clearTranslationFails(jid);
                    this._setInteres(jid, trigInteres, ultimoInteres.title || '');
                    this.stateService.setUserIntent(jid, { trigger: trigInteres, cantidad: 1 });
                    return trigInteres;
                }
                // CARRITO: agrega la ficha al pedido y deriva (o muestra resumen).
                const clsCompra = {
                    intencion: 'AGREGAR_AL_CARRITO',
                    items: [{ trigger: trigInteres, cantidad: 1 }],
                    respuesta_conversacional: '¡Genial, te lo agrego!'
                };
                const resCompra = await this._procesarIntencion(sock, jid, pushName, clsCompra);
                if (resCompra && resCompra !== 'FALLO') {
                    this.stateService.clearTranslationFails(jid);
                    console.log(`[AI] Bot ${this.idCliente}: interés deíctico "${text}" sobre "${trigInteres}" -> compra/derivación`);
                    return resCompra;
                }
                // Si el procesador falló, abrimos la ficha igual.
                this.stateService.clearTranslationFails(jid);
                this._setInteres(jid, trigInteres, ultimoInteres.title || '');
                this.stateService.setUserIntent(jid, { trigger: trigInteres, cantidad: 1 });
                return trigInteres;
            }
        }

        // El cliente ya tiene productos en el pedido y la negación indica que
        // no quiere seguir agregando ("no listo", "no quiero nada más", "ya está",
        // etc.): pasamos directo a pagar sin interpretar con el LLM (sin gastar
        // tokens y sin riesgo de que la IA malinterprete y vuelva al inicio).
        const orderActual = this.stateService.getUserOrder(jid) || [];
        if (!this._esFAQ() && orderActual.length > 0 && /(?:^|\s)(?:no\s*(?:estoy\s*)?(?:listo|ya\s*est[aá]|quier(?:o|és)?\s*nada\s*m[aá]s|puedo\s*agregar\s*m[aá]s)|ya\s+est[aá]\b|eso\s+(?:ser[ií]a|es)\s+todo|no\s+quiero\s+nada\s*m[aá]s)/i.test(text)) {
            // Confirmar/cerrar pedido = intención de compra clara: si corresponde,
            // primero sugerimos un complemento (antes de derivar/finalizar).
            if (await this._sugerirComplementoSiCorresponde(sock, jid)) {
                console.log(`[AI] Bot ${this.idCliente}: confirmar pedido "${text}" -> sugerencia de complemento`);
                return { derivado: true };
            }
            // Si hay vendedor configurado, el asistente corta el flujo y deriva.
            const derivado = await this._derivarVendedor(sock, jid, pushName, { motivo: 'Quiere confirmar/cerrar su pedido', texto: text });
            if (derivado) {
                console.log(`[AI] Bot ${this.idCliente}: confirmar pedido "${text}" -> derivación a vendedor`);
                return { derivado: true };
            }
            const trig = this._navPorFrase(this._normalizarMatch('pagar')) || 'p';
            this.stateService.clearTranslationFails(jid);
            this.stateService.setUserIntent(jid, { trigger: trig, cantidad: null });
            console.log(`[AI] Bot ${this.idCliente}: negación de seguir agregando con pedido no vacío "${text}" -> trigger "${trig}"`);
            return trig;
        }

        

        // Fallback: motor conversacional híbrido (clasificación de intenciones +
        // tool calling). El LLM clasifica y el router despacha al motor determinista.
        // Loop de navegación: si el LLM usa NAVEGAR_A, re-clasificamos con el nuevo contexto.
        try {
            if (this.quotaBlocked) { this._setJevRazon(jid, 'cuota bloqueada (fallback)'); return false; }

            let clasificacion = await this._clasificarConLaIA(user, ai, jid, text);

            // Loop de navegación invisible (máx 3 vueltas)
            for (let vuelta = 0; vuelta < 3; vuelta++) {
                // Safety net: si el LLM clasificó como AGREGAR_AL_CARRITO pero el
                // mensaje es claramente una pregunta/negación, forzamos CONSULTAR_MENU
                if (clasificacion && clasificacion.intencion === 'AGREGAR_AL_CARRITO' && this._esConsultaImplicita(text)) {
                    console.log(`[AI] Bot ${this.idCliente}: safety net "${text}" -> AGREGAR_AL_CARRITO forzado a CONSULTAR_MENU`);
                    clasificacion.intencion = 'CONSULTAR_MENU';
                    clasificacion.items = [];
                }
                if (this._esPeticionHorarios(text) && !(clasificacion.items || []).length &&
                    (clasificacion.intencion === 'CONSULTAR_HORARIOS' || clasificacion.intencion === 'CHARLA_GENERAL')) {
                    const ref = this._seccionMencionada(text, options);
                    if (ref) {
                        clasificacion.items = [{ trigger: ref, cantidad: 1 }];
                        console.log(`[AI] Bot ${this.idCliente}: mensaje compuesto "${text}" -> ítem "${ref}"`);
                    }
                }
                if (!clasificacion || clasificacion.intencion === 'FALLO') {
                    break; // sale al fallback final
                }

                const res = await this._procesarIntencion(sock, jid, pushName, clasificacion);
                if (res === 'FALLO') {
                    this._setJevRazon(jid, 'procesar intención FALLO (fallback)');
                    return false;
                }
                if (typeof res === 'string') {
                    // NAVEGAR_A devolvió un trigger: re-clasificamos con NUEVO contexto
                    if (clasificacion.intencion === 'NAVEGAR_A') {
                        this.stateService.clearTranslationFails(jid);
                        console.log(`[AI] Bot ${this.idCliente}: navegación a "${res}" -> re-clasificando`);
                        // El menú ya navegó internamente; actualizamos options y re-clasificamos
                        const newNodeId = this.stateService.getUserState(jid) || 'root';
                        options.splice(0, options.length, ...await this._opcionesNivel(jid, newNodeId).catch(() => []));
                        clasificacion = await this._clasificarConLaIA(user, ai, jid, text);
                        continue; // siguiente vuelta del loop con contexto fresco
                    }
                    // Otros triggers (sección, ficha, pagar, etc.): delegamos al menú
                    this.stateService.clearTranslationFails(jid);
                    console.log(`[AI] Bot ${this.idCliente}: intención "${clasificacion.intencion}" -> trigger "${res}"`);
                    return res;
                }
                // { derivado: true } -> el router ya respondió/ejecutó
                this.stateService.clearTranslationFails(jid);
                return res;
            }
        } catch (err) {
            console.error(`[AI] Error en router de intenciones ${this.idCliente}:`, err.message);
            if (err && err.isQuotaExceeded) {
                this.quotaBlocked = true;
                console.warn(`[AI] Bot ${this.idCliente}: router bloqueado por cuota (menú directo)`);
                this._setJevRazon(jid, 'cuota excedida (router)');
                return false;
            }
        }

        // No hay coincidencia tras navegación o fallo: menú re-muestra opciones.
        const fails = this.stateService.incrementTranslationFails(jid);
        console.log(`[AI] Bot ${this.idCliente}: sin coincidencia (fallo ${fails}/${MAX_TRANSLATION_FAILS})`);
        this._setJevRazon(jid, 'sin coincidencia tras clasificación');
        return false;
    }

    /**
     * Construye la sección actual del menú para que el traductor la lea
     * (mensaje + opciones del nivel, sin IDs).
     */
    async _buildSeccion2(jid, nodeId) {
        const node = await this._getNodeById(nodeId);
        const children = await this._getChildren(nodeId);
        const order = this.stateService.getUserOrder(jid) || [];

        let text = '';
        if (node && node.message) {
            const mensaje = this._limpiarTags(node.message);
            if (mensaje) text += `MENSAJE DE ESTA PANTALLA:\n${mensaje}\n\n`;
        } else if (nodeId === 'root') {
            text += `MENSAJE DE ESTA PANTALLA:\nHola, bienvenido.\n\n`;
        }

        const options = await this._opcionesNivel(jid, nodeId);
        if (options.length > 0) {
            text += `OPCIONES DISPONIBLES (formato trigger → nombre [precio]):\n`;
            options.forEach(o => {
                text += `- ${o.trigger} → ${o.title}${o.price ? ` ($${o.price})` : ''}\n`;
            });
        }
        if (children.length === 0 && options.length === 0) {
            text += `(no hay opciones en este nivel)\n`;
        }

        if (order && order.length > 0) {
            let total = 0;
            const lines = order.map(it => {
                const sub = (it.price || 0) * (it.quantity || 1);
                total += sub;
                return `- ${it.quantity} x ${it.text}` + (it.price ? ` ($${sub})` : '');
            });
            text += `\nPEDIDO DEL CLIENTE:\n${lines.join('\n')}\nTOTAL A PAGAR: $${total}\n`;
        }

        return text || '(sección vacía)';
    }

    /**
     * Catálogo real de productos del nivel actual para el router de intenciones.
     * Devuelve [{trigger, title, price}] filtrado (sin pasos de checkout, sin
     * no-disponibles). Es la única base de datos de productos que el LLM puede
     * referenciar (anti-alucinación).
     */
    async _buildCatalogo(jid) {
        const nodeId = this.stateService.getUserState(jid) || 'root';
        return await this._opcionesNivel(jid, nodeId).catch(() => []);
    }

    /**
     * Contexto adicional (pedido actual + posición + navegación) para el router de intenciones.
     * El LLM puede usar NAVEGAR_A para moverse silenciosamente en la jerarquía del menú.
     */
    async _buildContexto(jid) {
        const nodeId = this.stateService.getUserState(jid) || 'root';
        const nodoActual = await this._getNodeById(nodeId).catch(() => null);
        const sesion = this.stateService.getChatSession(jid) || {};

        // Construir estructura de navegación
        const nav = await this._construirNavContexto(nodeId, nodoActual);

        let contexto = `NODO ACTUAL: ${nodeId} (${nodoActual?.title || 'sin título'})\n`;
        contexto += `TRIGGER ACTUAL: ${nodoActual?.trigger || 'root'}\n`;
        contexto += `MENSAJE ACTUAL: ${nodoActual?.message ? String(nodoActual.message).slice(0, 200) : '(sin mensaje)'}\n`;
        contexto += `OPCIONES DISPONIBLES: ${nav.actualChildren.map(c => `${c.trigger}→${c.title}`).join(', ') || '(ninguna)'}\n`;
        if (nav.padre) {
            contexto += `PADRE: ${nav.padre.id} (${nav.padre.title}) [trigger: ${nav.padre.trigger}]\n`;
            contexto += `HERMANOS: ${nav.hermanos.map(h => `${h.trigger}→${h.title}`).join(', ') || '(ninguno)'}\n`;
        }
        contexto += `RAÍZ: ${nav.raiz.id} (${nav.raiz.title}) [trigger: ${nav.raiz.trigger}]\n`;
        contexto += `RUTA: ${nav.ruta.join(' > ')}\n`;

        if (sesion.interes && sesion.interes.trigger) {
            contexto += `ÚLTIMO TEMA: ${sesion.interes.title || sesion.interes.trigger} (trigger "${sesion.interes.trigger}")\n`;
        }
        const order = this.stateService.getUserOrder(jid) || [];
        if (order && order.length > 0) {
            let total = 0;
            const lines = order.map(it => {
                const sub = (it.price || 0) * (it.quantity || 1);
                total += sub;
                return `- ${it.quantity} x ${it.text}` + (it.price ? ` ($${sub})` : '');
            });
            contexto += `PEDIDO ACTUAL:\n${lines.join('\n')}\nTOTAL: $${total}\n`;
        } else {
            contexto += `(sin pedido en curso)\n`;
        }

        // Contactos de derivación con áreas y palabras clave (para LLM)
        const cfg = await botConfigService.getBotConfig(this.idCliente).catch(() => ({}));
        const ai = (cfg && cfg.ai_config) || {};
        const { contactos } = this._listarContactosVendedor(ai);
        if (contactos && contactos.length > 0) {
            contexto += `CONTACTOS DE DERIVACIÓN:\n`;
            for (const c of contactos) {
                const areas = String(c.areas || '').split(/[,;\n]+/).map(s => s.trim()).filter(Boolean).join(', ');
                const keys = String(c.palabrasClave || '').split(/[,;\n]+/).map(s => s.trim()).filter(Boolean).join(', ');
                contexto += `- ${c.nombre} [trigger: ${c.id}]: áreas=[${areas || '—'}], keywords=[${keys || '—'}]\n`;
            }
        }
        return contexto;
    }

    /**
     * Construye el contexto de navegación (padre, hermanos, raíz, ruta) para un nodo.
     */
    async _construirNavContexto(nodeId, nodoActual) {
        const raiz = await this._getNodeById('root').catch(() => ({ id: 'root', title: 'Inicio', trigger: '0', children: [] }));
        let padre = null;
        let hermanos = [];
        let ruta = [raiz.title || 'Inicio'];

        if (nodoActual && nodoActual.parentId && nodoActual.parentId !== 'root') {
            padre = await this._getNodeById(nodoActual.parentId).catch(() => null);
            if (padre) {
                ruta.push(padre.title);
                hermanos = await this._getChildren(padre.id).catch(() => []);
            }
        } else if (nodoActual && nodoActual.parentId === 'root') {
            padre = raiz;
            hermanos = await this._getChildren('root').catch(() => []);
        }

        if (nodoActual) {
            ruta.push(nodoActual.title);
        }

        const actualChildren = await this._getChildren(nodeId).catch(() => []);

        return {
            actual: nodoActual || { id: nodeId, title: '', trigger: '', children: [] },
            actualChildren,
            padre,
            hermanos,
            raiz,
            ruta
        };
    }

    /**
     * Procesa una intención ya clasificada contra el motor determinista.
     * Ejecuta las acciones reales (agregar/quitar al carrito, mostrar menú,
     * ver carrito, finalizar) y envía la respuesta, devolviendo:
     *   - { derivado: true }   si ya respondió/ejecutó todo (app.js hace continue)
     *   - un trigger (string)  si debe delegar al menú para terminar la acción
     */
    async _procesarIntencion(sock, jid, pushName, clasificacion) {
        const intencion = clasificacion.intencion;
        const items = clasificacion.items || [];
        const respuesta = clasificacion.respuesta_conversacional || '';

        try {
            switch (intencion) {
                case 'AGREGAR_AL_CARRITO': {
                    if (!items.length) {
                        // El LLM detectó intención de agregar pero sin producto claro:
                        // no debería ocurrir si la clasificación fue correcta. Pedimos
                        // el producto sin mostrar el menú (evita el "coletazo").
                        await this._sendFriendly(sock, jid, respuesta || '¿Qué producto querés? Decímelo y te lo busco.');
                        return { derivado: true };
                    }
                    // Anti-error: si el LLM marcó una SECCIÓN como "agregar al
                    // carrito" (ej. "quiero alquilar" -> sección "Alquileres"),
                    // el cliente quiere EXPLORAR esa sección, no comprarla como
                    // si fuera un producto vendible. Navegamos a ella.
                    const trigPrimero = String(items[0].trigger || '').trim();
                    const scopePrimero = items[0].scope || 'actual';
                    // Navegación CRUZADA decidida por Jev: el producto/sección
                    // pedido está en OTRO nivel del menú; navegamos allí en vez
                    // de intentar agregar (sin carrito aplica igual: abre la ficha).
                    if (scopePrimero !== 'actual' && trigPrimero) {
                        const nodoDestino = await this._resolverNodoPorCandidato(jid, scopePrimero, trigPrimero, items[0].nodeId);
                        if (nodoDestino) {
                            this.stateService.clearTranslationFails(jid);
                            this._setInteres(jid, trigPrimero, nodoDestino.title || '');
                            console.log(`[Jev] ${this.idCliente}: compra sobre ítem de OTRO nivel "${trigPrimero}" (${scopePrimero}) -> navega (no agrega)`);
                            await this.menuController.processNode(sock, jid, nodoDestino);
                            return { derivado: true };
                        }
                    }
                    if (trigPrimero && await this._esSeccionCatalogo(jid, trigPrimero)) {
                        this.stateService.clearTranslationFails(jid);
                        this._setInteres(jid, trigPrimero, '');
                        console.log(`[AI] Bot ${this.idCliente}: intención compra sobre SECCIÓN "${items[0].trigger}" -> navega (no agrega al carrito)`);
                        return trigPrimero;
                    }
                    // FAQ/consulta: NO existe carrito. El ítem (ficha/propiedad) se
                    // abre como información completa (fotos + descripción) para que
                    // el cliente consulte, jamás se agrega a un pedido.
                    if (this._esSinCarrito()) {
                        this.stateService.clearTranslationFails(jid);
                        this._setInteres(jid, trigPrimero, '');
                        console.log(`[AI] Bot ${this.idCliente}: intención de compra (${this._botType}) "${items[0].trigger}" -> abre la ficha, sin carrito`);
                        return trigPrimero;
                    }
                    // Intención de compra concreta: el cliente pidió UN producto o
                    // servicio específico. El asistente detecta la intención y, como
                    // EXCEPCIÓN, corta el flujo y deriva al vendedor real sin recorrer
                    // todos los pasos del menú (avisando antes al vendedor por WhatsApp).
                    // Agregamos los ítems al carrito una única vez: así el vendedor ve
                    // exactamente qué pidió el cliente en el aviso de derivación.
                    const resultado = [];
                    for (const it of items) {
                        const ok = await this.menuController.addItemDirect(sock, jid, it.trigger, it.cantidad, { silencioso: true });
                        resultado.push({ trigger: it.trigger, ok });
                    }
                    const derivadoCompra = await this._derivarVendedor(sock, jid, pushName, { motivo: `Quiere comprar ${items.length} producto(s) del menú` });
                    if (derivadoCompra) {
                        // _derivarVendedor ya avisó al vendedor (con el pedido actual,
                        // que incluye el producto) y mostró al cliente el mensaje de
                        // derivación configurado. Corta la conversación IA.
                        return { derivado: true };
                    }
                    // Sin vendedor configurado: mostramos el resumen normal del pedido.
                    if (resultado.some(r => r.ok)) {
                        const orden = this.stateService.getUserOrder(jid) || [];
                        let total = 0;
                        const lineas = orden.map(it => {
                            const sub = (it.price || 0) * (it.quantity || 1);
                            total += sub;
                            return `- ${it.text}${it.price ? ` ($${sub})` : ''}`;
                        });
                        await this._sendFriendly(sock, jid,
                            `Tu pedido por ahora:\n${lineas.join('\n')}\n💰 Total: $${total}\n\n¿Querés sumar algo más? Decime el producto, o escribí "nada más" / "listo" para pasar a pagar.`);
                    } else if (respuesta) {
                        await this._sendFriendly(sock, jid, respuesta);
                    }
                    return { derivado: true };
                }

                case 'QUITAR_DEL_CARRITO': {
                    // Bots sin carrito (FAQ/TURNOS): no hay cartón; solo se consultan fichas.
                    if (this._esSinCarrito()) {
                        await this._sendFriendly(sock, jid, 'En esta cuenta no hay un carrito de compras: soy un asistente de consultas. ¿Sobre qué propiedad querés saber más?');
                        return { derivado: true };
                    }
                    if (!items.length) {
                        await this._sendFriendly(sock, jid, respuesta || '¿Qué producto querés quitar del pedido?');
                        return { derivado: true };
                    }
                    // Navegación CRUZADA: el ítem a quitar está en OTRO nivel del
                    // menú (decidido por Jev). En lugar de quitar algo que no está
                    // en este nivel, navegamos para mostrar de qué se habla.
                    const trigQuitar = String(items[0].trigger || '').trim();
                    const scopeQuitar = items[0].scope || 'actual';
                    if (scopeQuitar !== 'actual' && trigQuitar) {
                        const nodoDestino = await this._resolverNodoPorCandidato(jid, scopeQuitar, trigQuitar, items[0].nodeId);
                        if (nodoDestino) {
                            this.stateService.clearTranslationFails(jid);
                            this._setInteres(jid, trigQuitar, nodoDestino.title || '');
                            console.log(`[Jev] ${this.idCliente}: quitar sobre ítem de OTRO nivel "${trigQuitar}" (${scopeQuitar}) -> navega`);
                            await this.menuController.processNode(sock, jid, nodoDestino);
                            return { derivado: true };
                        }
                    }
                    let quitado = false;
                    for (const it of items) {
                        const ok = await this.menuController.removeItemDirect(sock, jid, it.trigger, it.cantidad);
                        if (ok) quitado = true;
                    }
                    if (quitado) {
                        const orden = this.stateService.getUserOrder(jid) || [];
                        if (orden.length === 0) {
                            await this._sendFriendly(sock, jid, 'Tu pedido quedó vacío. ¿Querés agregar algo más?');
                        } else {
                            let total = 0;
                            const lineas = orden.map(it => {
                                const sub = (it.price || 0) * (it.quantity || 1);
                                total += sub;
                                return `- ${it.text}${it.price ? ` ($${sub})` : ''}`;
                            });
                            await this._sendFriendly(sock, jid,
                                `Tu pedido quedó así:\n${lineas.join('\n')}\n💰 Total: $${total}\n\n¿Querés sumar algo más?`);
                        }
                    } else if (respuesta) {
                        await this._sendFriendly(sock, jid, respuesta);
                    }
                    return { derivado: true };
                }

                case 'VER_CARRITO': {
                    // Bots sin carrito (FAQ/TURNOS): no hay pedido; remitimos al catálogo/consultas.
                    if (this._esSinCarrito()) {
                        await this._sendFriendly(sock, jid, 'No tenés ningún pedido: en esta cuenta solo hay consultas sobre el catálogo. ¿Qué te gustaría ver?');
                        return { derivado: true };
                    }
                    const orden = this.stateService.getUserOrder(jid) || [];
                    if (orden.length === 0) {
                        await this._sendFriendly(sock, jid, 'Todavía no tenés nada en tu pedido. ¿Qué te gustaría agregar?');
                        return { derivado: true };
                    }
                    let total = 0;
                    const lineas = orden.map(it => {
                        const sub = (it.price || 0) * (it.quantity || 1);
                        total += sub;
                        return `- ${it.text}${it.price ? ` ($${sub})` : ''}`;
                    });
                    await this._sendFriendly(sock, jid, `Tu pedido:\n${lineas.join('\n')}\n💰 Total: $${total}\n\n¿Querés sumar algo más?`);
                    return { derivado: true };
                }

                case 'CONSULTAR_MENU': {
                    // Delegamos al menú para que re-muestre las opciones reales del nivel actual.
                    const nodeId = this.stateService.getUserState(jid) || 'root';
                    // Si la clasificación indicó una SECCIÓN concreta del catálogo
                    // (ej. "quiero alquilar" -> sección "Alquileres"), navegamos a
                    // ella directamente en vez de re-mostrar el menú raíz.
                    const trigConsulta = (items && items.length > 0) ? String(items[0].trigger || '').trim() : '';
                    const scopeConsulta = (items && items[0]) ? (items[0].scope || 'actual') : 'actual';
                    // "Mis turnos" (bots de TURNOS): Jev eligió la opción especial.
                    // No es un nodo de la tabla; se resuelve con el input 'm', que el
                    // menú atiende desde cualquier nivel (menuController).
                    if (this._botType === 'TURNOS' && trigConsulta.toLowerCase() === 'm') {
                        this.stateService.clearTranslationFails(jid);
                        console.log(`[Jev] ${this.idCliente}: "mis turnos" (Jev) -> abre mis turnos`);
                        return 'm';
                    }
                    // Navegación CRUZADA decidida por Jev (segunda decisión `nodo`):
                    // el destino está en OTRO nivel del menú (sección raíz o hermana).
                    // handleIncomingMessage solo matchea hijos del nivel actual, así
                    // que resolvemos el nodo completo y navegamos con processNode.
                    if (scopeConsulta !== 'actual' && trigConsulta) {
                        const nodoDestino = await this._resolverNodoPorCandidato(jid, scopeConsulta, trigConsulta, items[0].nodeId);
                        if (nodoDestino) {
                            this.stateService.clearTranslationFails(jid);
                            this._setInteres(jid, trigConsulta, nodoDestino.title || '');
                            console.log(`[Jev] ${this.idCliente}: consulta de sección "${trigConsulta}" (${scopeConsulta}) -> navega directo`);
                            await this.menuController.processNode(sock, jid, nodoDestino);
                            return { derivado: true };
                        }
                    }
                    if (trigConsulta && await this._esSeccionCatalogo(jid, trigConsulta)) {
                        this.stateService.clearTranslationFails(jid);
                        this._setInteres(jid, trigConsulta, '');
                        console.log(`[AI] Bot ${this.idCliente}: consulta de SECCIÓN "${items[0].trigger}" -> navega`);
                        return trigConsulta;
                    }
                    // Sin carrito (FAQ/TURNOS): si el ítem pedido es una ficha del nivel
                    // actual (no una sección), abrimos la ficha completa (fotos +
                    // descripción, o el flujo del servicio) en vez de re-mostrar el
                    // listado.
                    if (this._esSinCarrito() && trigConsulta) {
                        const nivelId = this.stateService.getUserState(jid) || 'root';
                        const opcionesNivel = await this._opcionesNivel(jid, nivelId).catch(() => []);
                        const existeFicha = opcionesNivel.some(o => String(o.trigger).toLowerCase() === trigConsulta.toLowerCase());
                        if (existeFicha) {
                            this.stateService.clearTranslationFails(jid);
                            this._setInteres(jid, trigConsulta, '');
                            console.log(`[AI] Bot ${this.idCliente}: consulta de FICHA (FAQ) "${items[0].trigger}" -> abre la ficha`);
                            return trigConsulta;
                        }
                    }
                    if (this.menuController && typeof this.menuController.sendMenu === 'function') {
                        await this.menuController.sendMenu(sock, jid, nodeId);
                    }
                    return { derivado: true };
                }

                case 'FINALIZAR_PEDIDO': {
                    // Bots sin carrito (FAQ/TURNOS): no hay pedidos ni pago; respondemos como consulta.
                    if (this._esSinCarrito()) {
                        await this._sendFriendly(sock, jid, 'Acá no hay un carrito ni pago: soy un asistente de consultas sobre el catálogo. ¿En qué más puedo ayudarte?');
                        return { derivado: true };
                    }
                    const order = this.stateService.getUserOrder(jid) || [];
                    if (order.length === 0) {
                        const menuTrigger = this._navPorFrase(this._normalizarMatch('menu')) || '0';
                        await this._sendFriendly(sock, jid, 'Todavía no tenés productos en tu pedido. ¿Querés ver el menú para elegir algo?');
                        return menuTrigger;
                    }
                    // Sugerencia de complemento antes de pagar (solo con IA activa
                    // y checkbox). Si el asistente ofrece un complemento, corta y
                    // sigue la conversación IA hasta confirmar o agregar.
                    if (await this._sugerirComplementoSiCorresponde(sock, jid)) {
                        return { derivado: true };
                    }
                    // Intención de compra clara (quiere pagar/confirmar): el
                    // asistente corta el flujo y deriva al vendedor real.
                    const derivado = await this._derivarVendedor(sock, jid, pushName, { motivo: 'Quiere pagar/confirmar su pedido' });
                    if (derivado) return { derivado: true };
                    // Sin vendedor configurado: deja que el motor determinista
                    // resuelva el flujo de pago real.
                    return 'p';
                }

                case 'NAVEGAR_A': {
                    // Navegación silenciosa decidida por el LLM. Devuelve el trigger
                    // destino para que el menú navegue sin mostrar mensaje de transición.
                    const { triggerDestino } = clasificacion;
                    if (triggerDestino && typeof triggerDestino === 'string') {
                        console.log(`[AI] Bot ${this.idCliente}: NAVEGAR_A -> ${triggerDestino} (${clasificacion.razon || 'sin razón'})`);
                        return triggerDestino;
                    }
                    return { derivado: true };
                }

                case 'CONSULTAR_HORARIOS':
                case 'CHARLA_GENERAL':
                default: {
                    await this._sendFriendly(sock, jid, respuesta || '¡Claro! ¿En qué más puedo ayudarte?');

                    // MENSAJE COMPUESTO: el cliente preguntó horarios/charló PERO
                    // además mencionó una sección o ficha del catálogo (ej.
                    // "atienden mañana? estoy buscando precios para alquilar").
                    // Respondemos la consulta Y derivamos a ese ítem: así no
                    // re-preguntamos lo que ya dijo ni caemos al menú raíz.
                    const trigReferido = (items && items.length > 0) ? String(items[0].trigger || '').trim() : '';
                    if (trigReferido) {
                        if (await this._esSeccionCatalogo(jid, trigReferido)) {
                            this.stateService.clearTranslationFails(jid);
                            this._setInteres(jid, trigReferido, '');
                            console.log(`[AI] Bot ${this.idCliente}: ${intencion} compuesta "${trigReferido}" -> navega a la SECCIÓN`);
                            return trigReferido;
                        }
                        if (this._esSinCarrito()) {
                            const nivelId = this.stateService.getUserState(jid) || 'root';
                            const opcionesNivel = await this._opcionesNivel(jid, nivelId).catch(() => []);
                            if (opcionesNivel.some(o => String(o.trigger).toLowerCase() === trigReferido.toLowerCase())) {
                                this.stateService.clearTranslationFails(jid);
                                this._setInteres(jid, trigReferido, '');
                                console.log(`[AI] Bot ${this.idCliente}: ${intencion} compuesta "${trigReferido}" -> abre la FICHA`);
                                return trigReferido;
                            }
                        }
                    }
                    return { derivado: true };
                }
            }
        } catch (err) {
            console.error(`[AI] Error procesando intención ${this.idCliente}:`, err.message);
            return 'FALLO';
        }
    }

    /**
     * Detecta una cantidad en el texto del pedido del cliente
     * (ej: "dos muzzarellas", "3 coca cola").
     */
    _detectarCantidad(text) {
        const mapa = { una: 1, un: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9, diez: 10 };
        const m = String(text || '').toLowerCase();
        const num = m.match(/\b(\d+)\b/);
        if (num) return Number(num[1]);
        for (const k of Object.keys(mapa).sort((a, b) => b.length - a.length)) {
            const re = new RegExp(`\\b${k}\\b`);
            if (re.test(m)) return mapa[k];
        }
        return 1;
    }

    /**
     * Divide un texto en ítems de un pedido ("una muzzarella y una coca",
     * "2 pepperoni + una empanada", "muzzarella, coca"). Devuelve un array de
     * segmentos o el texto completo si no hay separadores claros.
     */
    _splitItems(text) {
        const m = String(text || '').toLowerCase().trim();
        if (!m) return [];
        const separadores = /\s+(?:y|e|mas|más|ademas|además)\s+|,+|\s*\+\s*/i;
        const partes = m.split(separadores).map(p => p.trim()).filter(Boolean);
        return partes.length > 1 ? partes : [m];
    }

    /**
     * Detecta si el texto menciona VARIOS productos del nivel actual.
     * Devuelve { items: [{trigger, cantidad, match}] } o null.
     * Solo se considera multi-pedido si al menos 2 segmentos matchean.
     */
    async _detectarMultiPedido(jid, text, options) {
        if (!options || options.length < 2) return null;
        const partes = this._splitItems(text);
        if (!partes || partes.length < 2) return null;

        const items = [];
        for (const parte of partes) {
            const trigger = this._matchOption(parte, options);
            if (!trigger) return null; // un segmento no matchea -> no es un multi-pedido
            const cantidad = this._detectarCantidad(parte);
            items.push({ trigger, cantidad, match: parte });
        }
        if (items.length < 2) return null;
        return { items };
    }
}

module.exports = AITranslatorController;