# --------> The build image
FROM node:20 AS build
WORKDIR /app
COPY package.json ./
COPY yarn.lock ./
ENV NODE_ENV=production
RUN yarn install --prod

# --------> The production image, USER node in alpine
FROM gcr.io/distroless/nodejs20-debian12
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY ./src .
CMD ["server.js"]