/**
 * MenuController: El "cerebro" del bot.
 * Gestiona la lógica de navegación, el estado del usuario y la interacción con WhatsApp.
 */
const userService = require('../services/userService');
const botConfigService = require('../services/botConfigService');
const calendarService = require('../services/googleCalendarService');

class MenuController {
    constructor(googleSheetsService, stateService, orderService = null) {
        this.googleSheetsService = googleSheetsService; // Servicio para leer datos de Google Sheets
        this.stateService = stateService;             // Servicio para gestionar estados y carritos de usuarios
        this.orderService = orderService;             // Servicio para guardar pedidos en Google Sheets
    }

    /**
     * Utilidad para crear pausas (ms)
     */
    async delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * Simula el comportamiento humano: "Escribiendo..." y esperas estratégicas
     */
    async sendPresenceTyping(sock, jid) {
        await sock.sendPresenceUpdate('paused', jid);
        // Espera inicial configurada en .env
        await this.delay(process.env.TIEMPO_ESPERA_RESPUESTA); 
        await sock.sendPresenceUpdate('composing', jid);
        // Simulación de tiempo de escritura configurada en .env
        await this.delay(process.env.TIEMPO_BOT_ESTA_ESCRIBIENDO); 
    }

    /**
     * Procesa cada mensaje entrante del usuario siguiendo esta jerarquía lógica:
     * 1. ¿Esperando Datos? -> 2. ¿Esperando Cantidad? -> 3. Comandos Globales -> 4. Opciones de Menú
     * 
     * DIAGRAMA DE FLUJO:
     * [Inicio] -> ¿waitingNodeId? --(SÍ)--> [Procesar Dato] -> ¿Hijos? --(NO)--> [Fin + Root]
     *    |            | (NO)
     *    |            v
     *    |      ¿pendingItem? --(SÍ)--> [Añadir Cantidad] -> [Menú Padre]
     *    |            | (NO)
     *    |            v
     *    |      ¿Comando Global? --(SÍ)--> [Ejecutar 0, v, vaciar]
     *    |            | (NO)
     *    |            v
     *    +------> [Buscar Opción] --(SÍ)--> ¿Tiene Submenús? --(NO)--> [Mensaje Final]
     *                               (NO)        | (SÍ)
     *                                |          v
     *                          [Error/Root]   [Enviar Menú]
     */
    async handleIncomingMessage(sock, jid, text, media = null) {
        const currentStateId = this.stateService.getUserState(jid);

        // PRIORIDAD -1: ¿EL BOT ESTÁ FUERA DEL HORARIO DE ATENCIÓN?
        const isOpen = await this._isOpenNow();
        if (!isOpen.open) {
            await this.sendPresenceTyping(sock, jid);
            await sock.sendMessage(jid, {
                text: `😴 *Estamos cerrados en este momento.*\n\n🕒 Horario de atención:\n${isOpen.text}\n\n¡Gracias por escribirnos!`
            });
            return;
        }

        ////console.log(`//[Estado] Usuario ${jid} envió mensaje: "${text}". Estado actual: ${currentStateId} #50`);
        const input = text.trim().toLowerCase();

        // PRIORIDAD 0: ¿EL BOT ESTÁ ESPERANDO UN ARCHIVO?
        const waitingFileNodeId = this.stateService.getWaitingForFile(jid);
        ////console.log(`//[ARCHIVO] waitingFileNodeId=${waitingFileNodeId}, media=${!!media}, text="${text}"`);
        if (waitingFileNodeId && media) {
            const waitingNode = await this.googleSheetsService.getNodeById(waitingFileNodeId);
            const children = await this.googleSheetsService.getNodesByParent(waitingFileNodeId);
            this.stateService.clearWaitingForFile(jid);

            if (children.length > 0) {
                await this.processNode(sock, jid, children[0]);
            } else {
                if (waitingNode && waitingNode.message && waitingNode.message.includes('##FINALIZAR##')) {
                    await this._finalizeOrder(jid);
                }
                const fileTarget = waitingNode?.redirigirA || 'root';
                await sock.sendMessage(jid, { text: '✅ Archivo recibido correctamente.' });
                this.stateService.setUserState(jid, fileTarget);
            }
            return;
        }

        // PRIORIDAD 0.5: FLUJO DE TURNOS (Gestor de Turnos / Google Calendar)
        // 0.5a: Recordatorio (confirmar/cancelar) y oferta de lista de espera
        if (this.stateService.getWaitingTurnoReminder(jid)) {
            await this._handleTurnoReminder(sock, jid, input);
            return;
        }
        if (this.stateService.getWaitingTurnoCascada(jid)) {
            await this._handleTurnoCascada(sock, jid, input);
            return;
        }
        if (this.stateService.getWaitingTurnoWaitlistName(jid)) {
            await this._handleTurnoWaitlistName(sock, jid, input);
            return;
        }
        if (this.stateService.getMisTurnoSeleccionado(jid)) {
            await this._handleMisTurnosAccion(sock, jid, input);
            return;
        }
        if (this.stateService.getMisTurnos(jid)) {
            await this._handleMisTurnos(sock, jid, input);
            return;
        }
        if (this.stateService.getWaitingTurnoReprogram(jid)) {
            await this._handleTurnoReprogram(sock, jid, input);
            return;
        }
        if (this.stateService.getWaitingTurnoDate(jid)) {
            await this._handleTurnoDate(sock, jid, input);
            return;
        }
        if (this.stateService.getWaitingTurnoSlot(jid)) {
            await this._handleTurnoSlot(sock, jid, input);
            return;
        }
        if (this.stateService.getWaitingTurnoConfirm(jid)) {
            await this._handleTurnoConfirm(sock, jid, input);
            return;
        }

        // PRIORIDAD 1: ¿EL BOT ESTÁ ESPERANDO DATOS LIBRES? (Ej: Nombre, Dirección)
        const waitingNodeId = this.stateService.getWaitingForData(jid);
        ////console.log("prioridad 1: esperando datos libres ?? #55");
        if (waitingNodeId) {
            //console.log("El bot esta esperando datos libres #57");
            const waitingNode = await this.googleSheetsService.getNodeById(waitingNodeId);
            const children = await this.googleSheetsService.getNodesByParent(waitingNodeId);
            this.stateService.clearWaitingForData(jid);

            // Guardar el texto ingresado por el usuario (nombre, dirección, etc.)
            this.stateService.addDatosText(jid, text);

            // Confirmar datos ingresados antes de continuar
            if (children.length > 0) {
                await sock.sendMessage(jid, { text: `✅ Datos recibidos: ${text}` });
                await this.processNode(sock, jid, children[0]);
                return;
            } else {
                if (waitingNode && waitingNode.message && waitingNode.message.includes('##FINALIZAR##')) {
                    await this._finalizeOrder(jid);
                }

                const datosTarget = waitingNode?.redirigirA || 'root';
                await sock.sendMessage(jid, { text: `✅ Datos recibidos: ${text}` });
                await this.sendMenu(sock, jid, datosTarget);
                return;
            }
        }

        // PRIORIDAD 2: ¿EL BOT ESTÁ ESPERANDO UNA CANTIDAD NUMÉRICA?
        // Se activa cuando el usuario eligió un producto con el tag ##CANTIDAD##
        const pendingItem = this.stateService.getPendingQuantityItem(jid);
        if (pendingItem && !isNaN(input) && parseInt(input) > 0) {
            const quantity = parseInt(input);
            this.stateService.clearPendingQuantityItem(jid);

            await this.sendPresenceTyping(sock, jid);

            // Si el nodo actual tiene hijos (ej: talles), no agregamos aún al carrito
            const children = await this.googleSheetsService.getNodesByParent(currentStateId);
            if (children.length > 0) {
                this.stateService.setPendingOrderItem(jid, { quantity, title: pendingItem });
                await this.processNode(sock, jid, children[0]);
                return;
            }

            // Sin hijos: agrega directo al carrito y vuelve al menú (redirigirA o padre)
            const currentNode = await this.googleSheetsService.getNodeById(currentStateId);
            const targetId = currentNode?.redirigirA || currentNode?.parentId || 'root';

            this.stateService.addItemToOrder(jid, {
                text: `${quantity} x ${pendingItem}`,
                price: parseFloat(String(currentNode?.price || '0').replace(',', '.')) || 0,
                quantity: quantity
            });

            await sock.sendMessage(jid, {
                text: `✅ Añadido: ${quantity} x ${pendingItem}`
            });

            await this.sendMenu(sock, jid, targetId);
            return;
        }

        

        // PRIORIDAD 3: COMANDOS GLOBALES (Navegación básica y reset)
        if (input === '0' || input === 'inicio') {
            //////console.log(`[Estado] Usuario ${jid} solicitó volver al inicio.`);
            await this.sendMenu(sock, jid, 'root');
            return;
        }

        // GESTIÓN DEL CARRITO: Comando manual para limpiar todo el pedido
        if (input === 'vaciar' || input === 'limpiar' || input === 'borrar pedido') {
            ////console.log(`[Estado] Usuario ${jid} vació su carrito manualmente.`);
            this.stateService.clearUserOrder(jid);
            await this.sendPresenceTyping(sock, jid);
            await sock.sendMessage(jid, {
                text: '🗑️ Tu pedido ha sido vaciado.'
            });
            await this.sendMenu(sock, jid, currentStateId);
            return;
        }

        // NAVEGACIÓN HACIA ATRÁS (Sube un nivel en la jerarquía del Excel)
        if (input === 'v' || input === 'atras' || input === 'atrás') {
            const currentNode = await this.googleSheetsService.getNodeById(currentStateId);
            const parentId = currentNode ? currentNode.parentId : 'root';
            //console.log(`//[Estado] Usuario ${jid} volvió atrás. De ${currentStateId} a ${parentId}`);
            if (currentStateId === 'root') {
                await this.sendMenu(sock, jid, 'root');
            } else {
                await this.sendMenu(sock, jid, parentId);
            }
            return;
        }

        // IR A PAGAR: busca el hijo con ##FINALIZAR## y muestra sus sub-opciones de checkout
        if (input === 'p' || input === 'pagar') {
            const payNode = await this.googleSheetsService.getNodeById(currentStateId);
            if (payNode && payNode.message && payNode.message.includes('##PAGAR##')) {
                const order = this.stateService.getUserOrder(jid);
                const payChildren = await this.googleSheetsService.getNodesByParent(currentStateId);
                if (order.length > 0 && payChildren.length > 0) {
                    const target = payChildren.find(c => c.message && c.message.includes('##FINALIZAR##')) || payChildren[0];
                    await this.processNode(sock, jid, target);
                    return;
                }
            }
        }

        // PRIORIDAD 3.5: "Mis turnos" desde el menú principal (config de turnos)
        if (currentStateId === 'root' && /^(mis turnos|m)$/i.test(input)) {
            try {
                const cfg = await botConfigService.getBotConfig(this.stateService.clientId);
                const cc = cfg.calendar_config || {};
                if (cfg.bot_type === 'TURNOS' && (cc.mis_turnos_enabled === true || cc.mis_turnos_enabled === 'true')) {
                    await this._mostrarMisTurnos(sock, jid, null);
                    return;
                }
            } catch (err) {
                console.error('[Turnos] Error leyendo config para mis turnos:', err.message);
            }
        }

        // PRIORIDAD 4: BUSCAR SI EL INPUT ES UNA OPCIÓN DEL MENÚ ACTUAL
        const options = await this.googleSheetsService.getNodesByParent(currentStateId);
        
        // Regla de negocio: Ocultar opciones de "Finalizar" si no hay nada en el carrito
        const order = this.stateService.getUserOrder(jid);
        const currentPagarNode = await this.googleSheetsService.getNodeById(currentStateId);
        const hasPagar = currentPagarNode && currentPagarNode.message && currentPagarNode.message.includes('##PAGAR##');
        const availableOptions = options.filter(node => {
            if (node.message && node.message.includes('##FINALIZAR##')) {
                if (hasPagar) return false;
                return order.length > 0;
            }
            return true;
        });

        
        const selectedOption = availableOptions.find(opt => opt.trigger.toLowerCase() === input);

        if (selectedOption) {
            if (selectedOption.disponible === 'false') {
                await this.sendPresenceTyping(sock, jid);
                await sock.sendMessage(jid, { text: `❌ *${selectedOption.title}* no está disponible por el momento.` });
                await this.sendMenu(sock, jid, currentStateId);
                return;
            }
            await this.processNode(sock, jid, selectedOption);
        } else {
            // 7. MANEJO DE ENTRADAS NO VÁLIDAS O PRIMER CONTACTO
            if (currentStateId === 'root' && !selectedOption) {
                const rootNode = await this.googleSheetsService.getNodeById('root');
                const isStrict = rootNode && rootNode.strictTrigger === 'true';

                if (isStrict) {
                    const rootTrigger = (rootNode && rootNode.trigger) ? rootNode.trigger.toLowerCase() : 'hola';
                    if (input === rootTrigger) {
                        //console.log("es strict root trigger #166");
                        await this.sendMenu(sock, jid, 'root');
                    }
                } else {
                    //console.log("es strict root trigger #170");
                    await this.sendMenu(sock, jid, 'root');
                }
            } else {
                //console.log("opcion no valida #174");
                await this.sendPresenceTyping(sock, jid);
                await sock.sendMessage(jid, {
                    text: 'Opción no válida.'
                });
                await this.sendMenu(sock, jid, currentStateId); // Re-mostrar opciones
            }
        }
    }

