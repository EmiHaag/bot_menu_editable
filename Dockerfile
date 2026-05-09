FROM node:20-slim

# Install git since some dependencies might require it
RUN apt-get update && apt-get install -y git && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./

RUN npm install --omit=dev

COPY . .

# Create volume directory for persistent data storage
RUN mkdir -p /data/auth_sessions && chmod 755 /data

EXPOSE 8000

# Declare volume mount point
VOLUME ["/data"]

CMD ["node", "src/app.js"]
