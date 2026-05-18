class MenuController {
    constructor(googleSheetsService, stateService) {
        this.googleSheetsService = googleSheetsService;
        this.stateService = stateService;
    }

    async delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    async sendPresenceTyping(sock, jid) {
        await sock.sendPresenceUpdate('paused', jid);
        await this.delay(process.env.TIEMPO_ESPERA_RESPUESTA); //  segundos adicionales de espera antes de enviar
        await sock.sendPresenceUpdate('composing', jid);
        await this.delay(process.env.TIEMPO_BOT_ESTA_ESCRIBIENDO); //segundos de simulación de escritura
    }

    async handleIncomingMessage(sock, jid, text) {
        const currentStateId = this.stateService.getUserState(jid);
        const input = text.trim().toLowerCase();

        // Check if we are waiting for free-form data (e.g. Address, Name)
        const waitingNodeId = this.stateService.getWaitingForData(jid);
        if (waitingNodeId) {
            // Any input is accepted. We move to the first child of this node.
            const children = await this.googleSheetsService.getNodesByParent(waitingNodeId);
            this.stateService.clearWaitingForData(jid);

            if (children.length > 0) {
                // Transition to the first child
                await this.sendMenu(sock, jid, children[0].id);
                return;
            } else {
                // No children? We acknowledge but stay here. 
                // The user can still use 'v' or '0' thanks to the footer in the message they just replied to.
                await sock.sendMessage(jid, { text: '✅ Datos recibidos.' });
                return;
            }
        }

        // Check if we are waiting for a quantity
        const pendingItem = this.stateService.getPendingQuantityItem(jid);
        if (pendingItem && !isNaN(input) && parseInt(input) > 0) {
            const quantity = parseInt(input);
            this.stateService.addItemToOrder(jid, `${quantity} x ${pendingItem}`);
            this.stateService.clearPendingQuantityItem(jid);

            await this.sendPresenceTyping(sock, jid);

            // Instead of re-showing the current "How many?" menu, 
            // we show the confirmation and either the parent menu or a clean summary.
            const currentNode = await this.googleSheetsService.getNodeById(currentStateId);
            const parentId = currentNode ? currentNode.parentId : 'root';

            await sock.sendMessage(jid, {
                text: `✅ Añadido: ${quantity} x ${pendingItem}`
            });

            // Redirect to parent menu to continue browsing
            await this.sendMenu(sock, jid, parentId);
            return;
        }
        // Handle global reset or back commands
        if (input === '0' || input === 'inicio') {
            await this.sendMenu(sock, jid, 'root');
            return;
        }

        // Handle clear order command
        if (input === 'vaciar' || input === 'limpiar' || input === 'borrar pedido') {
            this.stateService.clearUserOrder(jid);
            await this.sendPresenceTyping(sock, jid);
            await sock.sendMessage(jid, {
                text: '🗑️ Tu pedido ha sido vaciado.'
            });
            await this.sendMenu(sock, jid, currentStateId);
            return;
        }

        // Handle "back" command
        if (input === 'v' || input === 'atras' || input === 'atrás') {
            if (currentStateId === 'root') {
                await this.sendMenu(sock, jid, 'root');
            } else {
                const currentNode = await this.googleSheetsService.getNodeById(currentStateId);
                await this.sendMenu(sock, jid, currentNode ? currentNode.parentId : 'root');
            }
            return;
        }

        // Get current children to see if input matches a trigger
        const options = await this.googleSheetsService.getNodesByParent(currentStateId);
        
        // Filter out "Finalizar" options if cart is empty
        const order = this.stateService.getUserOrder(jid);
        const availableOptions = options.filter(node => {
            if (node.message && node.message.includes('##FINALIZAR##')) {
                return order.length > 0;
            }
            return true;
        });

        const selectedOption = availableOptions.find(opt => opt.trigger.toLowerCase() === input);

        if (selectedOption) {
            // Check for order tags in message
            if (selectedOption.message) {
                if (selectedOption.message.includes('##CANTIDAD##')) {
                    this.stateService.setPendingQuantityItem(jid, selectedOption.title);
                } else if (selectedOption.message.includes('##PEDIDO##')) {
                    this.stateService.addItemToOrder(jid, `1 x ${selectedOption.title}`);
                } else if (selectedOption.message.includes('##DATOS##')) {
                    this.stateService.setWaitingForData(jid, selectedOption.id);
                }
            }

            const subOptions = await this.googleSheetsService.getNodesByParent(selectedOption.id);

            if (subOptions.length > 0) {
                await this.sendMenu(sock, jid, selectedOption.id);
            } else {
                // Final message with navigation options
                let finalMessage = await this.replaceOrderSummary(selectedOption.message, jid);

                finalMessage += `\n\n_Escribe *v* para volver atrás._\n`;
                finalMessage += `_Escribe *0* para volver al inicio._`;

                await this.sendPresenceTyping(sock, jid); // Escritura + Espera antes de enviar
                await sock.sendMessage(jid, {
                    text: finalMessage
                });

                // Handle order finalization
                if (selectedOption.message && selectedOption.message.includes('##FINALIZAR##')) {
                    this.stateService.clearUserOrder(jid);
                }

                // Guardar el estado actual incluso si es un mensaje final
                this.stateService.setUserState(jid, selectedOption.id);
            }
        } else {
            // Invalid input or first interaction
            if (currentStateId === 'root' && !selectedOption) {
                const rootNode = await this.googleSheetsService.getNodeById('root');
                const isStrict = rootNode && rootNode.strictTrigger === 'true';

                if (isStrict) {
                    const rootTrigger = (rootNode && rootNode.trigger) ? rootNode.trigger.toLowerCase() : 'hola';
                    if (input === rootTrigger) {
                        await this.sendMenu(sock, jid, 'root');
                    }
                    // Si es estricto y no coincide el disparador, se ignora el mensaje
                } else {
                    await this.sendMenu(sock, jid, 'root');
                }
            } else {
                await this.sendPresenceTyping(sock, jid); // Escritura + Espera antes de enviar
                await sock.sendMessage(jid, {
                    text: 'Opción no válida.'
                });
                await this.sendMenu(sock, jid, currentStateId); // Re-show menu options
            }
        }
    }

    async sendMenu(sock, jid, parentId) {
        const nodes = await this.googleSheetsService.getNodesByParent(parentId);
        const order = this.stateService.getUserOrder(jid);

        // Try to find a node with ID 'root' for the main greeting, else use default
        let currentNode = await this.googleSheetsService.getNodeById(parentId);

        if (!currentNode) {
            currentNode = {
                message: parentId === 'root' ? 'Hola, bienvenido. Elige una opción:' : 'Elige una opción:'
            };
        }

        let menuText = await this.replaceOrderSummary(currentNode.message, jid) + '\n\n';
        
        // Filter Finalizar items
        const visibleNodes = nodes.filter(node => {
            if (node.message && node.message.includes('##FINALIZAR##')) {
                return order.length > 0;
            }
            return true;
        });

        visibleNodes.forEach(node => {
            const priceText = node.price ? ` ($${node.price})` : '';
            menuText += `*${node.trigger}*. ${node.title}${priceText}\n`;
        });

        // Consistent Navigation Footer
        menuText += `\n---\n`;

        // Add "Vaciar pedido" only in the root menu if there are items
        if (parentId === 'root') {
            if (order.length > 0) {
                menuText += `*vaciar*. Vaciar pedido\n`;
            }
        }

        if (parentId !== 'root') {
            menuText += `*v*. Volver atrás\n`;
        }
        menuText += `*0*. Menú Principal`;

        await this.sendPresenceTyping(sock, jid); // Escritura + Espera antes de enviar
        await sock.sendMessage(jid, {
            text: menuText
        });
        this.stateService.setUserState(jid, parentId);
    }

    async replaceOrderSummary(text, jid) {
        if (!text) return '';

        // Remove internal tags from the message
        let cleanText = text
            .replace('##PEDIDO##', '')
            .replace('##CANTIDAD##', '')
            .replace('##FINALIZAR##', '')
            .replace('##DATOS##', '')
            .trim();

        const order = this.stateService.getUserOrder(jid);
        if (order.length === 0) return cleanText;

        // Calculate Total Price
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

        let summary = `\n\n🛍️ *Tu pedido:* \n${detailedOrder.join('\n')}`;
        
        if (hasPrices) {
            summary += `\n\n💰 *Total: $${total}*`;
        }

        return cleanText + summary;
    }
}

module.exports = MenuController;