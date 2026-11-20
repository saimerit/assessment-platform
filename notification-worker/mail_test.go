package main

import (
	"context"
	"errors"
	"net"
	"testing"
	"time"
)

func TestSMTPTimeoutBeforeGreeting(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	completed := make(chan struct{})
	go func() {
		defer close(completed)
		conn, err := listener.Accept()
		if err == nil {
			defer conn.Close()
			buffer := make([]byte, 1)
			_, _ = conn.Read(buffer)
		}
	}()
	host, port, _ := net.SplitHostPort(listener.Addr().String())
	sender := &MailSender{host: host, port: port, from: "sender@test.invalid", mode: "smtp"}
	ctx, cancel := context.WithTimeout(context.Background(), 150*time.Millisecond)
	defer cancel()
	start := time.Now()
	err = sender.Send(ctx, "candidate@test.invalid", "Test", "body")
	if !errors.Is(err, context.DeadlineExceeded) || time.Since(start) > time.Second {
		t.Fatal("SMTP greeting wait exceeded the processing deadline", err)
	}
	select {
	case <-completed:
	case <-time.After(time.Second):
		t.Fatal("timed-out SMTP socket stayed open")
	}
}
func TestSMTPConfigurationIsExplicit(t *testing.T) {
	t.Setenv("SMTP_HOST", "")
	t.Setenv("SMTP_PORT", "")
	t.Setenv("SMTP_MODE", "smtp")
	if _, err := loadMailSender(); err == nil {
		t.Fatal("missing production SMTP silently became mock delivery")
	}
	t.Setenv("SMTP_MODE", "mock")
	sender, err := loadMailSender()
	if err != nil {
		t.Fatal(err)
	}
	if err = sender.Send(context.Background(), "candidate@test.invalid", "Test", "body"); err != nil {
		t.Fatal(err)
	}
	if sender.Send(context.Background(), "candidate@test.invalid", "Injected\r\nSubject: bad", "body") == nil {
		t.Fatal("header injection accepted")
	}
}