    /**
     * Construye y envía el cuerpo del menú con sus opciones y footer
     */
    async sendMenu(sock, jid, parentId) {
        const nodes = await this.googleSheetsService.getNodesByParent(parentId);
        const order = this.stateService.getUserOrder(jid);

        let currentNode = await this.googleSheetsService.getNodeById(parentId);
        //console.log("nodo actual #192 ::", currentNode);

        if (!currentNode) {
            currentNode = {
                message: parentId === 'root' ? 'Hola, bienvenido. Elige una opción:' : 'Elige una opción:'
            };
        }

        // Construcción del texto del menú + Resumen de pedido si existe
        let menuText = await this.replaceOrderSummary(currentNode.message, jid) + '\n\n';
        //console.log("menuText #202:: ", menuText);
        
        // Filtrar nodos de finalización
        // Si la categoría tiene ##PAGAR##, ocultamos ##FINALIZAR## de la lista
        // porque el usuario puede usar "p" del footer para finalizar
        const hasPagar = currentNode && currentNode.message && currentNode.message.includes('##PAGAR##');
        const visibleNodes = nodes.filter(node => {
            if (node.message && node.message.includes('##FINALIZAR##')) {
                if (hasPagar) return false;
                return order.length > 0;
            }
            return true;
        });

        // Listar opciones de submenus con precios (tachar no disponibles)
        visibleNodes.forEach(node => {
            const priceText = node.price ? ` ($${node.price})` : '';
            if (node.disponible === 'false') {
                menuText += `~*${node.trigger}*. ${node.title}${priceText}~ (sin stock)\n`;
            } else {
                menuText += `*${node.trigger}*. ${node.title}${priceText}\n`;
            }
        });
        //console.log("menuText #216:: ", menuText);

        // FOOTER DE NAVEGACIÓN CONSISTENTE
        menuText += `\n---\n`;

        if (order.length > 0) {
            if (currentNode.message && currentNode.message.includes('##PAGAR##')) {
                menuText += `*p*. Ir a pagar\n`;
            }
            if (parentId === 'root') {
                menuText += `*vaciar*. Vaciar pedido\n`;
            }
        }

        if (parentId !== 'root') {
            menuText += `*v*. Volver atrás\n`;
        }
        if (parentId === 'root') {
            try {
                const cfg = await botConfigService.getBotConfig(this.stateService.clientId);
                const cc = cfg.calendar_config || {};
                if (cfg.bot_type === 'TURNOS' && (cc.mis_turnos_enabled === true || cc.mis_turnos_enabled === 'true')) {
                    menuText += `*mis turnos*. Ver mis turnos\n`;
                }
            } catch (err) {
                console.error('[Turnos] Error leyendo config para mis turnos:', err.message);
            }
        }
        menuText += `*0*. Menú Principal`;

        await this.sendPresenceTyping(sock, jid);
        await sock.sendMessage(jid, {
            text: menuText
        });
        //console.log(`//[Estado] Usuario ${jid} movido al menú: ${parentId}`);
        this.stateService.setUserState(jid, parentId);
    }

