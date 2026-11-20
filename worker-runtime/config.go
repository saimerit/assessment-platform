package workerqueue

import (
	"fmt"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

type Config struct {
	Queue, BrokerURL, ManagementURL, HealthAddress       string
	MaxAttempts                                          int
	Timeout, PublishTimeout, MonitorInterval, AgeWarning time.Duration
	RetryDelays                                          []time.Duration
}

func LoadConfig(queue, broker string) (Config, error) {
	c := Config{Queue: queue, BrokerURL: broker, HealthAddress: ":8091", MaxAttempts: 5, Timeout: 15 * time.Second,
		PublishTimeout: 5 * time.Second, MonitorInterval: 5 * time.Second, AgeWarning: 5 * time.Minute,
		RetryDelays: []time.Duration{2 * time.Second, 10 * time.Second, 30 * time.Second, 60 * time.Second}}
	if raw := os.Getenv("WORKER_HEALTH_ADDRESS"); raw != "" {
		c.HealthAddress = raw
	}
	c.ManagementURL = strings.TrimRight(os.Getenv("RABBITMQ_MANAGEMENT_URL"), "/")
	if c.ManagementURL != "" {
		u, err := url.Parse(c.ManagementURL)
		if err != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") || u.User != nil {
			return c, fmt.Errorf("invalid RABBITMQ_MANAGEMENT_URL")
		}
	}
	if raw := os.Getenv("WORKER_MAX_ATTEMPTS"); raw != "" {
		n, err := strconv.Atoi(raw)
		if err != nil || n < 1 || n > 10 {
			return c, fmt.Errorf("WORKER_MAX_ATTEMPTS must be 1–10")
		}
		c.MaxAttempts = n
	}
	for name, target := range map[string]*time.Duration{"WORKER_PROCESSING_TIMEOUT": &c.Timeout, "WORKER_MONITOR_INTERVAL": &c.MonitorInterval, "WORKER_QUEUE_AGE_WARNING": &c.AgeWarning} {
		if raw := os.Getenv(name); raw != "" {
			d, err := time.ParseDuration(raw)
			if err != nil || d < 100*time.Millisecond || d > time.Hour {
				return c, fmt.Errorf("invalid %s", name)
			}
			*target = d
		}
	}
	if raw := os.Getenv("WORKER_RETRY_DELAYS"); raw != "" {
		c.RetryDelays = nil
		for _, part := range strings.Split(raw, ",") {
			d, err := time.ParseDuration(strings.TrimSpace(part))
			if err != nil || d < 100*time.Millisecond || d > time.Hour {
				return c, fmt.Errorf("invalid WORKER_RETRY_DELAYS")
			}
			c.RetryDelays = append(c.RetryDelays, d)
		}
	}
	if len(c.RetryDelays) == 0 {
		return c, fmt.Errorf("retry delays cannot be empty")
	}
	for i := 1; i < len(c.RetryDelays); i++ {
		if c.RetryDelays[i] < c.RetryDelays[i-1] {
			return c, fmt.Errorf("retry delays must be ascending")
		}
	}
	return c, nil
}
func (c Config) delay(attempt int) time.Duration {
	i := attempt - 1
	if i < 0 {
		i = 0
	}
	if i >= len(c.RetryDelays) {
		i = len(c.RetryDelays) - 1
	}
	return c.RetryDelays[i]
}
func (c Config) retryQueue(delay time.Duration) string {
	for _, d := range c.RetryDelays {
		if d >= delay {
			return fmt.Sprintf("%s.retry.%d", c.Queue, d.Milliseconds())
		}
	}
	return fmt.Sprintf("%s.retry.%d", c.Queue, c.RetryDelays[len(c.RetryDelays)-1].Milliseconds())
}
