FROM node:20-slim

# Instalamos git y agregamos dependencias para evitar errores con librerías nativas
RUN apt-get update && apt-get install -y git && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./

# Instalamos solo producción
RUN npm install --omit=dev

COPY . .

# Preparamos el directorio. 
# IMPORTANTE: No usamos la instrucción VOLUME al final.
RUN mkdir -p /data/auth_sessions && chmod -R 777 /data

EXPOSE 8000

# Eliminamos la línea VOLUME ["/data"] ya que Koyeb se encarga del montaje
CMD ["node", "src/app.js"]