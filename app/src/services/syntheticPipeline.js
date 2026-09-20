'use strict';

/**
 * Synthetic Training Pipeline — Self-Play & Synthetic Data Generation.
 *
 * Arquitectura (v2):
 *  1. Agente Cliente: genera un mensaje Y declara la intención de referencia
 *     (gold intent) en JSON {mensaje, intent, items}.
 *  2. Bot (IntentRouterService): clasifica el mensaje. Comparación DETERMINISTA
 *     contra el gold: si coinciden, no se gasta una llamada de Juez.
 *  3. Agente Juez: solo arbitra los casos donde Bot != gold (o gold inválido).
 *     Devuelve veredicto con confianza 0-1.
 *  4. Guardado con control de calidad: gate de confianza + dedup por similaridad
 *     + límite por intención (ventana deslizante).
 *
 * Uso:
 *   const { runPipeline } = require('./syntheticPipeline');
 *   const result = await runPipeline({ perfil, rondas: 5, verbose: true });
 */

const llmChatService = require('./llmChatService');
const IntentRouterService = require('./intentRouterService');
const aiFewShotService = require('./aiFewShotService');

const MODEL = 'gpt-4o-mini';
const DELAY_BETWEEN_MS = 200;
const MIN_CONFIDENCE_DEFAULT = 0.85;
const MAX_PER_INTENT_DEFAULT = 5;
const DEDUP_THRESHOLD = 0.8;
const JUDGE_TEMPERATURE = 0.2;
const GOLD_SIM_THRESHOLD = 0.6;
const CLI_TARGETS = { AGREGAR_AL_CARRITO: 1, QUITAR_DEL_CARRITO: 0 };

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Utilidades ──────────────────────────────────────────────────────────────

function intencionesValidasDe(perfil) {
    // FAQ y TURNOS no tienen carrito de compras: solo intenciones de consulta.
    if (perfil.sinCarrito || perfil.tipoBot === 'TURNOS' || perfil.id === 'TURNOS') {
        return ['CONSULTAR_MENU', 'CONSULTAR_HORARIOS', 'CHARLA_GENERAL'];
    }
    return ['AGREGAR_AL_CARRITO', 'QUITAR_DEL_CARRITO', 'CONSULTAR_MENU', 'CONSULTAR_HORARIOS', 'VER_CARRITO', 'FINALIZAR_PEDIDO', 'CHARLA_GENERAL', 'FALLO'];
}

function truncateText(s, n) {
    return String(s || '').slice(0, n);
}

function extraerJSON(text) {
    const m = String(text || '').match(/\{[\s\S]*\}/);
    if (!m) return null;
    try { return JSON.parse(m[0]); } catch (_) { return null; }
}

