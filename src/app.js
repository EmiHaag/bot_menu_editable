const { 
    default: makeWASocket, 
    useMultiFileAuthState, 
    DisconnectReason, 
    fetchLatestBaileysVersion 
} = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const qrcode = require('qrcode-terminal');
const pino = require('pino');
const GoogleSheetsService = require('./services/googleSheetsService');
const StateService = require('./services/stateService');
const MenuController = require('./controllers/menuController');
const dashboard = require('./utils/dashboard');
const botsConfig = require('./config/bots');

async function startBot(botConfig) {
    const { id, spreadsheetId, credentials, authFolder } = botConfig;
    
    console.log(`Starting bot: ${id}`);
    
    const googleSheetsService = new GoogleSheetsService({
        clientId: id,
        spreadsheetId,
        credentials
    });
    
    const stateService = new StateService(id);
    const menuController = new MenuController(googleSheetsService, stateService);

    const { state, saveCreds } = await useMultiFileAuthState(authFolder);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        logger: pino({ level: 'silent' }),
        auth: state,
    });

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) {
            console.log(`QR for bot ${id}:`);
            qrcode.generate(qr, { small: true });
        }
        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect.error instanceof Boom) ? 
                lastDisconnect.error.output.statusCode !== DisconnectReason.loggedOut : true;
            console.log(`Connection closed for bot ${id} due to `, lastDisconnect.error, ', reconnecting ', shouldReconnect);
            if (shouldReconnect) {
                startBot(botConfig);
            }
        } else if (connection === 'open') {
            console.log(`Opened connection for bot ${id}`);
        }
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('messages.upsert', async m => {
        if (m.type === 'notify') {
            for (const msg of m.messages) {
                if (!msg.key.fromMe && msg.message) {
                    const jid = msg.key.remoteJid;
                    const text = msg.message.conversation || 
                                 msg.message.extendedTextMessage?.text || 
                                 msg.message.buttonsResponseMessage?.selectedButtonId ||
                                 msg.message.listResponseMessage?.singleSelectReply?.selectedRowId;

                    if (text) {
                        console.log(`[${id}] Message from ${jid}: ${text}`);
                        await menuController.handleIncomingMessage(sock, jid, text);
                    }
                }
            }
        }
    });
}

async function main() {
    // Iniciar dashboard (Note: Dashboard might need refactoring to support multi-bot)
    dashboard.start();

    for (const botConfig of botsConfig) {
        await startBot(botConfig);
    }
}

main();
