# EcoShift: Node server plus the Python farm-map converter.
# NOT TESTED: written without Docker available. Build it once before relying on it:  docker build -t ecoshift .
FROM node:20-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-pip \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Python packages for the farm-map converter (Debian's pip needs --break-system-packages outside a venv)
COPY farmmap/requirements.txt farmmap/requirements.txt
RUN pip3 install --no-cache-dir --break-system-packages -r farmmap/requirements.txt

# Node packages: the server has none today, so this only runs if a dependency is added to package.json
COPY package.json ./
RUN npm install --omit=dev

COPY . .

ENV NODE_ENV=production
# Hosts usually set PORT themselves; the server falls back to 8787.
EXPOSE 8787
CMD ["node", "server.js"]