    /**
     * Procesa un nodo de forma integral: tags, submenús o mensajes finales.
     * Esta función unifica la lógica para evitar errores de navegación.
     */
    async processNode(sock, jid, node) {
        const nodeTags = [];
        if (node.message) {
            if (node.message.includes('##CANTIDAD##')) nodeTags.push('CANTIDAD');
            if (node.message.includes('##PEDIDO##')) nodeTags.push('PEDIDO');
            if (node.message.includes('##DATOS##')) nodeTags.push('DATOS');
            if (node.message.includes('##ARCHIVO##')) nodeTags.push('ARCHIVO');
            if (node.message.includes('##FINALIZAR##')) nodeTags.push('FINALIZAR');
            if (node.message.includes('##COMPLETAR##')) nodeTags.push('COMPLETAR');
            if (node.message.includes('##PAGAR##')) nodeTags.push('PAGAR');
            if (node.message.includes('##TURNO##')) nodeTags.push('TURNO');
          }

        if (nodeTags.includes('PEDIDO')) {
            this.stateService.addItemToOrder(jid, {
                text: `1 x ${node.title}`,
                price: parseFloat(String(node.price).replace(',', '.')) || 0,
                quantity: 1
            });
        }

        const subOptions = await this.googleSheetsService.getNodesByParent(node.id);

        // 0. CANTIDAD: mostrar prompt, esperar número del usuario
        if (nodeTags.includes('CANTIDAD')) {
            this.stateService.setPendingQuantityItem(jid, node.title);
            let msg = await this.replaceOrderSummary(node.message, jid);
            msg += `\n\n✅ Agregado: *${node.title}*\n\n¿Cuántos querés?`;
            msg += `\n\n_Escribe *v* para volver atrás._\n_Escribe *0* para volver al inicio._`;
            await this.sendPresenceTyping(sock, jid);
            await sock.sendMessage(jid, { text: msg });
            this.stateService.setUserState(jid, node.id);
            return;
        }

        // 1. DATOS: mostrar prompt siempre, esperar respuesta del usuario
        if (nodeTags.includes('DATOS')) {
            let msg = await this.replaceOrderSummary(node.message, jid);
            if (!msg) msg = `📝 Por favor, ingresá los datos solicitados:`;
            msg += `\n\n_Escribe *v* para volver atrás._\n_Escribe *0* para volver al inicio._`;
            await this.sendPresenceTyping(sock, jid);
            await sock.sendMessage(jid, { text: msg });
            this.stateService.setWaitingForData(jid, node.id);
            this.stateService.setUserState(jid, node.id);
            return;
        }

        // 1b. ARCHIVO: mostrar prompt, esperar que el usuario envíe un archivo/imagen
        if (nodeTags.includes('ARCHIVO')) {
            let msg = await this.replaceOrderSummary(node.message, jid);
            if (!msg) msg = `📎 Por favor, enviá el archivo solicitado:`;
            msg += `\n\n_Escribe *v* para volver atrás._\n_Escribe *0* para volver al inicio._`;
            await this.sendPresenceTyping(sock, jid);
            await sock.sendMessage(jid, { text: msg });
            this.stateService.setWaitingForFile(jid, node.id);
            this.stateService.setUserState(jid, node.id);
            return;
        }

        // 1b2. TURNO: inicia el flujo de reserva (fecha → horario → confirmación → Calendar)
        if (nodeTags.includes('TURNO')) {
            await this._iniciarReserva(sock, jid, node);
            return;
        }

        // 1c. COMPLETAR: completa un ítem pendiente (cantidad + producto + variante)
        // Soporta cadenas: item -> completar -> completar -> ... -> menú principal
        if (nodeTags.includes('COMPLETAR')) {
            const pending = this.stateService.getPendingOrderItem(jid);
            if (pending) {
                // Ver si este completar tiene más hijos (sigue la cadena)
                const nextChildren = await this.googleSheetsService.getNodesByParent(node.id);

                if (nextChildren.length > 0) {
                    // Paso intermedio: acumular título en el pending y mostrar siguiente hijo
                    this.stateService.setPendingOrderItem(jid, {
                        quantity: pending.quantity,
                        title: `${pending.title} (${node.title})`
                    });
                    await this.sendPresenceTyping(sock, jid);
                    await sock.sendMessage(jid, { text: `✅ Elegiste: ${pending.title} -> ${node.title}` });
                    await this.processNode(sock, jid, nextChildren[0]);
                    return;
                }

                // Último eslabón: agrega al carrito y navega según redirigirA
                const itemTitle = `${pending.quantity} x ${pending.title} (${node.title})`;
                this.stateService.addItemToOrder(jid, {
                    text: itemTitle,
                    price: parseFloat(String(node.price || '0').replace(',', '.')) || 0,
                    quantity: pending.quantity
                });
                this.stateService.clearPendingOrderItem(jid);

                // Si tiene redirigirA, va allí; si no, sube al menú categoría
                const cantParent = await this.googleSheetsService.getNodeById(node.parentId);
                const categoryId = cantParent ? cantParent.parentId : 'root';
                const targetId = node.redirigirA || categoryId;

                await this.sendPresenceTyping(sock, jid);
                await sock.sendMessage(jid, { text: `✅ Añadido: ${itemTitle}` });
                await this.sendMenu(sock, jid, targetId);

                if (nodeTags.includes('FINALIZAR')) {
                    await this._finalizeOrder(jid);
                }
                return;
            }

            let finalMessage = await this.replaceOrderSummary(node.message, jid);
            finalMessage += `\n\n_Escribe *0* para volver al inicio._`;
            await this.sendPresenceTyping(sock, jid);
            await sock.sendMessage(jid, { text: finalMessage });

            if (nodeTags.includes('FINALIZAR')) {
                await this._finalizeOrder(jid);
            }

            this.stateService.setUserState(jid, node.id);
            return;
        }

        // 2. Tiene hijos: mostrar submenú
        if (subOptions.length > 0) {
            await this.sendMenu(sock, jid, node.id);
            return;
        }

        // 3. Nodo hoja: muestra su mensaje y redirige según redirigirA
        let finalMessage = await this.replaceOrderSummary(node.message, jid);
        finalMessage += `\n\n_Escribe *0* para volver al inicio._`;
        await this.sendPresenceTyping(sock, jid);
        await sock.sendMessage(jid, { text: finalMessage });

        if (nodeTags.includes('FINALIZAR')) {
            await this._finalizeOrder(jid);
        }

        if (node.redirigirA) {
            await this.sendMenu(sock, jid, node.redirigirA);
        } else {
            this.stateService.setUserState(jid, node.id);
        }
    }

    /**
     * Limpia tags internos y genera el resumen visual del pedido (items + total)
     */
    async replaceOrderSummary(text, jid) {
        if (!text) return '';

        // Eliminar tags internos para que no se muestren al cliente
        let cleanText = text
            .replace('##PEDIDO##', '')
            .replace('##CANTIDAD##', '')
            .replace('##FINALIZAR##', '')
            .replace('##DATOS##', '')
            .replace('##ARCHIVO##', '')
            .replace('##COMPLETAR##', '')
            .replace('##PAGAR##', '')
            .replace('##TURNO##', '')
            .replace('##MISTURNOS##', '')
            .trim();

        const order = this.stateService.getUserOrder(jid);
        if (order.length === 0) return cleanText;

        const menu = await this.googleSheetsService.getMenuData();

        // CÁLCULO DE TOTALES
        let total = 0;
        let hasPrices = false;
        const detailedOrder = [];

        for (const item of order) {
            if (typeof item === 'string') {
                // Fallback para strings viejos
                const parts = item.split(' x ');
                if (parts.length === 2) {
                    const qty = parseInt(parts[0]);
                    const node = menu.find(n => n.title === parts[1]);
                    if (node && node.price) {
                        const price = parseFloat(String(node.price).replace(',', '.'));
                        if (!isNaN(price)) {
                            total += qty * price;
                            hasPrices = true;
                            detailedOrder.push(`${item} ($${price * qty})`);
                            continue;
                        }
                    }
                }
                detailedOrder.push(item);
                continue;
            }

            // Objeto: { text, price, quantity }
            const itemTotal = item.price * item.quantity;
            total += itemTotal;
            if (item.price > 0) hasPrices = true;
            detailedOrder.push(`${item.text}${item.price > 0 ? ` ($${itemTotal})` : ''}`);
        }

        // Crear bloque visual de resumen
        let summary = `\n\n🛍️ *Tu pedido:* \n${detailedOrder.join('\n')}`;
        
        if (hasPrices) {
            summary += `\n\n💰 *Total: $${total}*`;
        }

        return cleanText + summary;
    }

