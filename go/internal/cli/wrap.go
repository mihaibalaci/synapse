// Package cli implements the synapse wrap/unwrap commands for zero-config
// agent integration. It generates MCP configuration files for supported agents.
package cli

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

// WrapAgent generates MCP configuration for the specified agent.
func WrapAgent(args []string) {
	if len(args) == 0 {
		fmt.Fprintf(os.Stderr, `Usage: synapse wrap <agent>

Supported agents:
  claude    — Claude Code / Claude Desktop
  cursor    — Cursor IDE
  codex     — OpenAI Codex CLI
  kiro      — Kiro IDE
  muse      — Meta Muse Code
  vscode    — VS Code (generic MCP)
  continue  — Continue.dev
  cline     — Cline

Options:
  --token TOKEN   Bearer token or API key (default: SYNAPSE_TOKEN env)
  --url URL       Synapse API URL (default: http://localhost:3000)
  --org ORG       Organization ID (default: default)

Example:
  synapse wrap claude
  synapse wrap cursor --token sk_synapse_abc123
  synapse wrap kiro --url http://192.168.1.100:3000
`)
		os.Exit(1)
	}

	agent := strings.ToLower(args[0])
	token := envOrFlag(args, "--token", os.Getenv("SYNAPSE_TOKEN"))
	apiURL := envOrFlag(args, "--url", envOr("SYNAPSE_API_URL", "http://localhost:3000"))

	synapseBin := findSynapseBinary()

	switch agent {
	case "claude":
		wrapClaude(synapseBin, token, apiURL)
	case "cursor":
		wrapCursor(synapseBin, token, apiURL)
	case "codex":
		wrapCodex(synapseBin, token, apiURL)
	case "muse":
		wrapMuse(synapseBin, token, apiURL)
	case "kiro":
		wrapKiro(synapseBin, token, apiURL)
	case "vscode":
		wrapVSCode(synapseBin, token, apiURL)
	case "continue":
		wrapContinue(synapseBin, token, apiURL)
	case "cline":
		wrapCline(synapseBin, token, apiURL)
	default:
		fmt.Fprintf(os.Stderr, "Unknown agent: %s\nRun 'synapse wrap' for supported agents.\n", agent)
		os.Exit(1)
	}
}

// UnwrapAgent removes MCP configuration for the specified agent.
func UnwrapAgent(args []string) {
	if len(args) == 0 {
		fmt.Fprintln(os.Stderr, "Usage: synapse unwrap <agent>")
		os.Exit(1)
	}
	agent := strings.ToLower(args[0])

	switch agent {
	case "claude":
		path := claudeConfigPath()
		removeKey(path, "synapse")
	case "cursor":
		path := cursorConfigPath()
		removeKey(path, "synapse")
	case "kiro":
		path := kiroConfigPath()
		removeKey(path, "synapse")
	case "muse":
		path := museConfigPath()
		removeKey(path, "synapse")
	default:
		fmt.Fprintf(os.Stderr, "Unwrap not yet implemented for: %s\n", agent)
		os.Exit(1)
	}
}

func wrapClaude(bin, token, apiURL string) {
	path := claudeConfigPath()
	config := mcpServerEntry(bin, token, apiURL)
	writeOrMergeMCP(path, "synapse", config)
	fmt.Printf("✓ Claude Code configured.\n  Config: %s\n  MCP server: synapse (11 tools)\n", path)
	fmt.Printf("  Restart Claude Code to activate.\n")
}

func wrapCursor(bin, token, apiURL string) {
	path := cursorConfigPath()
	config := mcpServerEntry(bin, token, apiURL)
	writeOrMergeMCP(path, "synapse", config)
	fmt.Printf("✓ Cursor configured.\n  Config: %s\n  MCP server: synapse (11 tools)\n", path)
	fmt.Printf("  Restart Cursor to activate.\n")
}

func wrapCodex(bin, token, apiURL string) {
	path := codexConfigPath()
	config := mcpServerEntry(bin, token, apiURL)
	writeOrMergeMCP(path, "synapse", config)
	fmt.Printf("✓ Codex configured.\n  Config: %s\n  MCP server: synapse (11 tools)\n", path)
}

func wrapMuse(bin, token, apiURL string) {
	path := museConfigPath()
	config := mcpServerEntry(bin, token, apiURL)
	writeOrMergeMCP(path, "synapse", config)
	fmt.Printf("✓ Muse Code configured.\n  Config: %s\n  MCP server: synapse (11 tools)\n", path)
	fmt.Printf("  Restart Muse Code to activate.\n")
}

