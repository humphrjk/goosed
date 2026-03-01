FROM node:22-alpine
WORKDIR /app
COPY serve.js .
COPY frontend/ frontend/
EXPOSE 3001
CMD ["node", "serve.js"]
