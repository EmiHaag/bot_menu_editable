const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');

/**
 * Clase base para servicios de Google que utiliza OAuth2
 * Soporta archivos locales (desarrollo) y variables de entorno (producción/Koyeb)
 */
class GoogleAuthBase {
    constructor() {
        this.tokenPath = path.resolve(process.cwd(), 'token.json');
        this.credentialsPath = path.resolve(process.cwd(), 'oauth_credentials.json');
    }

    /**
     * Obtiene el contenido de las credenciales (desde ENV o Archivo)
     */
    getCredentials() {
        if (process.env.OAUTH_CREDENTIALS_CONTENT) {
            try {
                return typeof process.env.OAUTH_CREDENTIALS_CONTENT === 'string'
                    ? JSON.parse(process.env.OAUTH_CREDENTIALS_CONTENT)
                    : process.env.OAUTH_CREDENTIALS_CONTENT;
            } catch (e) {
                console.error('[GoogleAuth] Error al parsear OAUTH_CREDENTIALS_CONTENT de ENV:', e.message);
            }
        }

        if (fs.existsSync(this.credentialsPath)) {
            return JSON.parse(fs.readFileSync(this.credentialsPath));
        }

        throw new Error('Credenciales OAuth no encontradas (ni en ENV ni en archivo)');
    }

    /**
     * Obtiene el contenido del token (desde ENV o Archivo)
     */
    getToken() {
        if (process.env.OAUTH_TOKEN_CONTENT) {
            try {
                return typeof process.env.OAUTH_TOKEN_CONTENT === 'string'
                    ? JSON.parse(process.env.OAUTH_TOKEN_CONTENT)
                    : process.env.OAUTH_TOKEN_CONTENT;
            } catch (e) {
                console.error('[GoogleAuth] Error al parsear OAUTH_TOKEN_CONTENT de ENV:', e.message);
            }
        }

        if (fs.existsSync(this.tokenPath)) {
            return JSON.parse(fs.readFileSync(this.tokenPath));
        }

        throw new Error('Token OAuth no encontrado (ni en ENV ni en archivo)');
    }

    /**
     * Crea un cliente OAuth2 autenticado
     */
    getAuthClient() {
        try {
            const credentials = this.getCredentials();
            const token = this.getToken();

            const config = credentials.installed || credentials.web;
            if (!config) throw new Error('Formato de credenciales OAuth inválido');

            const { client_secret, client_id, redirect_uris } = config;
            const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);
            oAuth2Client.setCredentials(token);

            return oAuth2Client;
        } catch (error) {
            console.error('[GoogleAuth] Error crítico al obtener cliente autenticado:', error.message);
            throw error;
        }
    }
}

module.exports = GoogleAuthBase;