    async _finalizeOrder(jid) {
        try {
            if (!this.orderService) return;
            const order = this.stateService.getUserOrder(jid);
            if (order.length > 0) {
                const datosText = this.stateService.getDatosText(jid);
                await this.orderService.saveOrder(
                    this.stateService.clientId,
                    jid,
                    order,
                    datosText
                );
            }
        } catch (error) {
            console.error(`[ERROR] _finalizeOrder failed for ${jid}:`, error);
        } finally {
            this.stateService.clearUserOrder(jid);
            this.stateService.clearDatosText(jid);
            this.stateService.clearPendingQuantityItem(jid);
            this.stateService.clearPendingOrderItem(jid);
            this.stateService.clearWaitingForData(jid);
            this.stateService.clearWaitingForFile(jid);
        }
    }

    /**
     * Inicia el flujo de reserva de turno desde un nodo con tag ##TURNO##
     */
    async _iniciarReserva(sock, jid, node) {
        const cfg = await botConfigService.getBotConfig(this.stateService.clientId);
        const cc = cfg.calendar_config || {};
        if (cfg.bot_type !== 'TURNOS' || !cc.calendar_id) {
            await this.sendPresenceTyping(sock, jid);
            await sock.sendMessage(jid, { text: '⏳ El servicio de turnos no está configurado. Por favor escribinos para reservar.' });
            await this.sendMenu(sock, jid, node.parentId || 'root');
            return;
        }

        let msg = await this.replaceOrderSummary(node.message, jid);
        msg += `\n\n📅 *¿Para qué día querés tu turno?*\n\n_Escribí la fecha (ej: *25/12* o *25/12/2026*)._`;
        msg += `\n\n_Escribe *v* para volver atrás._`;
        await this.sendPresenceTyping(sock, jid);
        await sock.sendMessage(jid, { text: msg });
        this.stateService.setWaitingTurnoDate(jid, { id: node.id, title: node.title || '' });
        this.stateService.setUserState(jid, node.id);
    }

    /**
     * Procesa la fecha ingresada: valida y muestra los horarios disponibles
     */
    async _handleTurnoDate(sock, jid, text) {
        const nodeData = this.stateService.getWaitingTurnoDate(jid);
        const nodeId = (nodeData && nodeData.id) || nodeData;

        if (text === 'v' || text === 'atras' || text === 'atrás') {
            this.stateService.clearBookingFlow(jid);
            const node = await this.googleSheetsService.getNodeById(nodeId);
            await this.sendMenu(sock, jid, node ? node.parentId : 'root');
            return;
        }
        if (text === '0') {
            this.stateService.clearBookingFlow(jid);
            await this.sendMenu(sock, jid, 'root');
            return;
        }

        const fecha = this._parseFechaArg(text);
        if (!fecha) {
            await this.sendPresenceTyping(sock, jid);
            await sock.sendMessage(jid, { text: '❌ No entendí la fecha. Escribila así: *25/12* o *25/12/2026*.' });
            return;
        }

        const cfg = await botConfigService.getBotConfig(this.stateService.clientId);
        const cc = cfg.calendar_config || {};

        let slots = [];
        let ocupados = [];
        try {
            const result = await calendarService.consultarDisponibilidadConOcupados({
                calendarId: cc.calendar_id,
                fecha,
                duracionMin: cc.slot_duration_minutes || 30,
                businessHours: cc.business_hours || {},
                minNoticeHours: cc.min_notice_hours || 0
            });
            slots = result.slots;
            ocupados = result.ocupados;
        } catch (err) {
            console.error('[Turnos] Error consultando disponibilidad:', err.message);
            await this.sendPresenceTyping(sock, jid);
            await sock.sendMessage(jid, { text: '❌ Ocurrió un error consultando la disponibilidad. Intentá en unos minutos.' });
            return;
        }

        this.stateService.clearWaitingTurnoDate(jid);

        const waitlistEnabled = cc.waitlist_enabled === true || cc.waitlist_enabled === 'true';

        if (slots.length === 0 && (!waitlistEnabled || ocupados.length === 0)) {
            await this.sendPresenceTyping(sock, jid);
            await sock.sendMessage(jid, {
                text: `😕 No hay horarios disponibles para el *${this._fmtFecha(fecha)}*.\n\nProbá con otro día.`
            });
            this.stateService.setWaitingTurnoDate(jid, { id: nodeId, title: (nodeData && nodeData.title) || '' });
            return;
        }

        const session = {
            nodeId,
            nodeTitle: (nodeData && nodeData.title) || '',
            fecha,
            calendarId: cc.calendar_id,
            duracionMin: cc.slot_duration_minutes || 30,
            slots,
            ocupados,
            waitlistEnabled
        };
        this.stateService.setWaitingTurnoSlot(jid, session);

        let msg = `📅 *Horarios para el ${this._fmtFecha(fecha)}:*\n\n`;
        slots.forEach((s, i) => { msg += `*${i + 1}*. ${s.label}\n`; });

        // Mostrar ocupados tachados (solo si la lista de espera está activa)
        if (waitlistEnabled && ocupados.length > 0) {
            msg += `\n_Ocupados (podés solicitar que te avisen si se libera):_\n`;
            ocupados.forEach((s, i) => {
                msg += `*${slots.length + i + 1}*. ~~${s.label}~~ (solicitar si cancela)\n`;
            });
        }

        msg += `\n_Escribí el número del horario que preferís._`;
        msg += `\n\n_Escribe *v* para elegir otra fecha._`;
        await this.sendPresenceTyping(sock, jid);
        await sock.sendMessage(jid, { text: msg });
    }

    /**
     * Procesa la elección de horario y solicita el nombre
     */
    async _handleTurnoSlot(sock, jid, text) {
        const session = this.stateService.getWaitingTurnoSlot(jid);

        if (text === 'v' || text === 'atras' || text === 'atrás') {
            this.stateService.clearWaitingTurnoSlot(jid);
            this.stateService.setWaitingTurnoDate(jid, { id: session.nodeId, title: session.nodeTitle || '' });
            await this.sendPresenceTyping(sock, jid);
            await sock.sendMessage(jid, { text: '📅 ¿Para qué día querés tu turno?' });
            return;
        }
        if (text === '0') {
            this.stateService.clearBookingFlow(jid);
            await this.sendMenu(sock, jid, 'root');
            return;
        }

        const idx = parseInt(text, 10) - 1;

        // El usuario eligió un horario ocupado -> anotarse en lista de espera
        if (session.waitlistEnabled && idx >= session.slots.length && idx < session.slots.length + (session.ocupados || []).length) {
            const ocupado = session.ocupados[idx - session.slots.length];
            this.stateService.clearWaitingTurnoSlot(jid);
            this.stateService.setWaitingTurnoWaitlistName(jid, { ...session, slot: ocupado });
            await this.sendPresenceTyping(sock, jid);
            await sock.sendMessage(jid, {
                text: `✅ Anotaste para avisarte si se libera *${this._fmtFecha(session.fecha)} a las ${ocupado.label}*.\n\n📝 ¿Cuál es tu nombre?`
            });
            return;
        }

        const slot = session.slots[idx];
        if (!slot) {
            await this.sendPresenceTyping(sock, jid);
            await sock.sendMessage(jid, { text: '❌ Opción inválida. Escribí el número de un horario de la lista.' });
            return;
        }

        this.stateService.clearWaitingTurnoSlot(jid);
        this.stateService.setWaitingTurnoConfirm(jid, { ...session, slot, nombre: '' });

        await this.sendPresenceTyping(sock, jid);
        await sock.sendMessage(jid, {
            text: `✅ Elegiste *${this._fmtFecha(session.fecha)} a las ${slot.label}*.\n\n📝 ¿Cuál es tu nombre?`
        });
    }

