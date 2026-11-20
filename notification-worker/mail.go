package main

import (
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"net"
	"net/mail"
	"net/smtp"
	"os"
	"strings"
	"time"
)

type MailSender struct{ host, port, from, mode string }

func loadMailSender() (*MailSender, error) {
	s := &MailSender{host: strings.TrimSpace(os.Getenv("SMTP_HOST")), port: strings.TrimSpace(os.Getenv("SMTP_PORT")), from: strings.TrimSpace(os.Getenv("SMTP_SENDER")), mode: strings.TrimSpace(os.Getenv("SMTP_MODE"))}
	if s.mode == "" {
		s.mode = "smtp"
	}
	if s.from == "" {
		s.from = "no-reply@assessmentplatform.internal"
	}
	if _, err := mail.ParseAddress(s.from); err != nil {
		return nil, fmt.Errorf("invalid SMTP sender")
	}
	if s.mode != "mock" && s.mode != "smtp" {
		return nil, fmt.Errorf("SMTP_MODE must be smtp or mock")
	}
	if s.mode == "smtp" && (s.host == "" || s.port == "") {
		return nil, fmt.Errorf("SMTP_HOST and SMTP_PORT are required for smtp mode")
	}
	return s, nil
}
func (s *MailSender) Send(ctx context.Context, to, subject, html string) (err error) {
	defer func() {
		if ctx.Err() != nil {
			err = ctx.Err()
		}
		var timedOut net.Error
		if deadline, ok := ctx.Deadline(); ok && err != nil && !time.Now().Before(deadline) && errors.As(err, &timedOut) && timedOut.Timeout() {
			err = context.DeadlineExceeded
		}
	}()
	from, err := mail.ParseAddress(s.from)
	if err != nil {
		return err
	}
	recipient, err := mail.ParseAddress(to)
	if err != nil {
		return err
	}
	if strings.ContainsAny(subject, "\r\n") {
		return errors.New("invalid mail subject")
	}
	if s.mode == "mock" {
		return ctx.Err()
	}
	conn, err := (&net.Dialer{Timeout: 5 * time.Second}).DialContext(ctx, "tcp", net.JoinHostPort(s.host, s.port))
	if err != nil {
		return err
	}
	defer conn.Close()
	deadline, ok := ctx.Deadline()
	if !ok {
		deadline = time.Now().Add(15 * time.Second)
	}
	if err = conn.SetDeadline(deadline); err != nil {
		return err
	}
	cancelClose := context.AfterFunc(ctx, func() { conn.Close() })
	defer cancelClose()
	client, err := smtp.NewClient(conn, s.host)
	if err != nil {
		return err
	}
	defer client.Close()
	if supports, _ := client.Extension("STARTTLS"); supports {
		if err = client.StartTLS(&tls.Config{ServerName: s.host, MinVersion: tls.VersionTLS12}); err != nil {
			return err
		}
	}
	if err = client.Mail(from.Address); err != nil {
		return err
	}
	if err = client.Rcpt(recipient.Address); err != nil {
		return err
	}
	writer, err := client.Data()
	if err != nil {
		return err
	}
	message := fmt.Sprintf("From: %s\r\nTo: %s\r\nSubject: %s\r\nMIME-Version: 1.0\r\nContent-Type: text/html; charset=UTF-8\r\n\r\n%s", from.String(), recipient.String(), subject, html)
	if _, err = writer.Write([]byte(message)); err != nil {
		return err
	}
	if err = writer.Close(); err != nil {
		return err
	}
	// DATA's successful final reply is the acceptance point. Close the socket
	// without waiting on QUIT so an accepted message can be audited promptly.
	return nil
}
