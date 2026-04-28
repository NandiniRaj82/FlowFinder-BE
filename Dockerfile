# ─────────────────────────────────────────────────────────────────
# Stage 1 – builder: install deps (including native modules like sharp)
# ─────────────────────────────────────────────────────────────────
FROM node:20-bookworm-slim AS builder

WORKDIR /app

# Install build tools needed by native modules (sharp, bcrypt, etc.)
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

# Copy manifests first for better layer caching
COPY package.json package-lock.json ./

# Install ALL deps (including devDeps needed for build)
# --ignore-scripts is NOT used here because sharp needs its postinstall
RUN npm ci --omit=dev

# ─────────────────────────────────────────────────────────────────
# Stage 2 – runtime: lean image with Chromium for Puppeteer
# ─────────────────────────────────────────────────────────────────
FROM node:20-bookworm-slim AS runtime

WORKDIR /app

# ── Install Chromium + all libraries Puppeteer needs ────────────
# This is the canonical list for Debian Bookworm (Node 20 base)
RUN apt-get update && apt-get install -y --no-install-recommends \
    # Chromium browser
    chromium \
    # Font rendering
    fonts-liberation \
    fonts-noto-color-emoji \
    fonts-ipafont-gothic \
    fonts-wqy-zenhei \
    fonts-thai-tlwg \
    fonts-khmeros \
    # Shared libraries Chromium depends on
    libnspr4 \
    libnss3 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdrm2 \
    libgbm1 \
    libasound2 \
    libpangocairo-1.0-0 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libxshmfence1 \
    libx11-xcb1 \
    libxcb-dri3-0 \
    libxkbcommon0 \
    # For sharp (libvips)
    libvips-dev \
    # Git (needed by simple-git at runtime)
    git \
    # Misc
    ca-certificates \
    wget \
    && rm -rf /var/lib/apt/lists/*

# ── Tell Puppeteer to use the system Chromium, not download its own ──
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

# ── Create a non-root user so Chrome's sandbox works ────────────
# (Chromium refuses to run as root without --no-sandbox;
#  using a real user is more secure)
RUN groupadd -r pptruser && useradd -r -g pptruser -G audio,video pptruser \
    && mkdir -p /home/pptruser/Downloads \
    && chown -R pptruser:pptruser /home/pptruser

# ── Copy node_modules from builder ──────────────────────────────
COPY --from=builder /app/node_modules ./node_modules

# ── Copy application source ─────────────────────────────────────
COPY . .

# ── Create uploads dir and set ownership ────────────────────────
RUN mkdir -p uploads && chown -R pptruser:pptruser /app

USER pptruser

EXPOSE 5000

# Production start command (node, not nodemon)
CMD ["node", "--max-old-space-size=4096", "server.js"]