    /**
     * Procesa la confirmación: recibe el nombre y confirma la reserva
     */
    async _handleTurnoConfirm(sock, jid, text) {
        const session = this.stateService.getWaitingTurnoConfirm(jid);

        if (text === 'v' || text === 'atras' || text === 'atrás') {
            this.stateService.clearWaitingTurnoConfirm(jid);
            this.stateService.setWaitingTurnoSlot(jid, session);
            const msg = `📅 *Horarios disponibles para el ${this._fmtFecha(session.fecha)}:*\n\n` +
                session.slots.map((s, i) => `*${i + 1}*. ${s.label}`).join('\n') +
                `\n\n_Escribí el número del horario que preferís._`;
            await this.sendPresenceTyping(sock, jid);
            await sock.sendMessage(jid, { text: msg });
            return;
        }
        if (text === '0') {
            this.stateService.clearBookingFlow(jid);
            await this.sendMenu(sock, jid, 'root');
            return;
        }

        if (!session.nombre) {
            if (!text || text.trim().length < 2) {
                await this.sendPresenceTyping(sock, jid);
                await sock.sendMessage(jid, { text: '📝 Por favor escribí tu nombre.' });
                return;
            }
            session.nombre = text.trim();
            this.stateService.setWaitingTurnoConfirm(jid, session);

            await this.sendPresenceTyping(sock, jid);
            const resumen = `📋 *Resumen de tu turno:*\n\n` +
                (session.nodeTitle ? `🏷️ Servicio: *${session.nodeTitle}*\n` : '') +
                `📅 Fecha: *${this._fmtFecha(session.fecha)}*\n` +
                `⏰ Hora: *${session.slot.label}*\n` +
                `👤 Nombre: *${session.nombre}*\n\n` +
                `¿Confirmás la reserva?\n\n*1*. Sí, confirmar\n*2*. No, cancelar`;
            await sock.sendMessage(jid, { text: resumen });
            return;
        }

        if (text === '1') {
            this.stateService.clearBookingFlow(jid);
            try {
                const category = session.nodeTitle ? `${session.nodeTitle}: ` : '';
                const event = await calendarService.agendarTurno({
                    calendarId: session.calendarId,
                    summary: `${category}${session.nombre}`,
                    description: `Turno reservado vía Bot Menu.\nServicio: ${session.nodeTitle || '-'}\nTeléfono: ${jid}\nNombre: ${session.nombre}`,
                    fechaInicioISO: session.slot.startISO,
                    fechaFinISO: session.slot.endISO
                });
                await botConfigService.registrarTurno({
                    googleEventId: event.id,
                    idCliente: this.stateService.clientId,
                    clienteTelefono: jid,
                    clienteNombre: session.nombre,
                    fechaInicio: session.slot.startISO,
                    fechaFin: session.slot.endISO
                });
                await this.sendPresenceTyping(sock, jid);
                await sock.sendMessage(jid, {
                    text: `✅ *Turno confirmado!*\n\n` +
                        `📅 ${this._fmtFecha(session.fecha)} a las *${session.slot.label}*\n` +
                        `👤 ${session.nombre}\n\nTe esperamos.\n\n_Escribe *0* para volver al menú principal._`
                });
            } catch (err) {
                console.error('[Turnos] Error agendando turno:', err.message);
                await this.sendPresenceTyping(sock, jid);
                await sock.sendMessage(jid, { text: '❌ No se pudo confirmar el turno. Intentá de nuevo más tarde.' });
            }
            return;
        }

        if (text === '2') {
            this.stateService.clearBookingFlow(jid);
            await this.sendPresenceTyping(sock, jid);
            await sock.sendMessage(jid, { text: '🚫 Reserva cancelada.' });
            await this._preguntarReprogramar(sock, jid, session.nodeId);
            return;
        }

        await this.sendPresenceTyping(sock, jid);
        await sock.sendMessage(jid, { text: '❌ Respondé *1* para confirmar o *2* para cancelar.' });
    }

    /**
     * Ofrece reprogramar el turno al cliente tras una cancelación.
     * Si la reprogramación está deshabilitada, solo indica cómo volver al menú.
     * nodeId: nodo del turno (o 'root' si no hay contexto de reserva).
     */
    async _preguntarReprogramar(sock, jid, nodeId) {
        const cfg = await botConfigService.getBotConfig(this.stateService.clientId);
        const cc = cfg.calendar_config || {};
        const reprogramar = cc.reprogramar_enabled !== false;

        if (!reprogramar) {
            await this.sendPresenceTyping(sock, jid);
            await sock.sendMessage(jid, { text: '_Escribe *0* para volver al menú principal._' });
            return;
        }

        await this.sendPresenceTyping(sock, jid);
        await sock.sendMessage(jid, {
            text: `🔄 ¿Te gustaría reprogramar el turno para otro momento?\n\n*1*. Sí\n*2*. No\n\n_Escribe *0* para volver al menú principal._`
        });
        this.stateService.setWaitingTurnoReprogram(jid, { nodeId: nodeId || 'root' });
    }

    /**
     * Procesa la respuesta a la oferta de reprogramar: 1 = sí (arranca reserva), 2 = no (termina).
     */
    async _handleTurnoReprogram(sock, jid, text) {
        const data = this.stateService.getWaitingTurnoReprogram(jid);
        const nodeId = (data && data.nodeId) || 'root';

        if (text === '0') {
            this.stateService.clearWaitingTurnoReprogram(jid);
            await this.sendMenu(sock, jid, 'root');
            return;
        }
        if (text === 'v' || text === 'atras' || text === 'atrás') {
            this.stateService.clearWaitingTurnoReprogram(jid);
            await this.sendMenu(sock, jid, 'root');
            return;
        }

        if (text === '1') {
            this.stateService.clearWaitingTurnoReprogram(jid);
            let node = null;
            if (nodeId !== 'root') {
                node = await this.googleSheetsService.getNodeById(nodeId);
            }
            if (!node) {
                node = { id: 'root', parentId: 'root', message: '🗓️ *Reprogramemos tu turno!*' };
            }
            await this._iniciarReserva(sock, jid, node);
            return;
        }

        if (text === '2') {
            this.stateService.clearWaitingTurnoReprogram(jid);
            await this.sendPresenceTyping(sock, jid);
            await sock.sendMessage(jid, { text: 'Listo. Si más adelante querés reservar otro turno, escribinos de nuevo.\n\n_Escribe *0* para volver al menú principal._' });
            return;
        }

        await this.sendPresenceTyping(sock, jid);
        await sock.sendMessage(jid, { text: '❌ Respondé *1* para reprogramar o *2* para no hacerlo.' });
    }

    /**
     * Anota al usuario en la lista de espera de un slot ocupado (recibe el nombre).
     */
    async _handleTurnoWaitlistName(sock, jid, text) {
        const session = this.stateService.getWaitingTurnoWaitlistName(jid);

        if (text === 'v' || text === 'atras' || text === 'atrás') {
            this.stateService.clearWaitingTurnoWaitlistName(jid);
            this.stateService.setWaitingTurnoDate(jid, { id: session.nodeId, title: session.nodeTitle || '' });
            await this.sendPresenceTyping(sock, jid);
            await sock.sendMessage(jid, { text: '📅 ¿Para qué día querés tu turno?' });
            return;
        }
        if (text === '0') {
            this.stateService.clearBookingFlow(jid);
            await this.sendMenu(sock, jid, 'root');
            return;
        }

        if (!text || text.trim().length < 2) {
            await this.sendPresenceTyping(sock, jid);
            await sock.sendMessage(jid, { text: '📝 Por favor escribí tu nombre.' });
            return;
        }

        const slot = session.slot;
        await botConfigService.registrarEnListaEspera({
            idCliente: this.stateService.clientId,
            fechaInicio: slot.startISO,
            clienteTelefono: jid,
            clienteNombre: text.trim()
        });

        this.stateService.clearWaitingTurnoWaitlistName(jid);
        await this.sendPresenceTyping(sock, jid);
        await sock.sendMessage(jid, {
            text: `✅ Listo, ${text.trim()}!\n\nQuedaste en la lista de espera para *${this._fmtFecha(session.fecha)} a las ${slot.label}*.\n\nSi se libera ese horario, te avisamos por acá para confirmarlo.\n\n_Escribe *0* para volver al menú principal._`
        });
    }

