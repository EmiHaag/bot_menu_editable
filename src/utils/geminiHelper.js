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
    const genAI = new GoogleGenerativeAI(apiKey || '');
    

    //🛠️ CONSTRUIMOS UN SYSTEM PROMPT PROFESIONAL DE CARA AL CLIENTE
    const instruccionesDeIdentidad = `
      Eres el Asistente Técnico Oficial del Dashboard. Tu único objetivo es ayudar a los clientes/usuarios de la plataforma a configurar sus bots utilizando la guía provista.

      [REGLAS ESTRICTAS DE COMPORTAMIENTO]:
      1. Habla SIEMPRE en segunda persona del plural o singular de forma amable  (ej: "Para crear un submenú, debes seguir estos pasos..." o "Puedes armar tu carrito...").
      2. Está TERMINANTEMENTE PROHIBIDO mencionar frases como "según la guía que me diste", "basado en tu documentación" o "el texto proporcionado". El usuario final no debe saber que estás leyendo un archivo de texto. Habla como si tú fueses el creador y experto del sistema.
      3. Sé directo, conciso y estructurado. 
      4. Está prohibido usar asteriscos (**) o formatos Markdown en tus respuestas. Devuelve texto plano limpio.

      --- GUÍA DE CONFIGURACIÓN DEL SISTEMA ---
      ${systemInstructionText}
      ----------------------------------------
      `;

    const model = genAI.getGenerativeModel({
      model: 'gemini-2.5-flash', // O el 2.5-flash que te funcionó impecable
      systemInstruction: {
        parts: [{ text: instruccionesDeIdentidad }]
      }
    });

    // 1. Obtener la respuesta cruda de Google
    const result = await model.generateContent({
      contents: [{ role: 'user', parts: [{ text: String(userMessage) }] }]
    });

    // 2. Extraer el texto plano de la respuesta
    const textoCrudo = result.response.text();

    // 3. 🛠️ LIMPIEZA: Reemplazar los ** de Markdown por etiquetas HTML <strong>
    const textoConNegritasHTML = textoCrudo.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');

    // 4. Retornar el texto ya procesado al controlador del dashboard
    return textoConNegritasHTML;

  } catch (error) {
    const isRateLimit =
      error.status === 429 ||
      (error.message && error.message.includes('429')) ||
      (error.message && error.message.toLowerCase().includes('rate limit'));

    // Detectar si el modelo está caído o saturado globalmente (503)
    const isServiceUnavailable =
      error.status === 503 ||
      (error.message && error.message.includes('503')) ||
      (error.message && error.message.toLowerCase().includes('service unavailable')) ||
      (error.message && error.message.toLowerCase().includes('high demand'));

    if (isRateLimit) {
      console.warn('[GeminiHelper] Cuota excedida (429).');
      return RATE_LIMIT_MSG;
    }
    if (isServiceUnavailable) {
      console.warn('[GeminiHelper] Servicio no disponible temporalmente (503).');
      // Mensaje amigable en español adaptado para tus clientes
      return '⏳ El asistente está experimentando una alta demanda en este momento. Este pico de consultas suele ser temporal; por favor, intentá de nuevo en unos instantes.';
    }
    console.error('[GeminiHelper] Error consultando Gemini:', error.message);
    return 'Ocurrió un error al procesar tu consulta. Intentá de nuevo más tarde.';
  }
}

module.exports = { askGemini };