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
     * Procesa cada mensaje entrante del usuario
     */
    async handleIncomingMessage(sock, jid, text) {
        const currentStateId = this.stateService.getUserState(jid); // Dónde está el usuario ahora
        const input = text.trim().toLowerCase(); // Texto del usuario limpio

        // 1. ¿EL BOT ESTÁ ESPERANDO DATOS LIBRES? (Ej: Nombre, Dirección) sin un trigger especifico.
        const waitingNodeId = this.stateService.getWaitingForData(jid);
        if (waitingNodeId) {
            console.log("esta esperando datos.. #40");
            const children = await this.googleSheetsService.getNodesByParent(waitingNodeId);
            this.stateService.clearWaitingForData(jid);

            if (children.length > 0) {
                // Si hay un siguiente paso tras recibir datos, vamos a él
                await this.sendMenu(sock, jid, children[0].id);
                return;
            } else {
                // Confirmación simple si no hay más pasos
                await sock.sendMessage(jid, { text: '✅ Datos recibidos.' });
                return;
            }
        }

        // 2. ¿EL BOT ESTÁ ESPERANDO UNA CANTIDAD NUMÉRICA?
        const pendingItem = this.stateService.getPendingQuantityItem(jid);
        if (pendingItem && !isNaN(input) && parseInt(input) > 0) {
            const quantity = parseInt(input);
            this.stateService.addItemToOrder(jid, `${quantity} x ${pendingItem}`);
            this.stateService.clearPendingQuantityItem(jid);

            await this.sendPresenceTyping(sock, jid);

            const currentNode = await this.googleSheetsService.getNodeById(currentStateId);
            const parentId = currentNode ? currentNode.parentId : 'root';

            await sock.sendMessage(jid, {
                text: `✅ Añadido: ${quantity} x ${pendingItem}`
            });

            // Regresa al menú padre para que el usuario pueda seguir comprando
            await this.sendMenu(sock, jid, parentId);
            return;
        }

        

        // 3. COMANDOS GLOBALES (Inicio y Reset)
        if (input === '0' || input === 'inicio') {
            await this.sendMenu(sock, jid, 'root');
            return;
        }

        // 4. GESTIÓN DEL CARRITO (Vaciar)
        if (input === 'vaciar' || input === 'limpiar' || input === 'borrar pedido') {
            this.stateService.clearUserOrder(jid);
            await this.sendPresenceTyping(sock, jid);
            await sock.sendMessage(jid, {
                text: '🗑️ Tu pedido ha sido vaciado.'
            });
            await this.sendMenu(sock, jid, currentStateId);
            return;
        }

        // 5. NAVEGACIÓN HACIA ATRÁS
        if (input === 'v' || input === 'atras' || input === 'atrás') {
            if (currentStateId === 'root') {
                await this.sendMenu(sock, jid, 'root');
            } else {
                const currentNode = await this.googleSheetsService.getNodeById(currentStateId);
                await this.sendMenu(sock, jid, currentNode ? currentNode.parentId : 'root');
            }
            return;
        }

        // 6. BUSCAR SI EL INPUT COINCIDE CON UNA OPCIÓN DEL MENÚ ACTUAL
        const options = await this.googleSheetsService.getNodesByParent(currentStateId);
        
        // Filtrar opciones "Finalizar" si el carrito está vacío
        const order = this.stateService.getUserOrder(jid);
        const availableOptions = options.filter(node => {
            if (node.message && node.message.includes('##FINALIZAR##')) {
                return order.length > 0;
            }
            return true;
        });

        
        const selectedOption = availableOptions.find(opt => opt.trigger.toLowerCase() === input);

        if (selectedOption) {
            // PROCESAR TAGS ESPECIALES EN EL MENSAJE
            if (selectedOption.message) {
                if (selectedOption.message.includes('##CANTIDAD##')) {
                    this.stateService.setPendingQuantityItem(jid, selectedOption.title);
                } else if (selectedOption.message.includes('##PEDIDO##')) {
                    this.stateService.addItemToOrder(jid, `1 x ${selectedOption.title}`);
                } else if (selectedOption.message.includes('##DATOS##')) {
                    console.log("esta esperando datos.. #126");
                    this.stateService.setWaitingForData(jid, selectedOption.id);
                }
            }

            const subOptions = await this.googleSheetsService.getNodesByParent(selectedOption.id);

            //ACA SE OMITE EL SUBMENU SI ESTA ESPERANDO DATOS O CANTIDAD PARA QUE NO CONFUNDA AL USUARIO
            if (subOptions.length > 0 && !selectedOption.message.includes('##DATOS##') ) {               
                // Si la opción tiene sub-menús, los mostramos
                await this.sendMenu(sock, jid, selectedOption.id);
            } else {
                console.log("no hay submenus, se procesa el mensaje final.. #138");
                // Si es un mensaje final, procesamos el texto y añadimos navegación
                let finalMessage = await this.replaceOrderSummary(selectedOption.message, jid);

                finalMessage += `\n\n_Escribe *v* para volver atrás._\n`;
                finalMessage += `_Escribe *0* para volver al inicio._`;

                await this.sendPresenceTyping(sock, jid);
                await sock.sendMessage(jid, {
                    text: finalMessage
                });

                // Si era el paso final (Finalizar), vaciamos el carrito del usuario
                if (selectedOption.message && selectedOption.message.includes('##FINALIZAR##')) {
                    this.stateService.clearUserOrder(jid);
                }

                this.stateService.setUserState(jid, selectedOption.id);
            }
        } else {
            // 7. MANEJO DE ENTRADAS NO VÁLIDAS O PRIMER CONTACTO
            if (currentStateId === 'root' && !selectedOption) {
                const rootNode = await this.googleSheetsService.getNodeById('root');
                const isStrict = rootNode && rootNode.strictTrigger === 'true';

                if (isStrict) {
                    const rootTrigger = (rootNode && rootNode.trigger) ? rootNode.trigger.toLowerCase() : 'hola';
                    if (input === rootTrigger) {
                        await this.sendMenu(sock, jid, 'root');
                    }
                } else {
                    await this.sendMenu(sock, jid, 'root');
                }
            } else {
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

        if (!currentNode) {
            currentNode = {
                message: parentId === 'root' ? 'Hola, bienvenido. Elige una opción:' : 'Elige una opción:'
            };
        }

        // Construcción del texto del menú + Resumen de pedido si existe
        let menuText = await this.replaceOrderSummary(currentNode.message, jid) + '\n\n';
        
        // Filtrar nodos de finalización (solo visibles si hay pedido)
        const visibleNodes = nodes.filter(node => {
            if (node.message && node.message.includes('##FINALIZAR##')) {
                return order.length > 0;
            }
            return true;
        });

        // Listar opciones con precios
        visibleNodes.forEach(node => {
            const priceText = node.price ? ` ($${node.price})` : '';
            menuText += `*${node.trigger}*. ${node.title}${priceText}\n`;
        });

        // FOOTER DE NAVEGACIÓN CONSISTENTE
        menuText += `\n---\n`;

        if (parentId === 'root') {
            if (order.length > 0) {
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
        this.stateService.setUserState(jid, parentId);
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
            .trim();

        const order = this.stateService.getUserOrder(jid);
        if (order.length === 0) return cleanText;

        // CÁLCULO DE TOTALES BASADO EN PRECIOS DEL EXCEL
        const menu = await this.googleSheetsService.getMenuData();
        let total = 0;
        let hasPrices = false;

        const detailedOrder = order.map(itemStr => {
            const parts = itemStr.split(' x ');
            if (parts.length === 2) {
                const qty = parseInt(parts[0]);
                const title = parts[1];
                const node = menu.find(n => n.title === title);
                if (node && node.price) {
                    const price = parseFloat(String(node.price).replace(',', '.'));
                    if (!isNaN(price)) {
                        total += qty * price;
                        hasPrices = true;
                        return `${itemStr} ($${price * qty})`;
                    }
                }
            }
            return itemStr;
        });

        // Crear bloque visual de resumen
        let summary = `\n\n🛍️ *Tu pedido:* \n${detailedOrder.join('\n')}`;
        
        if (hasPrices) {
            summary += `\n\n💰 *Total: $${total}*`;
        }

        return cleanText + summary;
    }
}

module.exports = MenuController;