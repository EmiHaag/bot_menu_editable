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
        const selectedOption = options.find(opt => opt.trigger.toLowerCase() === input);

        if (selectedOption) {
            // Check for order tag in message
            if (selectedOption.message && selectedOption.message.includes('##PEDIDO##')) {
                this.stateService.addItemToOrder(jid, selectedOption.title);
            }

            const subOptions = await this.googleSheetsService.getNodesByParent(selectedOption.id);

            if (subOptions.length > 0) {
                await this.sendMenu(sock, jid, selectedOption.id);
            } else {
                // Final message with navigation options
                let finalMessage = this.replaceOrderSummary(selectedOption.message, jid);

                finalMessage += `\n\n_Escribe *v* para volver atrás._\n`;
                finalMessage += `_Escribe *0* para volver al inicio._`;

                await this.sendPresenceTyping(sock, jid); // Escritura + Espera antes de enviar
                await sock.sendMessage(jid, {
                    text: finalMessage
                });

                // Guardar el estado actual incluso si es un mensaje final
                this.stateService.setUserState(jid, selectedOption.id);
            }
        } else {
            // Invalid input or first interaction
            if (currentStateId === 'root' && !selectedOption) {
                await this.sendMenu(sock, jid, 'root');
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

        // Try to find a node with ID 'root' for the main greeting, else use default
        let currentNode = await this.googleSheetsService.getNodeById(parentId);

        if (parentId === 'root' && !currentNode) {
            currentNode = {
                message: 'Hola, bienvenido. Elige una opción:'
            };
        }

        let menuText = this.replaceOrderSummary(currentNode.message, jid) + '\n\n';
        nodes.forEach(node => {
            menuText += `*${node.trigger}*. ${node.title}\n`;
        });

        // Consistent Navigation Footer
        menuText += `\n---\n`;
        
        // Add "Vaciar pedido" only in the root menu if there are items
        if (parentId === 'root') {
            const order = this.stateService.getUserOrder(jid);
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

    replaceOrderSummary(text, jid) {
        if (!text) return '';
        
        // Remove the internal tag from the message
        let cleanText = text.replace('##PEDIDO##', '').trim();
        
        const order = this.stateService.getUserOrder(jid);
        if (order.length === 0) return cleanText;

        const summary = `\n\n🛍️ *Tu pedido:* ${order.join(', ')}`;
        return cleanText + summary;
    }
}

module.exports = MenuController;
