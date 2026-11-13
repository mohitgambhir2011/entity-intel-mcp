# Runs the MCP server over stdio. No secrets are baked in: pass
# COMPANIES_HOUSE_API_KEY, FCA_AUTH_EMAIL and FCA_AUTH_KEY at run time (all optional;
# the keyless sources work without them).
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json LICENSE README.md ./
USER node
ENTRYPOINT ["node", "dist/index.js"]
