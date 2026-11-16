# EcoShift full server for a Hugging Face Space (Docker). It downloads the code from GitHub when the Space builds.
FROM node:20-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-pip git ca-certificates libglib2.0-0 \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
RUN git clone --depth 1 https://github.com/ghrini/Ecoshift_Final.git . && rm -rf simulator-source/raw .git
RUN pip3 install --no-cache-dir --break-system-packages -r farmmap/requirements.txt
ENV PORT=7860 FARMMAP_PYTHON=python3 NODE_ENV=production
EXPOSE 7860
CMD ["node", "server.js"]
