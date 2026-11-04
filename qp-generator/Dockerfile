FROM golang:1.27-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/qp-generator .

FROM alpine:3.22
RUN apk add --no-cache ca-certificates
COPY --from=build /out/qp-generator /usr/local/bin/qp-generator
USER 10001:10001
ENTRYPOINT ["/usr/local/bin/qp-generator"]
