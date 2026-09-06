/**
 * ImageOptimizerService: optimiza imágenes antes de subirlas a Google Drive.
 * - Respeta la orientación EXIF
 * - Redimensiona a ancho máximo 1280px (sin ampliar)
 * - Convierte a JPEG progresivo
 * - Bucle adaptativo de calidad para quedar < 300 KB
 */
const sharp = require('sharp');

const MAX_WIDTH = 1280;
const MAX_SIZE_BYTES = 300 * 1024;
const QUALIDADES = [80, 70, 60, 50, 40];

/**
 * Optimiza un buffer de imagen a JPEG comprimido.
 * @param {Buffer} imageBuffer
 * @returns {Promise<Buffer>}
 */
async function optimizarImagen(imageBuffer) {
    if (!Buffer.isBuffer(imageBuffer) || imageBuffer.length === 0) {
        throw new Error('Buffer de imagen inválido');
    }

    let metada;
    try {
        metada = await sharp(imageBuffer).metadata();
    } catch (error) {
        throw new Error(`Imagen no soportada: ${error.message}`);
    }
    if (!metada.format) {
        throw new Error('Formato de imagen no detectado');
    }

    for (const calidad of QUALIDADES) {
        const salida = await sharp(imageBuffer)
            .rotate()
            .resize({ width: MAX_WIDTH, fit: 'inside', withoutEnlargement: true })
            .toFormat('jpeg', { quality: calidad, mozjpeg: true, progressive: true })
            .withMetadata(false)
            .toBuffer();

        if (salida.length <= MAX_SIZE_BYTES) {
            return salida;
        }
    }

    // Último intento: devolver la versión más comprimida disponible
    return sharp(imageBuffer)
        .rotate()
        .resize({ width: MAX_WIDTH, fit: 'inside', withoutEnlargement: true })
        .toFormat('jpeg', { quality: QUALIDADES[QUALIDADES.length - 1], mozjpeg: true, progressive: true })
        .withMetadata(false)
        .toBuffer();
}

module.exports = { optimizarImagen, MAX_WIDTH, MAX_SIZE_BYTES };