function normalizarTexto(s) {
    return String(s || '')
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function jaccard(a, b) {
    const ta = new Set(normalizarTexto(a).split(' ').filter(Boolean));
    const tb = new Set(normalizarTexto(b).split(' ').filter(Boolean));
    if (!ta.size || !tb.size) return 0;
    let inter = 0;
    for (const x of ta) if (tb.has(x)) inter++;
    return inter / (ta.size + tb.size - inter);
}

// ── Red de seguridad determinista (contra casos de benchmark conocidos) ──────

/**
 * Verifica que el ejemplo nuevo no contradiga un caso de benchmark conocido.
 * goldSet: [{ input, acceptedIntents, items }]. Devuelve motivo de conflicto o null.
 */
function _chequearContraGoldSet(userInput, intent, goldSet) {
    if (!Array.isArray(goldSet) || goldSet.length === 0) return null;
    const intentNorm = String(intent || '').trim().toUpperCase();

    for (const caso of goldSet) {
        const sim = jaccard(userInput, caso.input);
        if (sim < GOLD_SIM_THRESHOLD) continue;

        const aceptadas = (caso.acceptedIntents || []).map(i => String(i).trim().toUpperCase());
        if (!aceptadas.includes(intentNorm)) {
            return `conflicto con caso conocido "${truncateText(caso.input, 50)}" (sim ${sim.toFixed(2)}): ejemplo propone "${intentNorm}", gold exige ${aceptadas.join('/')}`;
        }
    }
    return null;
}

// ── Agente Cliente (con gold intent) ────────────────────────────────────────

/**
 * Genera {mensaje, intent, items} con la intención real que tuvo el "cliente".
 * Devuelve null si el LLM no devuelve JSON válido/con coherente.
 */
async function agenteCliente({ perfil, ronda, onTokens }) {
    const catalogoTxt = (perfil.catalogo || [])
        .map(c => `- trigger "${c.trigger}": ${c.title}${c.seccion ? ' (SECCIÓN)' : ''}${c.price ? ` $${c.price}` : ''}`)
        .join('\n');

    const intenciones = intencionesValidasDe(perfil).join(', ');

    const esTurnos = perfil.tipoBot === 'TURNOS' || perfil.id === 'TURNOS';
    const especificas = perfil.sinCarrito
        ? `- CONSULTAR_MENU: el cliente consulta o muestra interés por un ítem del catálogo (precio, disponibilidad, detalle, "quiero la casa X").\n- CONSULTAR_HORARIOS: pregunta por horarios de atención.\n- CHARLA_GENERAL: saludo o charla sin referencia a ítems del catálogo.`
        : esTurnos
            ? `- CONSULTAR_MENU: el cliente quiere RESERVAR, CAMBIAR, CANCELAR o VER un turno / servicio del catálogo (incluir el trigger del flujo en "items", ej. "turno_reserva" o "mis_turnos"). También para preguntas de precio/servicio de los ítems del catálogo.\n- CONSULTAR_HORARIOS: pregunta por HORARIOS DE ATENCIÓN del local (sin reservar nada).\n- CHARLA_GENERAL: saludo o charla sin pedir ni reservar nada.\n- NUNCA uses intenciones de carrito (AGREGAR_AL_CARRITO, etc.): este bot es de TURNOS, no vende productos.`
            : `- AGREGAR_AL_CARRITO: el cliente quiere comprar/encargar un ítem vendible del catálogo (obligatorio incluir su trigger en "items").\n- CONSULTAR_MENU: pregunta precio/disponibilidad/detalle de un ítem real, o quiere navegar a una sección (incluir trigger en "items").\n- CONSULTAR_HORARIOS: pregunta por horarios de atención.\n- CHARLA_GENERAL: saludo o charla sin pedir/comprar nada específico.`;

    const escenario = _escenarioDeRonda(perfil, ronda);

    const sistema = `Sos un CLIENTE REALISTA de un WhatsApp de "${perfil.negocio}".
Generás mensajes variados y naturales como si fueras una persona real: errores ortográficos ocasionales, abreviaciones ("xq", "dnd", "toy"), tono según contexto.
Escribí SOLO UN mensaje de 1-3 oraciones. NO uses "trigger" ni datos internos en el mensaje.

Además de generar el mensaje, DECLARÁ cuál era tu intención real detrás de él (la "gold" con la que entrenás al bot).

CATÁLOGO DEL NEGOCIO:
${catalogoTxt}

INTENCIONES VÁLIDAS (elegí UNA): ${intenciones}

REGLAS DE INTENCIÓN:
${especificas}
- "items" usa SOLO triggers exactos del CATÁLOGO. "cantidad" solo si son compras (AGREGAR_AL_CARRITO).
- Elegí UNA intención clara por mensaje. Si el mensaje mezcla dos, priorizá la ACCIÓN principal (comprar > consultar > saludo).

${escenario}

Devolvé SOLO JSON:
{"mensaje": "texto del mensaje", "intent": "INTENCION_VALIDA", "items": [{"trigger": "...", "cantidad": 1}]}`;

    const res = await llmChatService.chat({
        systemPrompt: sistema,
        messages: [{ role: 'user', content: 'Generá el mensaje y tu intención ahora.' }],
        tools: [],
        executeTool: async () => '',
        onTokens
    });

    const parsed = extraerJSON(res.content);
    const gold = _normalizarGold(parsed, perfil);
    if (!gold) {
        // Segundo intento: a veces el LLM devuelve solo texto. Forzamos JSON limpio.
        const retry = await llmChatService.chat({
            systemPrompt: sistema + '\nIMPORTANTE: respondé EXCLUSIVAMENTE con el JSON entre llaves, sin texto extra. Si no podés cumplir el escenario, elegí uno simple que sí.',
            messages: [{ role: 'user', content: 'Generá el mensaje y tu intención ahora (solo JSON).' }],
            tools: [],
            executeTool: async () => '',
            onTokens
        });
        return _normalizarGold(extraerJSON(retry.content), perfil);
    }
    return gold;
}

// ── Escenarios por ronda (diversidad + casos adversariales) ─────────────────

const ESCENARIOS = [
    'Comandá un PEDIDO de compra usando palabras informales y cantidades (ej: "me llevo dos", "dame una...").',
    'Hacé una CONSULTA de precio/disponibilidad de un ítem del catálogo, PERO mencionando el ítem sin su nombre exacto (variante, apodo, forma parecida).',
    'Hacé un mensaje de SALUDO o charla casual SIN mencionar ningún producto ni horario.',
    'Preguntá por HORARIOS o disponibilidad de atención de forma natural.',
    'Pedido AMBIGUO: expresá intención de comprar pero de forma confusa (ej: "quería algo rico", "lo de siempre", describiendo sin dar el nombre). La intención gold debe reflejar lo que REALMENTE querés.',
    'Pedido de compra con un ÍTEM que en el catálogo es una SECCIÓN, pidiéndolo como si fuera producto (la intención gold correcta para ese caso según el negocio).',
    'Mensaje con DOBLE intención (compra + pregunta de horarios): priorizá la compra en la intención gold.',
    'CONSULTA de un ítem del catálogo con todo el detalle que pediría un cliente exigente (precio, disponibilidad, forma de pago).'
];

function _escenarioDeRonda(perfil, ronda) {
    const idx = ((ronda - 1) % ESCENARIOS.length);
    const e = ESCENARIOS[idx];

    if (perfil.sinCarrito) {
        // FAQ/TURNOS no compran: traducir escenarios de compra a consulta/interés.
        return `ESCENARIO DE ESTA RONDA: ${e.replace(/comprar|pedido|compra|comprando|pedido de compra/gi, 'interés')}`;
    }
    return `ESCENARIO DE ESTA RONDA: ${e}`;
}

// ── Normalización del gold intent ───────────────────────────────────────────

function _normalizarGold(gold, perfil) {
    if (!gold || typeof gold.mensaje !== 'string' || !gold.mensaje.trim()) return null;

    const intenciones = intencionesValidasDe(perfil);
    const intent = String(gold.intent || '').trim().toUpperCase();
    if (!intenciones.includes(intent)) return null;

    const triggersValidos = new Set((perfil.catalogo || []).map(c => String(c.trigger).toLowerCase()));
    const items = Array.isArray(gold.items)
        ? gold.items
            .filter(it => it && typeof it.trigger === 'string' && triggersValidos.has(String(it.trigger).toLowerCase()))
            .map(it => ({ trigger: String(it.trigger).toLowerCase(), cantidad: Number(it.cantidad) > 0 ? Number(it.cantidad) : 1 }))
        : [];

    // Coherencia: intenciones que no llevan ítems.
    if ((intent === 'CHARLA_GENERAL' || intent === 'CONSULTAR_HORARIOS') && items.length) {
        if (intent === 'CONSULTAR_HORARIOS') return null; // horarios nunca lleva ítems
        gold.items = [];
        return { mensaje: gold.mensaje.trim(), intent, items: [] };
    }

    // Compra concreta sin ítems: gold inservible → forzar re-generación.
    if (Object.prototype.hasOwnProperty.call(CLI_TARGETS, intent) && CLI_TARGETS[intent] > 0 && items.length === 0) {
        return null;
    }

    return { mensaje: gold.mensaje.trim(), intent, items };
}

// ── Comparación determinista Bot vs gold ────────────────────────────────────

function _compararConGold(gold, resultado) {
    if (gold.intent !== resultado.intencion) return false;

    const goldTrigs = (gold.items || []).map(i => String(i.trigger).toLowerCase()).sort().join(',');
    const botTrigs = (resultado.items || []).map(i => String(i.trigger).toLowerCase()).sort().join(',');
    if (goldTrigs !== botTrigs) return false;

    // En compras la cantidad importa.
    if (gold.intent === 'AGREGAR_AL_CARRITO') {
        const gs = (gold.items || []).reduce((m, i) => { m[String(i.trigger).toLowerCase()] = i.cantidad || 1; return m; }, {});
        const bs = (resultado.items || []).reduce((m, i) => { m[String(i.trigger).toLowerCase()] = i.cantidad || 1; return m; }, {});
        for (const k of Object.keys(gs)) {
            if (Number(bs[k]) !== Number(gs[k])) return false;
        }
    }
    return true;
}

// ── Agente Juez (arbitración + confianza) ───────────────────────────────────

async function agenteJuez({ userInput, resultado, catalogo, perfil, onTokens }) {
    const catalogoTxt = (catalogo || [])
        .map(c => `- trigger "${c.trigger}": ${c.title}${c.seccion ? ' (SECCIÓN)' : ''}${c.price ? ` $${c.price}` : ''}`)
        .join('\n');

    const intencionesValidas = intencionesValidasDe(perfil);

    const reglasPorModo = perfil.sinCarrito
        ? `- MODO CONSULTA (FAQ): interés por un ítem del catálogo real SIEMPRE "CONSULTAR_MENU" con su trigger. "CHARLA_GENERAL" SOLO sin referencia a ítems.`
        : `- MODO COMPRA/TURNOS: comprar un ítem real = "AGREGAR_AL_CARRITO"; consultar precio/detalle = "CONSULTAR_MENU"; turnos = "CONSULTAR_MENU" con el trigger del flujo.`
        + (perfil.id === 'TURNOS'
            ? `\n- MODO TURNOS: NUNCA uses un trigger como "correctedIntent"; la intención correcta es "CONSULTAR_MENU" con el trigger del flujo.
- DISAMBIGUACIÓN CLAVE: si el cliente pregunta por DISPONIBILIDAD de turnos ("hay hueco", "horarios disponibles", "cupo", "lugar libre", "te queda algo") → es "CONSULTAR_MENU" con trigger "turno_reserva" (quiere reservar). "CONSULTAR_HORARIOS" solo aplica para horario de ATENCIÓN del local ("a qué hora abren", "hasta qué hora atienden", "qué días trabajan"). Verificar SIEMPRE que "correctedItems" sea coherente con "correctedIntent".`
            : '');

    const sistema = `Sos un JUEZ experto en clasificación de intenciones para un bot de WhatsApp de "${perfil.negocio}".

CATÁLOGO:
${catalogoTxt}

INTENCIONES VÁLIDAS (solo una de ESTAS palabras puede ir en "correctedIntent", NUNCA un trigger): ${intencionesValidas.join(', ')}

REGLAS DE CORRECCIÓN:
${reglasPorModo}
- "correctedItems" usa SOLO triggers exactos del CATÁLOGO.
- Si el mensaje es AMBIGUO y la clasificación del bot es defendible/razonable, marcá "pass": true. No corrijas clasificaciones razonables.
- "pass" solo es false si la clasificación del bot es CLARAMENTE incorrecta (intención no plausible dado el mensaje y el catálogo).
- "confidence": 0-1 (1 = certeza total). Marcá "pass": false solo con confidence alta.

Respondé SOLO con JSON:
{
  "pass": true/false,
  "correctedIntent": "INTENCION_CORRECTA" (solo si pass=false),
  "correctedItems": [{"trigger": "...", "cantidad": 1}] (solo si pass=false y aplica),
  "confidence": 0.9,
  "reason": "explicación breve"
}`;

    const userMsg = `Mensaje del cliente: "${userInput}"

Clasificación del bot:
- Intención: ${resultado.intencion}
- Ítems: ${JSON.stringify(resultado.items || [])}
- Respuesta: ${resultado.respuesta_conversacional || '(sin respuesta)'}

¿Es razonable? Si NO, ¿cuál sería la intención correcta?`;

    const res = await llmChatService.chat({
        systemPrompt: sistema,
        messages: [{ role: 'user', content: userMsg }],
        tools: [],
        executeTool: async () => '',
        onTokens,
        temperature: JUDGE_TEMPERATURE
    });

    const parsed = extraerJSON(res.content) || { pass: true, reason: 'No se pudo parsear respuesta del juez' };
    const conf = Number(parsed.confidence);
    return {
        pass: !!parsed.pass,
        correctedIntent: parsed.correctedIntent || null,
        correctedItems: Array.isArray(parsed.correctedItems) ? parsed.correctedItems : [],
        confidence: Number.isFinite(conf) ? Math.max(0, Math.min(1, conf)) : 0,
        reason: parsed.reason || ''
    };
}

// ── Validación de la corrección del Juez ────────────────────────────────────

function _validarCorreccion(veredicto, perfil, resultado, minConfidence) {
    const intencionesValidas = intencionesValidasDe(perfil);
    const triggersValidos = new Set((perfil.catalogo || []).map(c => String(c.trigger).toLowerCase()));

    // Gate de confianza.
    if (veredicto.confidence < minConfidence) {
        return { valido: false, motivo: `confianza ${veredicto.confidence} < umbral ${minConfidence}`, intent: null, items: [] };
    }

    const intentRaw = (veredicto.correctedIntent || '').trim();
    if (!intencionesValidas.includes(intentRaw)) {
        return { valido: false, motivo: `intent "${intentRaw}" no es una intención válida`, intent: intentRaw, items: [] };
    }

    const items = Array.isArray(veredicto.correctedItems)
        ? veredicto.correctedItems
            .filter(it => it && typeof it.trigger === 'string' && triggersValidos.has(String(it.trigger).toLowerCase()))
            .map(it => ({
                trigger: String(it.trigger).toLowerCase(),
                cantidad: Number(it.cantidad) > 0 ? Number(it.cantidad) : 1,
                nota: typeof it.nota === 'string' ? it.nota : ''
            }))
        : [];

    if (intentRaw === 'CHARLA_GENERAL' && items.length > 0) {
        return { valido: false, motivo: 'CHARLA_GENERAL no puede llevar ítems', intent: intentRaw, items };
    }

    if (resultado && intentRaw === resultado.intencion) {
        const botTriggers = (resultado.items || []).map(i => String(i.trigger).toLowerCase()).sort().join(',');
        const corregidos = items.map(i => i.trigger.toLowerCase()).sort().join(',');
        if (botTriggers === corregidos) {
            return { valido: false, motivo: 'corrección redundante (igual a lo que ya clasificó el bot)', intent: intentRaw, items };
        }
    }

    return { valido: true, motivo: '', intent: intentRaw, items, reason: veredicto.reason || '' };
}

// ── Guardado controlado (dedup + límite por intención) ──────────────────────

async function _guardarEjemplo(comercioId, { userInput, intent, items, rationale }, maxPerIntent, goldSet) {
    if (!process.env.NEON_DATABASE_URL) return 'no-neon';

    // 0. Red de seguridad: el ejemplo no debe contradecir casos conocidos.
    const conflicto = _chequearContraGoldSet(userInput, intent, goldSet);
    if (conflicto) return conflicto;

    // 1. Dedup por similaridad con ejemplos ya guardados.
    const existentes = await aiFewShotService.getAllUserInputs(comercioId).catch(() => []);
    for (const ex of existentes) {
        if (jaccard(userInput, ex) >= DEDUP_THRESHOLD) {
            return `duplicado (similaridad ${jaccard(userInput, ex).toFixed(2)})`;
        }
    }

    // 2. Ventana deslizante por intención.
    const counts = await aiFewShotService.getCountsByIntent(comercioId).catch(() => ({}));
    if ((counts[intent] || 0) >= maxPerIntent) {
        await aiFewShotService.deleteOldestForIntent(comercioId, intent).catch(() => {});
    }

    await aiFewShotService.upsertExample(comercioId, { userInput, intent, items, rationale });
    return 'ok';
}

// ── Pipeline Orchestrator ───────────────────────────────────────────────────

async function runPipeline({ perfil, rondas = 3, verbose = false, dryRun = false, minConfidence = MIN_CONFIDENCE_DEFAULT, maxPerIntent = MAX_PER_INTENT_DEFAULT, goldSet = [], onTokens }) {
    const comercioId = perfil.id;
    const goldPerfil = (goldSet || []).filter(c => c.perfilId === comercioId);
    const results = { total: 0, passed: 0, failed: 0, saved: 0, discarded: 0, errors: 0, logs: [] };

    if (verbose) console.log(`\n${'─'.repeat(60)}`);
    if (verbose) console.log(`Pipeline: ${perfil.negocio} (${comercioId}) — ${rondas} rondas (Juez gpt-4o-mini, conf≥${minConfidence}, máx ${maxPerIntent}/intent)`);
    if (verbose) console.log('─'.repeat(60));

    const router = new IntentRouterService({
        idCliente: `synthetic-${comercioId}`,
        stateService: {},
        menuController: null,
        orderService: null,
        buildCatalogo: async () => (perfil.catalogo || []).map(c => ({
            trigger: c.trigger,
            title: c.title,
            price: c.price,
            seccion: !!c.seccion
        })),
        buildContexto: async () => '',
        ai: { estilo: perfil.estilo || 'profesional' },
        negocio: perfil.negocio,
        sinCarrito: !!perfil.sinCarrito,
        tipoBot: perfil.id
    });

    for (let ronda = 1; ronda <= rondas; ronda++) {
        results.total++;

        try {
            // 1. Agente Cliente genera mensaje + gold intent
            const gold = await agenteCliente({ perfil, ronda, onTokens });
            if (!gold) {
                results.errors++;
                if (verbose) console.log(`  [${ronda}/${rondas}] ⚠ Cliente no generó gold válido`);
                continue;
            }
            const userInput = gold.mensaje;
            if (verbose) console.log(`  [${ronda}/${rondas}] Cliente: "${truncateText(userInput, 90)}" (gold ${gold.intent}${gold.items.length ? ' [' + gold.items.map(i => i.trigger).join(',') + ']' : ''})`);

            // 2. Bot clasifica
            const jid = `synthetic-${comercioId}-${ronda}`;
            const resultado = await router.clasificar(jid, userInput, onTokens);
            if (verbose) console.log(`  [${ronda}] Bot: ${resultado.intencion} [${(resultado.items || []).map(i => i.trigger).join(', ')}]`);

            const logEntry = {
                userInput,
                goldIntent: gold.intent,
                botIntent: resultado.intencion,
                botItems: resultado.items || [],
                judgeVerdict: '',
                judgeReason: '',
                decision: '',
                corrected: false
            };

            // 3. Comparación determinista: solo arbitra el Juez si hay divergencia
            if (_compararConGold(gold, resultado)) {
                results.passed++;
                logEntry.decision = 'PASS-determinista';
                if (verbose) console.log(`  [${ronda}] ✅ PASS (determinista) — bot coincidió con gold ${gold.intent}`);
            } else {
                const veredicto = await agenteJuez({ userInput, resultado, catalogo: perfil.catalogo, perfil, onTokens });

                if (veredicto.pass) {
                    results.passed++;
                    logEntry.judgeVerdict = 'PASS';
                    logEntry.judgeReason = veredicto.reason;
                    logEntry.decision = 'PASS-juez';
                    if (verbose) console.log(`  [${ronda}] ✅ PASS (juez, conf ${veredicto.confidence}) — ${veredicto.reason}`);
                } else {
                    results.failed++;
                    logEntry.judgeVerdict = 'FAIL';
                    logEntry.judgeReason = veredicto.reason;
                    logEntry.decision = `FAIL (conf ${veredicto.confidence})`;

                    const validado = _validarCorreccion(veredicto, perfil, resultado, minConfidence);
                    if (!validado.valido) {
                        results.discarded++;
                        logEntry.decision += ` → descartado (${validado.motivo})`;
                        if (verbose) console.log(`  [${ronda}] ⚠ Descarte: ${validado.motivo} — ${veredicto.reason}`);
                    } else if (!dryRun) {
                        const guardado = await _guardarEjemplo(comercioId, {
                            userInput,
                            intent: validado.intent,
                            items: validado.items,
                            rationale: validado.reason
                        }, maxPerIntent, goldPerfil);
                        if (guardado === 'ok') {
                            results.saved++;
                            logEntry.corrected = true;
                            logEntry.decision += ` → guardado (${validado.intent})`;
                            if (verbose) console.log(`  [${ronda}] 🎯 Guardado few-shot: "${truncateText(userInput, 70)}" → ${validado.intent} [${validado.items.map(i => i.trigger).join(', ')}]`);
                        } else {
                            results.discarded++;
                            logEntry.decision += ` → ${guardado}`;
                            if (verbose) console.log(`  [${ronda}] ⚠ No guardado: ${guardado}`);
                        }
                    } else {
                        logEntry.decision += ' → (dry-run, no guardado)';
                        if (verbose) console.log(`  [${ronda}] ❌ FAIL → ${validado.intent} — ${veredicto.reason} (conf ${veredicto.confidence}, dry-run)`);
                    }
                }
            }

            // Log en DB
            if (!dryRun) {
                await aiFewShotService.saveLog(comercioId, logEntry).catch(() => {});
            }
            results.logs.push(logEntry);

            await sleep(DELAY_BETWEEN_MS);
        } catch (err) {
            results.errors++;
            if (verbose) console.error(`  [${ronda}] ⚠ Error: ${err.message}`);
        }
    }

    if (verbose) {
        console.log('─'.repeat(60));
        console.log(`  Total: ${results.total} | Pass: ${results.passed} | Fail: ${results.failed} | Guardados: ${results.saved} | Descartados: ${results.discarded} | Errores: ${results.errors}`);
        console.log('─'.repeat(60));
    }

    return results;
}

module.exports = { runPipeline, agenteCliente, agenteJuez };