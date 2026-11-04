FROM golang:1.27-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/assessment-api .

FROM alpine:3.22
RUN apk add --no-cache ca-certificates
COPY --from=build /out/assessment-api /usr/local/bin/assessment-api
ENV ASSESSMENT_API_PORT=8080
EXPOSE 8080
USER 10001:10001
ENTRYPOINT ["/usr/local/bin/assessment-api"]
