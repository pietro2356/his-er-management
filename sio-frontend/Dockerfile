# STAGE 1: Build dell'applicazione Angular
FROM node:24-alpine AS build
LABEL authors="pietro"

WORKDIR /app

# Copiamo prima i package per sfruttare la cache di Docker
COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

# STAGE 2: Web Server Nginx per servire i file
FROM nginx:alpine

# Copia la configurazione custom di Nginx creata prima
COPY nginx.conf /etc/nginx/conf.d/default.conf

# Copia i file compilati dallo stage di build
# NOTA IMPORTANTE: Con Angular 17+ il percorso è spesso dist/nome-progetto/browser
# Verifica nel tuo angular.json dove finisce l'output. Qui assumo 'sio-frontend'.
COPY --from=build /app/dist/sio-frontend/browser /usr/share/nginx/html

EXPOSE 80
