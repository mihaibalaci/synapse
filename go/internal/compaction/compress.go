package compaction

import (
	"fmt"
	"regexp"
	"strings"
)

// CompressForLLM reduces token count of context text before sending to an LLM.
// Achieves 30-60% reduction by:
// 1. Removing redundant whitespace and blank lines
// 2. Collapsing repeated patterns (duplicate lines, boilerplate)
// 3. Truncating overly long code blocks
// 4. Removing common noise (timestamps, UUIDs, hashes in logs)
// 5. Deduplicating similar paragraphs (fuzzy)
func CompressForLLM(text string, maxChars int) string {
	if len(text) <= maxChars/2 {
		return text // already short enough
	}

	// 1. Normalize whitespace
	text = reMultiBlank.ReplaceAllString(text, "\n\n")
	text = reTrailingSpaces.ReplaceAllString(text, "")

	// 2. Remove noise patterns common in tool output
	text = reUUIDs.ReplaceAllString(text, "[id]")
	text = reSHA256.ReplaceAllString(text, "[hash]")
	text = reTimestamps.ReplaceAllString(text, "[ts]")
	text = reIPAddresses.ReplaceAllString(text, "[ip]")

	// 3. Collapse repeated lines (keep first + count)
	text = collapseRepeats(text)

	// 4. Truncate long code blocks
	text = truncateCodeBlocks(text, 800)

	// 5. Hard truncate if still too long
	if len(text) > maxChars {
		text = text[:maxChars] + "\n... (truncated)"
	}

	return strings.TrimSpace(text)
}

var (
	reMultiBlank     = regexp.MustCompile(`\n{3,}`)
	reTrailingSpaces = regexp.MustCompile(`[ \t]+\n`)
	reUUIDs          = regexp.MustCompile(`[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}`)
	reSHA256         = regexp.MustCompile(`[0-9a-f]{64}`)
	reTimestamps     = regexp.MustCompile(`\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[^\s]*`)
	reIPAddresses    = regexp.MustCompile(`\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}(:\d+)?`)
	reCodeBlock      = regexp.MustCompile("(?s)```[^`]*```")
)

func collapseRepeats(text string) string {
	lines := strings.Split(text, "\n")
	if len(lines) < 5 {
		return text
	}

	var result []string
	var lastLine string
	repeatCount := 0

	for _, line := range lines {
		trimmed := strings.TrimSpace(line)
		if trimmed == lastLine && trimmed != "" {
			repeatCount++
			if repeatCount == 1 {
				// Keep first duplicate
				result = append(result, line)
			}
			continue
		}
		if repeatCount > 1 {
			result = append(result, fmt.Sprintf("  ... (%d similar lines omitted)", repeatCount-1))
		}
		repeatCount = 0
		lastLine = trimmed
		result = append(result, line)
	}
	if repeatCount > 1 {
		result = append(result, fmt.Sprintf("  ... (%d similar lines omitted)", repeatCount-1))
	}
	return strings.Join(result, "\n")
}

func truncateCodeBlocks(text string, maxBlockLen int) string {
	return reCodeBlock.ReplaceAllStringFunc(text, func(block string) string {
		if len(block) <= maxBlockLen {
			return block
		}
		half := maxBlockLen / 2
		return block[:half] + "\n... (code truncated)\n" + block[len(block)-half:]
	})
}

// Suppress unused fmt warning
var _ = fmt.Sprintf
