FROM node:22-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --include=dev --ignore-scripts

COPY . .
RUN npm run build

EXPOSE 3000
CMD ["npm", "start"]
