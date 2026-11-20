FROM golang:1.27-alpine AS build
WORKDIR /src/notification-worker
COPY worker-runtime/go.* /src/worker-runtime/
COPY notification-worker/go.mod notification-worker/go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod go mod download
COPY worker-runtime/ /src/worker-runtime/
COPY notification-worker/ .
RUN --mount=type=cache,target=/go/pkg/mod --mount=type=cache,target=/root/.cache/go-build CGO_ENABLED=0 GOOS=linux GOMAXPROCS=2 go build -p 2 -trimpath -ldflags="-s -w" -o /out/notification-worker .

FROM alpine:3.22
RUN apk add --no-cache ca-certificates
COPY --from=build /out/notification-worker /usr/local/bin/notification-worker
USER 10001:10001
ENTRYPOINT ["/usr/local/bin/notification-worker"]
