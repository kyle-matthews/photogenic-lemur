FROM node:24-slim

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server ./server
COPY public ./public

# Runs as root because Fly mounts volumes (where the database lives) owned by root.
EXPOSE 8080
CMD ["node", "server/index.js"]
