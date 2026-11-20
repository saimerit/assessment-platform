package workerqueue

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestQueueAgeAndUnknownMetadata(t *testing.T) {
	c, _ := LoadConfig("grade", "amqp://guest:guest@localhost/")
	timestamp := float64(time.Now().Add(-time.Minute).Unix())
	missing := false
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if user, pass, ok := r.BasicAuth(); !ok || user != "guest" || pass != "guest" {
			t.Error("management credentials missing")
		}
		if missing {
			json.NewEncoder(w).Encode(map[string]any{"messages_ready": 1, "head_message_timestamp": nil})
		} else {
			json.NewEncoder(w).Encode(map[string]any{"messages_ready": 1, "head_message_timestamp": timestamp})
		}
	}))
	defer server.Close()
	c.ManagementURL = server.URL
	r := Runner{Config: c}
	age, err := r.queueAge(context.Background(), []string{"grade"}, map[string]int{"grade": 1})
	if err != nil || age < 59 {
		t.Fatal("queue age was not derived from head metadata", err)
	}
	missing = true
	if _, err = r.queueAge(context.Background(), []string{"grade"}, map[string]int{"grade": 1}); err == nil {
		t.Fatal("missing timestamp reported as zero age")
	}
	r.Config.ManagementURL = ""
	if _, err = r.queueAge(context.Background(), []string{"grade"}, map[string]int{"grade": 1}); err == nil {
		t.Fatal("unconfigured age reported as known")
	}
}
func TestHealthReadinessAndRedaction(t *testing.T) {
	c, _ := LoadConfig("grade", "amqp://guest:secret-password@localhost/")
	r := Runner{Config: c}
	r.health.snapshot = Snapshot{Queue: "grade", Ready: true, BrokerConnected: true, DatabaseAvailable: true, Alerts: []string{"DEAD_LETTERS_PRESENT"}}
	response := httptest.NewRecorder()
	r.healthHandler().ServeHTTP(response, httptest.NewRequest("GET", "/readyz", nil))
	if response.Code != 200 {
		t.Fatal("ready consumer marked unavailable")
	}
	if strings.Contains(response.Body.String(), "secret-password") || strings.Contains(response.Body.String(), "body_hash") {
		t.Fatal("health exposed credentials or job metadata")
	}
	r.health.disconnected()
	response = httptest.NewRecorder()
	r.healthHandler().ServeHTTP(response, httptest.NewRequest("GET", "/readyz", nil))
	if response.Code != 503 || !strings.Contains(response.Body.String(), "BROKER_DISCONNECTED") {
		t.Fatal("dead consumer reported ready")
	}
}
