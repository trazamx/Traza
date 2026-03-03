# ╔══════════════════════════════════════════════════════════╗
#   FleetOS — Railway Dockerfile                            
#   Single port, Chromium included, Railway-optimized       
# ╚══════════════════════════════════════════════════════════╝

FROM node:22-slim

# Install Chromium + deps
RUN apt-get update && apt-get install -y \
    chromium \
    fonts-liberation \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcups2 \
    libdbus-1-3 \
    libgbm1 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    wget \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY . .

# Railway sets PORT automatically — expose it
EXPOSE $PORT

CMD ["node", "bridge.js"]
