FROM node:20-alpine
WORKDIR /app
COPY package.json /app/package.json
COPY server.js /app/server.js
COPY config.example.json /app/config.example.json
EXPOSE 8919
CMD ["node", "/app/server.js"]
