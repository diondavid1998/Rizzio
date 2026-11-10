# Railway builds the server from this file (see railway.toml). It only needs Docker Hub's Node image
# and npm, not the extra GitHub downloads Railway's default builder makes, which kept timing out.
FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY data ./data
CMD ["npm", "start"]
