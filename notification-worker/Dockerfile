FROM golang:1.27-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/notification-worker .

FROM alpine:3.22
RUN apk add --no-cache ca-certificates
COPY --from=build /out/notification-worker /usr/local/bin/notification-worker
USER 10001:10001
ENTRYPOINT ["/usr/local/bin/notification-worker"]
