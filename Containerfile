# === Build stage ===
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ src/
RUN npm run build

# === Runtime stage ===
FROM node:22-alpine
WORKDIR /app
COPY --from=build /app/dist/ dist/
COPY --from=build /app/node_modules/ node_modules/
COPY --from=build /app/package.json ./
COPY static/ static/
EXPOSE 8022
ENV PORT=8022
CMD ["node", "dist/src/index.js"]