    /**
     * Procesa la respuesta al recordatorio: 1 = confirmar, 2 = cancelar (libera y dispara cascada).
     */
    async _handleTurnoReminder(sock, jid, text) {
        const data = this.stateService.getWaitingTurnoReminder(jid);
        const proximidad = data && data.proximidad;
        const cancelar = data && data.cancelar;

        if (text === '0') {
            this.stateService.clearWaitingTurnoReminder(jid);
            await this.sendMenu(sock, jid, 'root');
            return;
        }

        if (text === '1') {
            await botConfigService.actualizarEstadoTurno(data.eventId, 'confirmado');
            this.stateService.clearWaitingTurnoReminder(jid);
            await this.sendPresenceTyping(sock, jid);
            await sock.sendMessage(jid, {
                text: `✅ *Confirmado!*\n\nTe esperamos el *${data.fecha} a las ${data.hora}*.`
            });
            return;
        }

        if (text === '2' && cancelar && !proximidad) {
            this.stateService.clearWaitingTurnoReminder(jid);
            await this._cancelarTurnoYDispararCascada(sock, jid, data.eventId, data.fecha, data.hora);
            return;
        }

        await this.sendPresenceTyping(sock, jid);
        await sock.sendMessage(jid, { text: (proximidad || !cancelar) ? '❌ Respondé *1* para confirmar tu turno o *0* para salir.' : '❌ Respondé *1* para confirmar tu turno o *2* para cancelarlo.' });
    }

    /**
     * Procesa la respuesta a la oferta de la lista de espera: 1 = aceptar, 2 = pasar al siguiente.
     */
    async _handleTurnoCascada(sock, jid, text) {
        const data = this.stateService.getWaitingTurnoCascada(jid);

        if (text === '0') {
            this.stateService.clearWaitingTurnoCascada(jid);
            await this.sendMenu(sock, jid, 'root');
            return;
        }

        if (text === '1') {
            const turno = await botConfigService.getTurnoByGoogleEventId(data.eventId);
            this.stateService.clearWaitingTurnoCascada(jid);
            if (!turno) {
                await this.sendPresenceTyping(sock, jid);
                await sock.sendMessage(jid, { text: '❌ Este horario ya no está disponible. Disculpá.' });
                return;
            }

            try {
                const category = data.nodeTitle ? `${data.nodeTitle}: ` : '';
                const event = await calendarService.agendarTurno({
                    calendarId: data.calendarId,
                    summary: `${category}${data.nombre}`,
                    description: `Turno reservado vía Bot Menu (lista de espera).\nServicio: ${data.nodeTitle || '-'}\nTeléfono: ${jid}\nNombre: ${data.nombre}`,
                    fechaInicioISO: data.startISO,
                    fechaFinISO: data.endISO
                });
                await botConfigService.registrarTurno({
                    googleEventId: event.id,
                    idCliente: this.stateService.clientId,
                    clienteTelefono: jid,
                    clienteNombre: data.nombre,
                    fechaInicio: data.startISO,
                    fechaFin: data.endISO
                });
                await botConfigService.marcarEstadoListaEspera(data.idCola, 'aceptado');
                await botConfigService.actualizarEstadoTurno(data.eventId, 'cancelado');
                await this.sendPresenceTyping(sock, jid);
                await sock.sendMessage(jid, {
                    text: `✅ *Turno confirmado!*\n\n📅 ${data.fecha} a las *${data.hora}*\n\nTe esperamos.`
                });
            } catch (err) {
                console.error('[Turnos] Error confirmando turno de lista de espera:', err.message);
                await this.sendPresenceTyping(sock, jid);
                await sock.sendMessage(jid, { text: '❌ No se pudo confirmar el horario. Intentá más tarde.' });
            }
            await this.sendMenu(sock, jid, 'root');
            return;
        }

        if (text === '2') {
            this.stateService.clearWaitingTurnoCascada(jid);
            await botConfigService.marcarEstadoListaEspera(data.idCola, 'descartado');
            await this.sendPresenceTyping(sock, jid);
            await sock.sendMessage(jid, { text: '👍 Perfecto, pasamos al siguiente de la lista.' });
            // Continuar la cascada con el siguiente de la cola
            await this._ofrecerCascada(sock, data.eventId, data.calendarId, data.startISO, data.endISO, data.nodeTitle);
            return;
        }

        await this.sendPresenceTyping(sock, jid);
        await sock.sendMessage(jid, { text: '❌ Respondé *1* para quedarte con el horario o *2* para pasarlo.' });
    }

    /**
     * Muestra los turnos del usuario con opciones confirmar/cancelar (opción "Mis turnos" del menú).
     */
    async _mostrarMisTurnos(sock, jid, node) {
        const todos = await botConfigService.getTurnosByTelefono(this.stateService.clientId, jid);
        const todayStr = this._argTodayStr();
        const now = new Date().getTime();

        // Clasifico: oculto turnos de hace más de un día; los del día de hoy que ya
        // pasaron se muestran tachados (no seleccionables); el resto son seleccionables.
        const display = [];
        const seleccionables = [];
        for (const t of todos) {
            const fechaArg = this._argDateStrOf(t.fecha_inicio);
            if (!fechaArg) continue;
            if (fechaArg < todayStr) continue; // más antiguo que hoy: no mostrar
            const paso = fechaArg === todayStr && new Date(t.fecha_inicio).getTime() <= now;
            display.push({ turno: t, paso });
            if (!paso) seleccionables.push(t);
        }

        if (display.length === 0) {
            await this.sendPresenceTyping(sock, jid);
            await sock.sendMessage(jid, { text: '📭 No tenés turnos reservados por ahora.' });
            await this.sendMenu(sock, jid, node ? (node.redirigirA || node.parentId || 'root') : 'root');
            return;
        }

        // Guardar solo los seleccionables para la elección numerada
        this.stateService.setMisTurnos(jid, seleccionables);

        let msg = `🗓️ *Tus turnos:*\n\n`;
        let num = 0;
        display.forEach(({ turno: t, paso }) => {
            const fecha = this._fmtTurnoFecha(t.fecha_inicio);
            const hora = this._fmtTurnoHora(t.fecha_inicio);
            const estado = t.estado === 'confirmado' ? '✅' : (t.estado === 'recordado' ? '🔔' : '⏳');
            if (paso) {
                msg += `~${estado} ${fecha} a las ${hora} (${t.cliente_nombre || ''}) (vencido)~\n`;
            } else {
                num += 1;
                msg += `${estado} *${num}*. ${fecha} a las ${hora} (${t.cliente_nombre || ''})\n`;
            }
        });
        msg += `\n_Escribí el número de un turno para verlo. Escribe *0* para salir._`;

        await this.sendPresenceTyping(sock, jid);
        await sock.sendMessage(jid, { text: msg });
    }

    /**
     * Procesa la selección dentro de "mis turnos" (confirmar/cancelar).
     */
    async _handleMisTurnos(sock, jid, text) {
        const turnos = this.stateService.getMisTurnos(jid);

        if (text === '0' || text === 'v') {
            this.stateService.clearMisTurnos(jid);
            await this.sendMenu(sock, jid, 'root');
            return;
        }

        const idx = parseInt(text, 10) - 1;
        const turno = turnos && turnos[idx];
        if (!turno) {
            await this.sendPresenceTyping(sock, jid);
            await sock.sendMessage(jid, { text: '❌ Opción inválida. Escribí el número de un turno de la lista.' });
            return;
        }

        const fecha = this._fmtTurnoFecha(turno.fecha_inicio);
        const hora = this._fmtTurnoHora(turno.fecha_inicio);

        // Guardar el turno seleccionado para confirmar/cancelar
        this.stateService.setMisTurnoSeleccionado(jid, { eventId: turno.google_event_id, fecha, hora });
        await this.sendPresenceTyping(sock, jid);
        if (await this._misTurnosCancelarHabilitado()) {
            await sock.sendMessage(jid, {
                text: `📅 *${fecha} a las ${hora}*\n\n¿Qué querés hacer?\n\n*1*. Aceptar / confirmar\n*2*. Cancelar turno`
            });
        } else {
            await sock.sendMessage(jid, {
                text: `📅 *${fecha} a las ${hora}*\n\n¿Querés confirmar tu asistencia?\n\n*1*. Sí, confirmar\n*0*. Salir`
            });
        }
    }

