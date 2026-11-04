package main

import (
	"fmt"
	"net/url"
	"os"
	"strings"
)

func requiredEnv(name string) string {
	value := strings.TrimSpace(os.Getenv(name))
	if value == "" {
		panic(fmt.Sprintf("required environment variable %s is not set", name))
	}
	return value
}

func publicAppURL() string {
	value := strings.TrimRight(requiredEnv("PUBLIC_APP_URL"), "/")
	parsed, err := url.ParseRequestURI(value)
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" {
		panic("PUBLIC_APP_URL must be an absolute http(s) URL")
	}
	return value
}
