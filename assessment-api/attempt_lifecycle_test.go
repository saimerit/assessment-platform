package main

import (
	"testing"
	"time"
)

func TestPinnedLifecycleBoundaries(t *testing.T) {
	now := time.Now().UTC()
	start := now.Add(-time.Minute)
	deadline := now.Add(time.Minute)
	state := lifecycleRecord{Status: "IN_PROGRESS", Start: start, End: now.Add(-time.Second), StartedAt: &start, Deadline: &deadline}
	if err := state.validate(now, true); err != nil {
		t.Fatal("closed entry window blocked a live timer", err)
	}
	if err := state.validate(deadline.Add(-time.Nanosecond), true); err != nil {
		t.Fatal("last instant before deadline rejected", err)
	}
	if state.validate(deadline, true) == nil || state.validate(deadline.Add(time.Nanosecond), true) == nil {
		t.Fatal("deadline allowed late edits")
	}
	state.StartedAt = nil
	if state.validate(now, true) == nil || state.validate(now, false) == nil {
		t.Fatal("unstarted attempt bypassed entry window")
	}
	state.Status = "SUBMITTED"
	state.StartedAt = &start
	if state.validate(now, true) == nil {
		t.Fatal("terminal attempt allowed execution")
	}
}