    async _handleMisTurnosAccion(sock, jid, text) {
        const data = this.stateService.getMisTurnoSeleccionado(jid);

        if (text === '1') {
            await botConfigService.actualizarEstadoTurno(data.eventId, 'confirmado');
            this.stateService.clearMisTurnos(jid);
            this.stateService.clearMisTurnoSeleccionado(jid);
            await this.sendPresenceTyping(sock, jid);
            await sock.sendMessage(jid, { text: `✅ Turno *${data.fecha} a las ${data.hora}* confirmado. Te esperamos!` });
            await this.sendMenu(sock, jid, 'root');
            return;
        }

        if (text === '2') {
            if (!(await this._misTurnosCancelarHabilitado())) {
                await this.sendPresenceTyping(sock, jid);
                await sock.sendMessage(jid, { text: '❌ Opción no disponible.' });
                return;
            }
            this.stateService.clearMisTurnos(jid);
            this.stateService.clearMisTurnoSeleccionado(jid);
            await this._cancelarTurnoYDispararCascada(sock, jid, data.eventId, data.fecha, data.hora);
            return;
        }

        if (text === 'v' || text === '0') {
            this.stateService.clearMisTurnoSeleccionado(jid);
            if (text === '0') {
                this.stateService.clearMisTurnos(jid);
                await this.sendMenu(sock, jid, 'root');
                return;
            }
            await this._mostrarMisTurnos(sock, jid, null);
            return;
        }

        await this.sendPresenceTyping(sock, jid);
        const cancelar = await this._misTurnosCancelarHabilitado();
        await sock.sendMessage(jid, { text: cancelar ? '❌ Respondé *1* para confirmar o *2* para cancelar.' : '❌ Respondé *1* para confirmar o *0* para salir.' });
    }

    async _misTurnosCancelarHabilitado() {
        try {
            const cfg = await botConfigService.getBotConfig(this.stateService.clientId);
            const cc = cfg.calendar_config || {};
            return cc.mis_turnos_cancelar !== false;
        } catch (err) {
            console.error('[Turnos] Error leyendo config de cancelación:', err.message);
            return true;
        }
    }

    /**
     * Cancela un turno en Google Calendar, marca localmente y dispara la cascada de lista de espera.
     */
    async _cancelarTurnoYDispararCascada(sock, jid, eventId, fecha, hora) {
        try {
            const turno = await botConfigService.getTurnoByGoogleEventId(eventId);
            if (!turno) throw new Error('turno no encontrado');

            const cc = (await botConfigService.getBotConfig(this.stateService.clientId)).calendar_config || {};
            try {
                await calendarService.cancelarTurno({ calendarId: cc.calendar_id, eventId });
            } catch (e) {
                console.error('[Turnos] Error cancelando evento en Calendar (continúa local):', e.message);
            }
            await botConfigService.cancelarTurnoLocal(eventId);

            await this.sendPresenceTyping(sock, jid);
            await sock.sendMessage(jid, { text: `🗓️ *Tu turno del ${fecha} a las ${hora} fue cancelado.*` });

            if (cc.waitlist_enabled === true || cc.waitlist_enabled === 'true') {
                await this._ofrecerCascada(sock, eventId, cc.calendar_id, turno.fecha_inicio, turno.fecha_fin, '');
            }

            await this._preguntarReprogramar(sock, jid, 'root');
        } catch (err) {
            console.error('[Turnos] Error cancelando turno:', err.message);
            await this.sendPresenceTyping(sock, jid);
            await sock.sendMessage(jid, { text: '❌ No se pudo cancelar el turno. Intentá más tarde.\n\n_Escribe *0* para volver al menú principal._' });
        }
    }

    /**
     * Ofrece un slot liberado al primero de la lista de espera y continúa en cascada.
     * Los parámetros fechaInicio/fechaFin son TIMESTAMPTZ (Date) o ISO strings.
     */
    async _ofrecerCascada(sock, eventIdLibre, calendarId, fechaInicio, fechaFin, nodeTitle) {
        const startISO = fechaInicio instanceof Date ? fechaInicio.toISOString() : new Date(fechaInicio).toISOString();
        const endISO = fechaFin instanceof Date ? fechaFin.toISOString() : new Date(fechaFin).toISOString();

        const fila = await botConfigService.getListaEsperaParaSlot(this.stateService.clientId, startISO);
        if (!fila || fila.length === 0) return;

        const proximo = fila[0];
        const jidDestino = this._jidFromPhone(proximo.cliente_telefono);
        const fecha = this._fmtTurnoFecha(startISO);
        const hora = this._fmtTurnoHora(startISO);

        await botConfigService.marcarEstadoListaEspera(proximo.id, 'ofrecido');
        this.stateService.setWaitingTurnoCascada(jidDestino, {
            idCola: proximo.id,
            eventId: eventIdLibre,
            calendarId,
            startISO,
            endISO,
            fecha,
            hora,
            nombre: proximo.cliente_nombre,
            nodeTitle: nodeTitle || ''
        });

        try {
            await sock.sendMessage(jidDestino, {
                text: `🎉 ¡Se liberó un horario! *${fecha} a las ${hora}*.\n\n¿Lo querés para vos?\n\n*1*. Sí, lo quiero\n*2*. No, gracias`
            });
        } catch (err) {
            console.error('[Turnos] Error ofreciendo turno de lista de espera:', err.message);
            await botConfigService.marcarEstadoListaEspera(proximo.id, 'descartado');
            this.stateService.clearWaitingTurnoCascada(jidDestino);
            await this._ofrecerCascada(sock, eventIdLibre, calendarId, fechaInicio, fechaFin, nodeTitle);
        }
    }

    /**
     * Motor de recordatorios (llamado por reminderService): envía recordatorios
     * a turnos próximos respetando la ventana de no-molestar 8-22 (Argentina).
     */
    async procesarRecordatorios(sock) {
        const cfg = await botConfigService.getBotConfig(this.stateService.clientId);
        const cc = cfg.calendar_config || {};
        if (cfg.bot_type !== 'TURNOS' || !cc.calendar_id || !(cc.reminder_enabled === true || cc.reminder_enabled === 'true')) {
            return;
        }
        if (!this._isQuietTimeOk()) return;

        // PASE 1: recordatorio de "largo plazo" (según reminder_hours_before).
        // Solo a turnos aún no recordados (estado 'activo'). Incluye confirmar/cancelar.
        const horas = cc.reminder_hours_before || 24;
        const cancelarEnRecordatorio = cc.recordatorio_cancelar !== false;
        const turnosLargo = await botConfigService.getTurnosARecordar(this.stateService.clientId, horas);
        for (const t of turnosLargo || []) {
            await this._enviarRecordatorio(sock, t, { proximidad: false, cancelar: cancelarEnRecordatorio });
        }

        // PASE 2: recordatorio de "proximidad" (2 hs antes).
        // Se envía igual si el turno ya fue confirmado, pero SIN opción de cancelar.
        const turnosCercanos = await botConfigService.getTurnosProximos(this.stateService.clientId, 2);
        for (const t of turnosCercanos || []) {
            await this._enviarRecordatorio(sock, t, { proximidad: true, cancelar: false });
        }
    }

