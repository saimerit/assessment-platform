package main

import (
	"strconv"
	"strings"
)

const attemptAuthClientVersion = "1.3.0"

// Old invitation links remain valid, but clients predating candidate-bound
// attempt credentials must update. Preserve any higher blueprint requirement.
func requiredAttemptClientVersion(configured string) string {
	current, minimum := strings.Split(configured, "."), strings.Split(attemptAuthClientVersion, ".")
	if len(current) != 3 {
		return attemptAuthClientVersion
	}
	var parts [3]int
	for i, part := range current {
		value, err := strconv.Atoi(part)
		if err != nil || value < 0 {
			return attemptAuthClientVersion
		}
		parts[i] = value
	}
	for i, part := range minimum {
		value, _ := strconv.Atoi(part)
		if parts[i] > value {
			return configured
		}
		if parts[i] < value {
			return attemptAuthClientVersion
		}
	}
	return configured
}
