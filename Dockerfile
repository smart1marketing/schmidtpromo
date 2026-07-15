# Smart 1 Suite Promotions proxy
FROM node:20-slim

WORKDIR /app

# Install dependencies first (better build caching)
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

# Copy the rest of the service
COPY . .

# Render provides PORT at runtime; the app reads process.env.PORT
EXPOSE 10000

CMD ["npm", "start"]
