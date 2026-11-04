package main

import (
	"fmt"
	"net/url"
	"os"
	"strings"

	"github.com/redis/go-redis/v9"
)

// RuntimeConfig deliberately has no development defaults.  Credentials and public
// URLs are deployment concerns and a process with incomplete configuration must
// not accidentally start against a local or insecure service.
type RuntimeConfig struct {
	DatabaseURL      string
	RedisURL         string
	RabbitMQURL      string
	PublicAppURL     string
	ClientReleaseURL string
	Port             string
}

func requiredEnv(name string) string {
	value := strings.TrimSpace(os.Getenv(name))
	if value == "" {
		panic(fmt.Sprintf("required environment variable %s is not set", name))
	}
	return value
}

func requiredHTTPURL(name string) string {
	value := strings.TrimRight(requiredEnv(name), "/")
	parsed, err := url.ParseRequestURI(value)
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" {
		panic(fmt.Sprintf("%s must be an absolute http(s) URL", name))
	}
	return value
}

func loadRuntimeConfig() RuntimeConfig {
	cfg := RuntimeConfig{
		DatabaseURL:      requiredEnv("ASSESSMENT_DATABASE_URL"),
		RedisURL:         requiredEnv("REDIS_URL"),
		RabbitMQURL:      requiredEnv("RABBITMQ_URL"),
		PublicAppURL:     requiredHTTPURL("PUBLIC_APP_URL"),
		ClientReleaseURL: requiredHTTPURL("CLIENT_RELEASE_URL"),
		Port:             requiredEnv("ASSESSMENT_API_PORT"),
	}
	if _, err := redis.ParseURL(cfg.RedisURL); err != nil {
		panic(fmt.Sprintf("REDIS_URL is invalid: %v", err))
	}
	return cfg
}

func publicAppURL() string     { return strings.TrimRight(requiredEnv("PUBLIC_APP_URL"), "/") }
func clientReleaseURL() string { return requiredHTTPURL("CLIENT_RELEASE_URL") }
