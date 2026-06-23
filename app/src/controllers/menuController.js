/**
 * MenuController: El "cerebro" del bot.
 * Gestiona la lógica de navegación, el estado del usuario y la interacción con WhatsApp.
 */
class MenuController {
    constructor(googleSheetsService, stateService) {
        this.googleSheetsService = googleSheetsService; // Servicio para leer datos de Google Sheets
        this.stateService = stateService;             // Servicio para gestionar estados y carritos de usuarios
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
                    this.stateService.clearUserOrder(jid);
                }
                await sock.sendMessage(jid, { text: '✅ Archivo recibido correctamente.\n\n_Escribe *0* para volver al inicio._' });
                this.stateService.setUserState(jid, 'root');
            }
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

            if (children.length > 0) {
                // Si hay un siguiente paso tras recibir datos, procesamos el primer hijo
                //console.log("El nodo espera datos pero tiene hijos, procesando el primer hijo #64");
                await this.processNode(sock, jid, children[0]);
                return;
            } else {
                // Si no hay más hijos, es el final del formulario.
                if (waitingNode && waitingNode.message && waitingNode.message.includes('##FINALIZAR##')) {
                    //console.log("nodo no tiene mas hijos #70");
                    ////console.log(`[Estado] Limpiando pedido de ${jid}. Motivo: Tag ##FINALIZAR## procesado tras recibir datos.`);
                    this.stateService.clearUserOrder(jid);
                }

                await sock.sendMessage(jid, { text: '✅ Datos recibidos correctamente.\n\n_Escribe *0* para volver al inicio._' });
                this.stateService.setUserState(jid, 'root');
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

            // Sin hijos: agrega directo al carrito y vuelve al menú padre
            const currentNode = await this.googleSheetsService.getNodeById(currentStateId);
            const parentId = currentNode ? currentNode.parentId : 'root';

            this.stateService.addItemToOrder(jid, {
                text: `${quantity} x ${pendingItem}`,
                price: parseFloat(String(currentNode?.price || '0').replace(',', '.')) || 0,
                quantity: quantity
            });

            await sock.sendMessage(jid, {
                text: `✅ Añadido: ${quantity} x ${pendingItem}`
            });

            await this.sendMenu(sock, jid, parentId);
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

        // PRIORIDAD 4: BUSCAR SI EL INPUT ES UNA OPCIÓN DEL MENÚ ACTUAL
        const options = await this.googleSheetsService.getNodesByParent(currentStateId);
        
        // Regla de negocio: Ocultar opciones de "Finalizar" si no hay nada en el carrito
        const order = this.stateService.getUserOrder(jid);
        const availableOptions = options.filter(node => {
            if (node.message && node.message.includes('##FINALIZAR##')) {
                return order.length > 0;
            }
            return true;
        });

        
        const selectedOption = availableOptions.find(opt => opt.trigger.toLowerCase() === input);

        if (selectedOption) {
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
        
        // Filtrar nodos de finalización (solo visibles si hay pedido)
        const visibleNodes = nodes.filter(node => {
            if (node.message && node.message.includes('##FINALIZAR##')) {
                return order.length > 0;
            }
            return true;
        });

        // Listar opciones de submenus con precios
        visibleNodes.forEach(node => {
            const priceText = node.price ? ` ($${node.price})` : '';
            menuText += `*${node.trigger}*. ${node.title}${priceText}\n`;
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
            msg += `\n\n_Escribe *v* para volver atrás._\n_Escribe *0* para volver al inicio._`;
            await this.sendPresenceTyping(sock, jid);
            await sock.sendMessage(jid, { text: msg });
            this.stateService.setUserState(jid, node.id);
            return;
        }

        // 1. DATOS: mostrar prompt siempre, esperar respuesta del usuario
        if (nodeTags.includes('DATOS')) {
            let msg = await this.replaceOrderSummary(node.message, jid);
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
            msg += `\n\n_Escribe *v* para volver atrás._\n_Escribe *0* para volver al inicio._`;
            await this.sendPresenceTyping(sock, jid);
            await sock.sendMessage(jid, { text: msg });
            this.stateService.setWaitingForFile(jid, node.id);
            this.stateService.setUserState(jid, node.id);
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

                // Último eslabón: agrega al carrito y vuelve al menú categoría
                const itemTitle = `${pending.quantity} x ${pending.title} (${node.title})`;
                this.stateService.addItemToOrder(jid, {
                    text: itemTitle,
                    price: parseFloat(String(node.price || '0').replace(',', '.')) || 0,
                    quantity: pending.quantity
                });
                this.stateService.clearPendingOrderItem(jid);

                // Ir al menú categoría (donde está ##PAGAR##)
                const cantParent = await this.googleSheetsService.getNodeById(node.parentId);
                const categoryId = cantParent ? cantParent.parentId : 'root';

                await this.sendPresenceTyping(sock, jid);
                await sock.sendMessage(jid, { text: `✅ Añadido: ${itemTitle}` });
                await this.sendMenu(sock, jid, categoryId);

                if (nodeTags.includes('FINALIZAR')) {
                    this.stateService.clearUserOrder(jid);
                }
                return;
            }

            let finalMessage = await this.replaceOrderSummary(node.message, jid);
            finalMessage += `\n\n_Escribe *0* para volver al inicio._`;
            await this.sendPresenceTyping(sock, jid);
            await sock.sendMessage(jid, { text: finalMessage });

            if (nodeTags.includes('FINALIZAR')) {
                this.stateService.clearUserOrder(jid);
            }

            this.stateService.setUserState(jid, node.id);
            return;
        }

        // 2. Tiene hijos: mostrar submenú
        if (subOptions.length > 0) {
            await this.sendMenu(sock, jid, node.id);
            return;
        }

        // 3. Nodo hoja: muestra su mensaje + ofrece volver al inicio
        let finalMessage = await this.replaceOrderSummary(node.message, jid);
        finalMessage += `\n\n_Escribe *0* para volver al inicio._`;
        await this.sendPresenceTyping(sock, jid);
        await sock.sendMessage(jid, { text: finalMessage });

        if (nodeTags.includes('FINALIZAR')) {
            this.stateService.clearUserOrder(jid);
        }

        this.stateService.setUserState(jid, node.id);
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
}

module.exports = MenuController;