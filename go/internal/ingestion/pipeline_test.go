package ingestion

import (
	"testing"
)

func TestExtractFactsHeuristic(t *testing.T) {
	content := `USER: Why was the service timing out?
ASSISTANT: The root cause was VPC DNS resolution. Lambda functions in VPC must resolve DNS through the VPC's DNS server.
USER: What should we do?
ASSISTANT: We decided to use VPC endpoints for S3 instead of NAT gateway. This avoids the timeout completely.
ASSISTANT: Always use exponential backoff when retrying DynamoDB writes. The maximum retry count should be 5.`

	facts := extractFactsHeuristic(content)

	if len(facts) < 3 {
		t.Fatalf("expected at least 3 facts, got %d", len(facts))
	}

	// Check types
	types := map[string]bool{}
	for _, f := range facts {
		types[f.factType] = true
	}

	if !types["lesson"] {
		t.Error("should extract a lesson (root cause)")
	}
	if !types["decision"] {
		t.Error("should extract a decision (decided to use)")
	}
	if !types["pattern"] {
		t.Error("should extract a pattern (always use)")
	}
}

func TestExtractFactsHeuristicConstraint(t *testing.T) {
	content := `ASSISTANT: The maximum payload size for API Gateway is 10MB. You cannot exceed this limit.`

	facts := extractFactsHeuristic(content)

	if len(facts) == 0 {
		t.Fatal("expected at least 1 constraint fact")
	}
	if facts[0].factType != "constraint" {
		t.Errorf("expected constraint, got %s", facts[0].factType)
	}
}

func TestExtractFactsHeuristicOpinion(t *testing.T) {
	content := `USER: I think Kafka is better than SQS for our event-driven architecture`

	facts := extractFactsHeuristic(content)

	if len(facts) == 0 {
		t.Fatal("expected at least 1 opinion fact")
	}
	if facts[0].factType != "opinion" {
		t.Errorf("expected opinion, got %s", facts[0].factType)
	}
}

func TestExtractFactsMaxLimit(t *testing.T) {
	// Generate a lot of decision-like lines
	content := ""
	for i := 0; i < 20; i++ {
		content += "ASSISTANT: We decided to use approach number " + string(rune('A'+i)) + " for this.\n"
	}

	facts := extractFactsHeuristic(content)

	if len(facts) > 8 {
		t.Errorf("should cap at 8 facts, got %d", len(facts))
	}
}

func TestExtractEntities(t *testing.T) {
	text := "We use Kafka and Redis for event streaming, deployed on Kubernetes with Terraform"

	entities := extractEntities(text)

	if len(entities) < 3 {
		t.Fatalf("expected at least 3 entities, got %d: %v", len(entities), entities)
	}

	found := map[string]bool{}
	for _, e := range entities {
		found[e] = true
	}
	if !found["Kafka"] {
		t.Error("should find Kafka")
	}
	if !found["Redis"] {
		t.Error("should find Redis")
	}
	if !found["Kubernetes"] {
		t.Error("should find Kubernetes")
	}
}

func TestExtractEntitiesLimit(t *testing.T) {
	text := "AWS S3 EC2 Lambda DynamoDB Kafka Redis PostgreSQL MongoDB Docker Kubernetes React TypeScript"
	entities := extractEntities(text)

	if len(entities) > 6 {
		t.Errorf("should cap at 6 entities, got %d", len(entities))
	}
}

func TestExtractTitle(t *testing.T) {
	content := "USER: How do I fix Lambda timeout in VPC?\nASSISTANT: The issue is DNS resolution..."
	title := extractTitle(content)

	if title == "" {
		t.Error("title should not be empty")
	}
	if len(title) > 84 { // 80 + "..."
		t.Errorf("title should be truncated, got %d chars", len(title))
	}
}

func TestContainsAny(t *testing.T) {
	if !containsAny("we decided to use kafka", "decided", "chose") {
		t.Error("should match 'decided'")
	}
	if containsAny("hello world", "decided", "chose") {
		t.Error("should not match")
	}
}

func TestContainsDigit(t *testing.T) {
	if !containsDigit("timeout is 30 seconds") {
		t.Error("should detect digit")
	}
	if containsDigit("no numbers here") {
		t.Error("should not detect digit")
	}
}