    async _enviarRecordatorio(sock, t, { proximidad, cancelar }) {
        try {
            const fecha = this._fmtTurnoFecha(t.fecha_inicio);
            const hora = this._fmtTurnoHora(t.fecha_inicio);
            const jidDestino = this._jidFromPhone(t.cliente_telefono);
            let text;
            if (proximidad) {
                text = `⏰ *Tu turno es ahora cercano*\n\n📅 ${fecha} a las *${hora}*\n\n¿Confirmás tu asistencia?\n\n*1*. Sí, confirmo\n*0*. Salir`;
            } else if (cancelar) {
                text = `🔔 *Recordatorio de tu turno*\n\n📅 ${fecha} a las *${hora}*\n\n*1*. Confirmar asistencia\n*2*. Cancelar turno`;
            } else {
                text = `🔔 *Recordatorio de tu turno*\n\n📅 ${fecha} a las *${hora}*`;
            }

            await sock.sendMessage(jidDestino, { text });
            await botConfigService.marcarRecordatorioEnviado(t.google_event_id);
            if (!proximidad && !cancelar) return; // solo notificación, sin interacción
            this.stateService.setWaitingTurnoReminder(jidDestino, { eventId: t.google_event_id, fecha, hora, proximidad: !!proximidad, cancelar: !!cancelar });
        } catch (err) {
            console.error('[Turnos] Error enviando recordatorio:', err.message);
        }
    }

    /**
     * Devuelve true si la hora actual en Argentina está dentro de 8:00 - 22:00 (no molestar).
     */
    _isQuietTimeOk() {
        const parts = new Intl.DateTimeFormat('en-GB', {
            timeZone: 'America/Argentina/Buenos_Aires',
            hour: '2-digit',
            minute: '2-digit',
            hour12: false
        }).formatToParts(new Date());
        const hour = parseInt((parts.find(p => p.type === 'hour') || {}).value || '0', 10);
        return hour >= 8 && hour < 22;
    }

    _jidFromPhone(telefono) {
        if (!telefono) return telefono;
        const numero = String(telefono).split('@')[0];
        return numero.includes('@') ? numero : `${numero}@s.whatsapp.net`;
    }

    /**
     * Formatea un TIMESTAMPTZ (Date o string ISO) a 'DD/MM/YYYY' en Argentina.
     */
    _fmtTurnoFecha(valor) {
        const fecha = new Date(valor);
        return new Intl.DateTimeFormat('es-AR', {
            timeZone: 'America/Argentina/Buenos_Aires',
            day: '2-digit',
            month: '2-digit',
            year: 'numeric'
        }).format(fecha);
    }

    /**
     * Formatea un TIMESTAMPTZ (Date o string ISO) a 'HH:MM' en Argentina.
     */
    _fmtTurnoHora(valor) {
        const fecha = new Date(valor);
        return new Intl.DateTimeFormat('es-AR', {
            timeZone: 'America/Argentina/Buenos_Aires',
            hour: '2-digit',
            minute: '2-digit',
            hour12: false
        }).format(fecha);
    }

    /**
     * Devuelve la fecha de hoy en Argentina como 'YYYY-MM-DD'
     */
    _argTodayStr() {
        return new Intl.DateTimeFormat('en-CA', {
            timeZone: 'America/Argentina/Buenos_Aires',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit'
        }).format(new Date());
    }

    _argDateStrOf(valor) {
        if (!valor) return '';
        try {
            return new Intl.DateTimeFormat('en-CA', {
                timeZone: 'America/Argentina/Buenos_Aires',
                year: 'numeric',
                month: '2-digit',
                day: '2-digit'
            }).format(new Date(valor));
        } catch (err) {
            return '';
        }
    }

    /**
     * Parsea el texto del usuario a 'YYYY-MM-DD'. Acepta DD/MM, DD/MM/YYYY, YYYY-MM-DD, hoy, mañana.
     */
    _parseFechaArg(text) {
        const t = String(text || '').trim().toLowerCase();
        if (t === 'hoy') return this._argTodayStr();
        if (t === 'mañana' || t === 'manana') {
            const hoy = new Date(`${this._argTodayStr()}T12:00:00-03:00`);
            return new Date(hoy.getTime() + 24 * 3600 * 1000).toISOString().slice(0, 10);
        }

        let d, m, y;
        if (/^\d{1,2}\/\d{1,2}(\/\d{2,4})?$/.test(t)) {
            const parts = t.split('/');
            d = parseInt(parts[0], 10);
            m = parseInt(parts[1], 10);
            y = parts[2] ? parseInt(parts[2], 10) : new Date().getFullYear();
            if (y < 100) y += 2000;
        } else if (/^\d{4}-\d{1,2}-\d{1,2}$/.test(t)) {
            const parts = t.split('-');
            y = parseInt(parts[0], 10);
            m = parseInt(parts[1], 10);
            d = parseInt(parts[2], 10);
        } else {
            return null;
        }

        if (!y || !m || !d || m < 1 || m > 12 || d < 1 || d > 31) return null;
        const dateStr = `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
        const dt = new Date(`${dateStr}T12:00:00-03:00`);
        if (isNaN(dt.getTime())) return null;
        if (dt.toISOString().slice(0, 10) !== dateStr) return null;
        return dateStr;
    }

    /**
     * Formatea 'YYYY-MM-DD' a 'DD/MM/YYYY'
     */
    _fmtFecha(fechaStr) {
        const [y, m, d] = String(fechaStr || '').split('-');
        return `${d}/${m}/${y}`;
    }

    /**
     * Indica si el bot debe atender ahora, según el horario configurado
     * (hora local de Argentina, no la del servidor). Si el cliente está
     * en 24/7 o no tiene configuración, siempre está abierto.
     */
    async _isOpenNow() {
        const users = await userService.getUsers();
        const client = users.find(u => u.idCliente === this.stateService.clientId);
        if (!client || client.online24_7 !== false) {
            return { open: true, text: '' };
        }

        const horarios = this._parseHorarios(client.horarios);
        const now = new Date();
        const parts = new Intl.DateTimeFormat('en-GB', {
            timeZone: 'America/Argentina/Buenos_Aires',
            weekday: 'short',
            hour: '2-digit',
            minute: '2-digit',
            hour12: false
        }).formatToParts(now);

        const getPart = type => {
            const p = parts.find(x => x.type === type);
            return p ? p.value : '';
        };

        const dayMap = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 0 };
        const dow = dayMap[getPart('weekday')];
        const minutes = parseInt(getPart('hour'), 10) * 60 + parseInt(getPart('minute'), 10);

        const ranges = horarios[String(dow)] || [];
        const open = ranges.some(r => this._inRange(minutes, r));

        return { open, text: this._formatHorarios(horarios) };
    }

    _parseHorarios(str) {
        try {
            const obj = typeof str === 'string' && str ? JSON.parse(str) : (str || {});
            const clean = {};
            for (const [k, v] of Object.entries(obj || {})) {
                if (!/^[0-6]$/.test(k) || !Array.isArray(v)) continue;
                clean[k] = v
                    .filter(r => r && r.desde && r.hasta)
                    .map(r => ({ desde: String(r.desde).slice(0, 5), hasta: String(r.hasta).slice(0, 5) }));
            }
            return clean;
        } catch (e) {
            return {};
        }
    }

    _inRange(minutes, r) {
        const [h1, m1] = String(r.desde || '').split(':').map(Number);
        const [h2, m2] = String(r.hasta || '').split(':').map(Number);
        if (isNaN(h1) || isNaN(h2)) return false;
        const start = h1 * 60 + m1;
        let end = h2 * 60 + m2;
        if (end <= start) end += 24 * 60; // rango nocturno (ej: 22:00 a 02:00)
        if (start <= minutes && minutes < end) return true;
        if (end > 24 * 60 && minutes < end - 24 * 60) return true;
        return false;
    }

    _formatHorarios(horarios) {
        const names = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
        const order = [1, 2, 3, 4, 5, 6, 0];
        const groups = [];
        let cur = null;

        for (const dow of order) {
            const ranges = horarios[String(dow)] || [];
            if (ranges.length === 0) { cur = null; continue; }
            const key = ranges.map(r => `${r.desde}-${r.hasta}`).join(',');
            if (cur && cur.key === key) {
                cur.days.push(dow);
            } else {
                cur = { key, days: [dow], ranges };
                groups.push(cur);
            }
        }

        if (groups.length === 0) return 'Cerrado todos los días.';

        const fmtRange = rs => rs.map(r => `${r.desde} a ${r.hasta}`).join(' y ');
        return groups.map(g => {
            const days = g.days;
            const label = days.length === 1
                ? names[days[0]]
                : `${names[days[0]]} a ${names[days[days.length - 1]]}`;
            return `${label}: ${fmtRange(g.ranges)}`;
        }).join('\n');
    }
}

module.exports = MenuController;