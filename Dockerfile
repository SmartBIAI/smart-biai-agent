FROM node:22-bookworm-slim
ENV NODE_ENV=production BIAI_HOST=0.0.0.0 PORT=4173 BIAI_DATA_DIR=/data
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force
COPY server.mjs integrations.mjs live-jobs.mjs mock.mjs media-storage.mjs web-access.mjs ./
COPY image-jobs.mjs generation-models.js ./
COPY agent.mjs agent-mock.mjs ./
COPY web-sessions.mjs ./
COPY account-tags.mjs ./
COPY web/index.html web/app.js web/styles.css ./web/
COPY web/account-properties.js web/account-tag-controls.js ./web/
COPY web/login.html web/login.js web/login.css ./web/
COPY web/demo-assets/sample-video.mp4 web/demo-assets/sample-cover.jpg ./web/demo-assets/
COPY LICENSE ./
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 4173
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4173/healthz',{signal:AbortSignal.timeout(4000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.mjs"]
