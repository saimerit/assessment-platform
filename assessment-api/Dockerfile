FROM golang:1.27-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod go mod download
COPY . .
RUN --mount=type=cache,target=/go/pkg/mod --mount=type=cache,target=/root/.cache/go-build CGO_ENABLED=0 GOOS=linux GOMAXPROCS=2 go build -p 2 -trimpath -ldflags="-s -w" -o /out/assessment-api .

FROM alpine:3.22
RUN apk add --no-cache ca-certificates
COPY --from=build /out/assessment-api /usr/local/bin/assessment-api
ENV ASSESSMENT_API_PORT=8080
EXPOSE 8080
USER 10001:10001
ENTRYPOINT ["/usr/local/bin/assessment-api"]
