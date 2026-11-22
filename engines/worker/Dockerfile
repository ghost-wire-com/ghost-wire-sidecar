FROM golang:1.26.3 AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -trimpath -o /ghostwire ./cmd/ghostwire

FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-pip ca-certificates curl git ripgrep nmap dnsutils netcat-openbsd procps && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /ghostwire /app/ghostwire
COPY secret-entrypoint.sh /app/secret-entrypoint.sh
RUN chmod 0755 /app/secret-entrypoint.sh
COPY LICENSE /app/LICENSE
RUN mkdir -p /app/data /app/skills
VOLUME ["/app/data"]
ENTRYPOINT ["/app/secret-entrypoint.sh"]
CMD ["-addr", ":8787", "-proxy", ":8788", "-data", "/app/data"]
