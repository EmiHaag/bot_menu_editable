const { GoogleGenerativeAI } = require('@google/generative-ai');
const fs = require('fs');
const path = require('path');

const DOCS_PATH = path.resolve(__dirname, '../../documentacion.txt');
let systemInstructionText = '';

try {
  systemInstructionText = fs.readFileSync(DOCS_PATH, 'utf-8');
  console.log('[GeminiHelper] documentacion.txt cargada exitosamente.');
} catch (err) {
  console.error('[GeminiHelper] Error al leer documentacion.txt:', err.message);
}

const RATE_LIMIT_MSG =
  '⏳ El asistente está saturado por el momento. Esperá unos segundos y volvé a preguntar.';

async function askGemini(userMessage) {
  try {
    const apiKey = process.env.BOT_HELPER_GOOGLE_AI_KEY;

    if (!apiKey) {
      console.warn('[GeminiHelper] BOT_HELPER_GOOGLE_AI_KEY no definida en .env');
    }

    const genAI = new GoogleGenerativeAI(apiKey || '');
    
    // 💡 LA CORRECCIÓN CRUCIAL: systemInstruction DEBE ser un objeto con parts
    const model = genAI.getGenerativeModel({
      model: 'gemini-2.5-flash',
      systemInstruction: {
        parts: [{ text: systemInstructionText }]
      }
    });

    // Aseguramos que el mensaje sea un objeto estructurado para no fallar
    const result = await model.generateContent({
      contents: [{ role: 'user', parts: [{ text: String(userMessage) }] }]
    });

    return result.response.text();

  } catch (error) {
    const isRateLimit =
      error.status === 429 ||
      (error.message && error.message.includes('429')) ||
      (error.message && error.message.toLowerCase().includes('rate limit'));

    if (isRateLimit) {
      console.warn('[GeminiHelper] Cuota excedida (429).');
      return RATE_LIMIT_MSG;
    }

    console.error('[GeminiHelper] Error consultando Gemini:', error.message);
    return 'Ocurrió un error al procesar tu consulta. Intentá de nuevo más tarde.';
  }
}

module.exports = { askGemini };