func wrapKiro(bin, token, apiURL string) {
	path := kiroConfigPath()
	config := mcpServerEntry(bin, token, apiURL)
	writeOrMergeMCP(path, "synapse", config)
	fmt.Printf("✓ Kiro configured.\n  Config: %s\n  MCP server: synapse (11 tools)\n", path)
	fmt.Printf("  Restart Kiro to activate.\n")
}

func wrapVSCode(bin, token, apiURL string) {
	path := vscodeConfigPath()
	config := mcpServerEntry(bin, token, apiURL)
	writeOrMergeMCP(path, "synapse", config)
	fmt.Printf("✓ VS Code configured.\n  Config: %s\n  MCP server: synapse (11 tools)\n", path)
}

func wrapContinue(bin, token, apiURL string) {
	path := continueConfigPath()
	config := mcpServerEntry(bin, token, apiURL)
	writeOrMergeMCP(path, "synapse", config)
	fmt.Printf("✓ Continue configured.\n  Config: %s\n", path)
}

func wrapCline(bin, token, apiURL string) {
	path := clineConfigPath()
	config := mcpServerEntry(bin, token, apiURL)
	writeOrMergeMCP(path, "synapse", config)
	fmt.Printf("✓ Cline configured.\n  Config: %s\n", path)
}

// ─── Config paths ────────────────────────────────────────────────────────────

func claudeConfigPath() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".claude", "claude_desktop_config.json")
}

func cursorConfigPath() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".cursor", "mcp.json")
}

func codexConfigPath() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".codex", "mcp.json")
}

func museConfigPath() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".muse", "mcp.json")
}

func kiroConfigPath() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".kiro", "settings", "mcp.json")
}

func vscodeConfigPath() string {
	home, _ := os.UserHomeDir()
	if runtime.GOOS == "darwin" {
		return filepath.Join(home, "Library", "Application Support", "Code", "User", "settings.json")
	}
	return filepath.Join(home, ".config", "Code", "User", "settings.json")
}

func continueConfigPath() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".continue", "config.json")
}

func clineConfigPath() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".cline", "mcp.json")
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

func mcpServerEntry(bin, token, apiURL string) map[string]any {
	env := map[string]string{
		"SYNAPSE_API_URL": apiURL,
	}
	if token != "" {
		env["SYNAPSE_TOKEN"] = token
	}
	return map[string]any{
		"command": bin,
		"args":    []string{"mcp"},
		"env":     env,
	}
}

func writeOrMergeMCP(path, serverName string, entry map[string]any) {
	// Ensure directory exists
	dir := filepath.Dir(path)
	os.MkdirAll(dir, 0755)

	// Read existing config
	existing := make(map[string]any)
	if data, err := os.ReadFile(path); err == nil {
		json.Unmarshal(data, &existing)
	}

	// Get or create mcpServers
	servers, ok := existing["mcpServers"].(map[string]any)
	if !ok {
		servers = make(map[string]any)
	}
	servers[serverName] = entry
	existing["mcpServers"] = servers

	// Write back
	data, _ := json.MarshalIndent(existing, "", "  ")
	if err := os.WriteFile(path, data, 0644); err != nil {
		fmt.Fprintf(os.Stderr, "Error writing config: %v\n", err)
		os.Exit(1)
	}
}

func removeKey(path, serverName string) {
	data, err := os.ReadFile(path)
	if err != nil {
		fmt.Printf("Config not found: %s (already clean)\n", path)
		return
	}
	var config map[string]any
	if err := json.Unmarshal(data, &config); err != nil {
		return
	}
	if servers, ok := config["mcpServers"].(map[string]any); ok {
		delete(servers, serverName)
		config["mcpServers"] = servers
		out, _ := json.MarshalIndent(config, "", "  ")
		os.WriteFile(path, out, 0644)
		fmt.Printf("✓ Removed synapse from %s\n", path)
	}
}

func findSynapseBinary() string {
	// Try to find the absolute path of the current binary
	exe, err := os.Executable()
	if err == nil {
		exe, _ = filepath.EvalSymlinks(exe)
		return exe
	}
	// Fallback: look in common paths
	for _, p := range []string{"/usr/local/bin/synapse", "/usr/bin/synapse"} {
		if _, err := os.Stat(p); err == nil {
			return p
		}
	}
	return "synapse" // rely on PATH
}

func envOrFlag(args []string, flag, fallback string) string {
	for i, a := range args {
		if a == flag && i+1 < len(args) {
			return args[i+1]
		}
	}
	return fallback
}
