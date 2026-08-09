FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000
COPY package*.json ./
RUN npm install --omit=dev
COPY --from=build /app/server.js ./server.js
COPY --from=build /app/build/server ./build/server
COPY --from=build /app/build/client ./build/client
EXPOSE 3000
CMD ["npm", "run", "start"]
