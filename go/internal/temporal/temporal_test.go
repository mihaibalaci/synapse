package temporal

import (
	"testing"
	"time"
)

func TestDeriveTopic(t *testing.T) {
	tests := []struct {
		name     string
		content  string
		entities []string
		want     string
	}{
		{
			name:     "two entities",
			content:  "We use PostgreSQL for caching",
			entities: []string{"PostgreSQL", "caching"},
			want:     "PostgreSQL:caching",
		},
		{
			name:     "single entity",
			content:  "Redis is our cache layer",
			entities: []string{"Redis"},
			want:     "Redis",
		},
		{
			name:     "no entities uses content prefix",
			content:  "This is a long statement about architecture that exceeds fifty characters easily",
			entities: []string{},
			want:     "This is a long statement about architecture that e",
		},
		{
			name:     "three entities uses first two",
			content:  "decision about services",
			entities: []string{"Go", "gRPC", "microservices"},
			want:     "Go:gRPC",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := deriveTopic(tt.content, tt.entities)
			if got != tt.want {
				t.Errorf("deriveTopic() = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestDetectChangeType(t *testing.T) {
	tests := []struct {
		content string
		want    string
	}{
		{"We migrated from MySQL to PostgreSQL for better JSON support", "evolution"},
		{"Correction: the timeout is 30s, not 60s as previously stated", "correction"},
		{"We no longer use Redis for session storage", "retraction"},
		{"Stopped using Kafka due to operational complexity", "retraction"},
		{"Actually the API uses gRPC not REST", "correction"},
		{"Switched from GitHub Actions to Buildkite", "evolution"},
	}

	for _, tt := range tests {
		t.Run(tt.content[:30], func(t *testing.T) {
			got := detectChangeType(tt.content)
			if got != tt.want {
				t.Errorf("detectChangeType(%q) = %q, want %q", tt.content, got, tt.want)
			}
		})
	}
}

func TestContainsInsensitive(t *testing.T) {
	tests := []struct {
		s      string
		substr string
		want   bool
	}{
		{"Hello World", "world", true},
		{"Hello World", "HELLO", true},
		{"correction: fix", "correction:", true},
		{"no match here", "xyz", false},
		{"short", "this is longer than the source", false},
		{"", "test", false},
		{"test", "", true},
	}

	for _, tt := range tests {
		t.Run(tt.s+"_"+tt.substr, func(t *testing.T) {
			got := containsInsensitive(tt.s, tt.substr)
			if got != tt.want {
				t.Errorf("containsInsensitive(%q, %q) = %v, want %v", tt.s, tt.substr, got, tt.want)
			}
		})
	}
}

func TestComputeTemporalStatus(t *testing.T) {
	now := time.Now()
	past := now.Add(-24 * time.Hour)
	future := now.Add(24 * time.Hour)
	supersededBy := "some-id"

	tests := []struct {
		name  string
		entry TimelineEntry
		asOf  time.Time
		want  string
	}{
		{
			name:  "active fact",
			entry: TimelineEntry{},
			asOf:  now,
			want:  "active",
		},
		{
			name:  "superseded fact",
			entry: TimelineEntry{SupersededBy: &supersededBy},
			asOf:  now,
			want:  "superseded",
		},
		{
			name:  "expired fact",
			entry: TimelineEntry{ValidUntil: &past},
			asOf:  now,
			want:  "expired",
		},
		{
			name:  "future fact",
			entry: TimelineEntry{ValidFrom: &future},
			asOf:  now,
			want:  "future",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := computeTemporalStatus(tt.entry, tt.asOf)
			if got != tt.want {
				t.Errorf("computeTemporalStatus() = %q, want %q", got, tt.want)
			}
		})
	}
}
