# Stage 1: Build
FROM node:20-slim AS builder
WORKDIR /app

COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

# Stage 2: Production
FROM node:20-slim AS runner
WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production
COPY --from=builder /app/dist ./dist

ENV NODE_ENV="production"
ENV PORT=4000

EXPOSE 4000
CMD ["npm", "start"]
