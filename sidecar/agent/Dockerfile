# Ghost Wire Sidecar agent: setup | broker | connector. Build context = repository root.
FROM node:24-bookworm-slim
ENV NODE_ENV=production NODE_NO_WARNINGS=1
WORKDIR /app/agent
COPY premium-agent/server.mjs premium-agent/engine-proxy.mjs premium-agent/chat.mjs premium-agent/workspace-provisioner.mjs \
     premium-agent/workspace-model-broker.mjs premium-agent/worker-access.mjs premium-agent/model-route.mjs \
     premium-agent/model-route-core.mjs premium-agent/provider-adapters.mjs premium-agent/mining-proxy.mjs \
     premium-agent/model-providers.json premium-agent/model-filter.json ./premium-agent/
COPY sidecar/connection.mjs sidecar/preflight.mjs ./sidecar/
COPY sidecar/agent/secrets.mjs sidecar/agent/folder.mjs sidecar/agent/setup.mjs sidecar/agent/connector.mjs sidecar/agent/cli.mjs ./sidecar/agent/
RUN mkdir -p /state /route && chown node:node /state /route
USER node
ENV MODEL_PROVIDERS=/app/agent/premium-agent/model-providers.json MODEL_FILTER=/app/agent/premium-agent/model-filter.json MODEL_ROUTE_DIR=/route
ENTRYPOINT ["node", "/app/agent/sidecar/agent/cli.mjs"]
