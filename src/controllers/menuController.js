class MenuController {
    constructor(googleSheetsService, stateService) {
        this.googleSheetsService = googleSheetsService;
        this.stateService = stateService;
    }

    async delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    async sendPresenceTyping(sock, jid) {
        await sock.sendPresenceUpdate('composing', jid);
        await this.delay(2000); // 2 segundos de simulación
        await sock.sendPresenceUpdate('paused', jid);
    }

    async handleIncomingMessage(sock, jid, text) {
        const currentStateId = this.stateService.getUserState(jid);
        const input = text.trim().toLowerCase();

        // Handle global reset or back commands
        if (input === '0' || input === 'inicio') {
            await this.sendMenu(sock, jid, 'root');
            return;
        }

        // Handle "back" command
        if (input === '9' || input === 'atras' || input === 'atrás') {
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
            const subOptions = await this.googleSheetsService.getNodesByParent(selectedOption.id);
            
            if (subOptions.length > 0) {
                await this.sendMenu(sock, jid, selectedOption.id);
            } else {
                // Final message with navigation options
                let finalMessage = `${selectedOption.message}\n\n`;
                finalMessage += `_Escribe *9* para volver atrás._\n`;
                finalMessage += `_Escribe *0* para volver al inicio._`;
                
                await this.sendPresenceTyping(sock, jid);
                await sock.sendMessage(jid, { text: finalMessage });
                
                // Guardar el estado actual incluso si es un mensaje final
                this.stateService.setUserState(jid, selectedOption.id);
            }
        } else {
            // Invalid input or first interaction
            if (currentStateId === 'root' && !selectedOption) {
                 await this.sendMenu(sock, jid, 'root');
            } else {
                await this.sendPresenceTyping(sock, jid);
                await sock.sendMessage(jid, { text: 'Opción no válida.' });
                await this.sendMenu(sock, jid, currentStateId);
            }
        }
    }

    async sendMenu(sock, jid, parentId) {
        const nodes = await this.googleSheetsService.getNodesByParent(parentId);
        
        // Try to find a node with ID 'root' for the main greeting, else use default
        let currentNode = await this.googleSheetsService.getNodeById(parentId);
        
        if (parentId === 'root' && !currentNode) {
            currentNode = { message: 'Hola, bienvenido. Elige una opción:' };
        }

        let menuText = `${currentNode.message}\n\n`;
        nodes.forEach(node => {
            menuText += `*${node.trigger}*. ${node.title}\n`;
        });

        // Consistent Navigation Footer
        menuText += `\n---\n`;
        if (parentId !== 'root') {
            menuText += `*9*. Volver atrás\n`;
        }
        menuText += `*0*. Menú Principal`;

        await this.sendPresenceTyping(sock, jid);
        await sock.sendMessage(jid, { text: menuText });
        this.stateService.setUserState(jid, parentId);
    }
}

module.exports = MenuController;
