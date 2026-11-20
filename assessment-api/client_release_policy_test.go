package main

import "testing"

func TestRequiredAttemptClientVersion(t *testing.T) {
	for _, tc := range []struct{ configured, required string }{
		{"", "1.3.0"}, {"1.0.0", "1.3.0"}, {"0.9.9", "1.3.0"}, {"1.3.0", "1.3.0"},
		{"1.1.1", "1.3.0"}, {"1.2.1", "1.3.0"}, {"1.3.1", "1.3.1"}, {"1.10.0", "1.10.0"}, {"2.0.0", "2.0.0"}, {"invalid", "1.3.0"},
	} {
		if got := requiredAttemptClientVersion(tc.configured); got != tc.required {
			t.Errorf("%q: got %q, want %q", tc.configured, got, tc.required)
		}
	}
}
