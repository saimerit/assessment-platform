package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/redis/go-redis/v9"
)

type requestLimitStore interface {
	Take(context.Context, string, int, time.Duration) (bool, time.Duration, error)
}

type redisRequestLimitStore struct{ client *redis.Client }

var requestLimitScript = redis.NewScript(`
local count = redis.call('INCR', KEYS[1])
if count == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
return {count, redis.call('PTTL', KEYS[1])}`)

func (s redisRequestLimitStore) Take(ctx context.Context, key string, maximum int, window time.Duration) (bool, time.Duration, error) {
	values, err := requestLimitScript.Run(ctx, s.client, []string{key}, window.Milliseconds()).Int64Slice()
	if err != nil {
		return false, 0, err
	}
	return values[0] <= int64(maximum), time.Duration(values[1]) * time.Millisecond, nil
}

func limitRequestBody(maximum int64) gin.HandlerFunc {
	return func(c *gin.Context) {
		if c.Request.Body == nil {
			c.Next()
			return
		}
		if c.Request.ContentLength > maximum {
			c.AbortWithStatusJSON(http.StatusRequestEntityTooLarge, gin.H{"error": "Request body is too large"})
			return
		}
		// Buffer bounded bodies so chunked requests also get a consistent 413
		// before JSON binding. No unbounded body read is performed.
		body, err := io.ReadAll(http.MaxBytesReader(c.Writer, c.Request.Body, maximum))
		_ = c.Request.Body.Close()
		if err != nil {
			c.AbortWithStatusJSON(http.StatusRequestEntityTooLarge, gin.H{"error": "Request body is too large"})
			return
		}
		c.Request.Body = io.NopCloser(bytes.NewReader(body))
		c.Next()
	}
}

func (s *Server) enforceRequestLimit(c *gin.Context, key string, maximum int, window time.Duration) bool {
	allowed, retry, err := s.limits.Take(c.Request.Context(), "assessment-limit:"+key, maximum, window)
	if err != nil {
		c.AbortWithStatusJSON(http.StatusServiceUnavailable, gin.H{"error": "Access checks are temporarily unavailable. Please retry."})
		return false
	}
	if !allowed {
		c.Header("Retry-After", strconv.Itoa(max(1, int(retry.Seconds())+1)))
		c.AbortWithStatusJSON(http.StatusTooManyRequests, gin.H{"error": "Too many requests. Please wait before trying again."})
		return false
	}
	return true
}

func (s *Server) limitAttemptRequests(action string, maximum int, window time.Duration) gin.HandlerFunc {
	return func(c *gin.Context) {
		identity := c.GetString("user_id")
		if value, exists := c.Get(attemptContextKey); exists {
			a := value.(attemptRecord)
			identity = a.StudentID + ":" + a.Kind + ":" + a.ID
		}
		if s.enforceRequestLimit(c, action+":"+identity, maximum, window) {
			c.Next()
		}
	}
}

// A high IP ceiling accommodates a campus sharing one gateway; a separate
// account ceiling limits password guessing without trusting proxy headers.
func (s *Server) limitLoginIP(c *gin.Context) {
	if s.enforceRequestLimit(c, "login-ip:"+c.ClientIP(), 1000, time.Minute) {
		c.Next()
	}
}

func (s *Server) allowLoginAccount(c *gin.Context, email string) bool {
	digest := sha256.Sum256([]byte(strings.ToLower(strings.TrimSpace(email))))
	return s.enforceRequestLimit(c, fmt.Sprintf("login-account:%s", hex.EncodeToString(digest[:])), 10, time.Minute)
}
