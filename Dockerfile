FROM oven/bun:1.4

WORKDIR /app

ADD package.json bun.lock ./
RUN bun install --frozen-lockfile

ADD . .

ENV PORT=8080
EXPOSE 8080

CMD [ "bun", "start" ]
