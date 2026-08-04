package compaction

// Feature 6: Output optimization — verbosity steering and effort routing.
// Provides optimized system prompts for internal LLM calls that reduce
// output tokens by 30-40% while preserving information density.

// OptimizedSystemPrompt wraps a system prompt with verbosity steering.
// This tells the LLM to be concise without losing information.
func OptimizedSystemPrompt(original string) string {
	return original + "\n\n" +
		"IMPORTANT: Be extremely concise. Do not restate the input. " +
		"Do not use filler phrases like 'Great question' or 'Let me explain'. " +
		"Output only the essential information. Use bullet points over prose. " +
		"If generating JSON, use minimal whitespace."
}

// EffortLevel determines how much reasoning the LLM should apply.
type EffortLevel string

const (
	EffortFull    EffortLevel = "full"    // Complex reasoning, new questions
	EffortMedium  EffortLevel = "medium"  // Standard processing
	EffortMinimal EffortLevel = "minimal" // Routine operations (summarize, extract)
)

// RouteEffort determines the appropriate effort level for an LLM call.
// Compaction and fact extraction are routine; reflection needs full reasoning.
func RouteEffort(callType string) EffortLevel {
	switch callType {
	case "compaction", "summarize":
		return EffortMinimal
	case "fact_extraction", "dedup":
		return EffortMinimal
	case "reflect", "reason":
		return EffortFull
	case "contradiction":
		return EffortMedium
	default:
		return EffortMedium
	}
}

// MaxTokensForEffort returns the appropriate max_tokens setting.
func MaxTokensForEffort(effort EffortLevel) int {
	switch effort {
	case EffortMinimal:
		return 512
	case EffortMedium:
		return 1024
	case EffortFull:
		return 2048
	default:
		return 1024
	}
}

// TemperatureForEffort returns the appropriate temperature setting.
func TemperatureForEffort(effort EffortLevel) float64 {
	switch effort {
	case EffortMinimal:
		return 0.1 // Very deterministic for summarization
	case EffortMedium:
		return 0.3
	case EffortFull:
		return 0.5 // More creative for reasoning
	default:
		return 0.3
	}
}
