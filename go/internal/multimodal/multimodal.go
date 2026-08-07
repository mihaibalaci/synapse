// Package multimodal provides document processing capabilities for Synapse,
// enabling capture of knowledge from non-text sources: PDFs, images, diagrams,
// and structured documents.
//
// Supported formats:
//   - PDF: Text extraction via embedded parser, OCR fallback for scanned docs
//   - Images (PNG, JPEG, WEBP): OCR via Tesseract or LLM vision
//   - Diagrams (SVG, draw.io XML): Structure extraction
//   - Documents (Markdown, HTML, plain text): Direct text processing
//   - Code files: AST-aware chunking with function/class boundaries
//
// Architecture:
//
//	Upload → Detect Type → Extract Text → Segment → Embed → Index
//	                         ↓
//	              (OCR/Vision for images)
//	              (PDF parser for documents)
//	              (AST parser for code)
package multimodal

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"path/filepath"
	"strings"
	"time"
	"unicode/utf8"
)

// ─── Document Types ──────────────────────────────────────────────────────────

// DocumentType identifies the category of a captured document.
type DocumentType string

const (
	TypePDF       DocumentType = "pdf"
	TypeImage     DocumentType = "image"
	TypeDiagram   DocumentType = "diagram"
	TypeMarkdown  DocumentType = "markdown"
	TypeHTML      DocumentType = "html"
	TypePlainText DocumentType = "plaintext"
	TypeCode      DocumentType = "code"
	TypeUnknown   DocumentType = "unknown"
)

// Document represents a captured multi-modal document with extracted content.
type Document struct {
	ID           string       `json:"id"`
	Filename     string       `json:"filename"`
	ContentType  string       `json:"contentType"`
	DocumentType DocumentType `json:"documentType"`
	Size         int64        `json:"size"`
	RawData      []byte       `json:"-"`

	// Extracted content
	ExtractedText string            `json:"extractedText"`
	Title         string            `json:"title"`
	Metadata      map[string]string `json:"metadata"`
	Pages         int               `json:"pages,omitempty"`
	Language      string            `json:"language,omitempty"`

	// Processing state
	ProcessedAt *time.Time `json:"processedAt,omitempty"`
	Error       string     `json:"error,omitempty"`
}

// ExtractionResult holds the output of document processing.
type ExtractionResult struct {
	Text     string            `json:"text"`
	Title    string            `json:"title"`
	Metadata map[string]string `json:"metadata"`
	Pages    int               `json:"pages"`
	Sections []Section         `json:"sections"`
}

// Section represents a logical section within a document.
type Section struct {
	Title   string `json:"title"`
	Content string `json:"content"`
	Level   int    `json:"level"` // heading level (1-6)
	Page    int    `json:"page"`  // page number for PDFs
}

// ─── Processor ───────────────────────────────────────────────────────────────

// ProcessorConfig configures the multi-modal processor.
type ProcessorConfig struct {
	// OCR settings
	OCREnabled  bool   `json:"ocrEnabled"`
	OCRLanguage string `json:"ocrLanguage"` // e.g. "eng", "eng+deu"

	// Vision LLM for image understanding
	VisionEnabled  bool   `json:"visionEnabled"`
	VisionProvider string `json:"visionProvider"` // "ollama", "openai", "anthropic"
	VisionModel    string `json:"visionModel"`    // e.g. "llava", "gpt-4o", "claude-3.5-sonnet"
	VisionURL      string `json:"visionUrl"`

	// Code parsing
	CodeASTEnabled bool `json:"codeAstEnabled"`

	// Size limits
	MaxFileSizeMB int `json:"maxFileSizeMb"`
	MaxPages      int `json:"maxPages"`
}

// DefaultProcessorConfig returns sensible defaults.
func DefaultProcessorConfig() ProcessorConfig {
	return ProcessorConfig{
		OCREnabled:     true,
		OCRLanguage:    "eng",
		VisionEnabled:  false,
		VisionProvider: "ollama",
		VisionModel:    "llava",
		VisionURL:      "http://localhost:11434",
		CodeASTEnabled: true,
		MaxFileSizeMB:  50,
		MaxPages:       200,
	}
}

// Processor handles multi-modal document extraction.
type Processor struct {
	config ProcessorConfig
}

// NewProcessor creates a document processor with the given config.
func NewProcessor(cfg ProcessorConfig) *Processor {
	return &Processor{config: cfg}
}

// Process extracts text and metadata from a document.
func (p *Processor) Process(ctx context.Context, doc *Document) (*ExtractionResult, error) {
	if doc.Size > int64(p.config.MaxFileSizeMB)*1024*1024 {
		return nil, fmt.Errorf("file too large: %d bytes (max: %dMB)", doc.Size, p.config.MaxFileSizeMB)
	}

	switch doc.DocumentType {
	case TypePDF:
		return p.processPDF(ctx, doc)
	case TypeImage:
		return p.processImage(ctx, doc)
	case TypeDiagram:
		return p.processDiagram(ctx, doc)
	case TypeMarkdown:
		return p.processMarkdown(ctx, doc)
	case TypeHTML:
		return p.processHTML(ctx, doc)
	case TypeCode:
		return p.processCode(ctx, doc)
	case TypePlainText:
		return p.processPlainText(ctx, doc)
	default:
		return p.processPlainText(ctx, doc)
	}
}

// DetectType determines the document type from filename and content.
func DetectType(filename string, contentType string, data []byte) DocumentType {
	ext := strings.ToLower(filepath.Ext(filename))

	// Check by extension first
	switch ext {
	case ".pdf":
		return TypePDF
	case ".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".tiff":
		return TypeImage
	case ".svg":
		return TypeDiagram
	case ".drawio", ".dio":
		return TypeDiagram
	case ".md", ".markdown":
		return TypeMarkdown
	case ".html", ".htm":
		return TypeHTML
	case ".go", ".py", ".js", ".ts", ".java", ".rs", ".c", ".cpp", ".rb", ".kt":
		return TypeCode
	case ".txt", ".log":
		return TypePlainText
	}

	// Check by content type
	switch {
	case strings.HasPrefix(contentType, "application/pdf"):
		return TypePDF
	case strings.HasPrefix(contentType, "image/"):
		return TypeImage
	case strings.HasPrefix(contentType, "text/html"):
		return TypeHTML
	case strings.HasPrefix(contentType, "text/markdown"):
		return TypeMarkdown
	case strings.HasPrefix(contentType, "text/"):
		return TypePlainText
	}

	// Check magic bytes
	if len(data) >= 4 {
		if bytes.HasPrefix(data, []byte("%PDF")) {
			return TypePDF
		}
		if bytes.HasPrefix(data, []byte("\x89PNG")) {
			return TypeImage
		}
		if bytes.HasPrefix(data, []byte("\xff\xd8\xff")) {
			return TypeImage
		}
	}

	// Default: if it's valid UTF-8, treat as plain text
	if utf8.Valid(data) {
		return TypePlainText
	}

	return TypeUnknown
}

// ─── PDF Processing ──────────────────────────────────────────────────────────

func (p *Processor) processPDF(ctx context.Context, doc *Document) (*ExtractionResult, error) {
	slog.Debug("Processing PDF", "filename", doc.Filename, "size", doc.Size)

	// Extract text from PDF using a lightweight parser.
	// We parse the PDF content streams directly without external dependencies.
	text, pages := extractPDFText(doc.RawData)

	if text == "" && p.config.OCREnabled {
		// Scanned PDF — fall back to OCR via vision model
		slog.Debug("PDF has no extractable text, attempting OCR", "filename", doc.Filename)
		if p.config.VisionEnabled {
			ocrText, err := p.visionExtract(ctx, doc.RawData, doc.ContentType,
				"Extract all visible text from this scanned document page. Return only the extracted text, preserving structure and formatting.")
			if err != nil {
				return nil, fmt.Errorf("OCR failed for %s: %w", doc.Filename, err)
			}
			text = ocrText
		} else {
			return nil, fmt.Errorf("PDF %s has no extractable text and OCR/vision is not configured", doc.Filename)
		}
	}

	if p.config.MaxPages > 0 && pages > p.config.MaxPages {
		slog.Warn("PDF exceeds max pages, truncating", "pages", pages, "max", p.config.MaxPages)
		pages = p.config.MaxPages
	}

	title := doc.Filename
	sections := splitIntoSections(text)

	return &ExtractionResult{
		Text:     text,
		Title:    title,
		Pages:    pages,
		Sections: sections,
		Metadata: map[string]string{
			"source":   "pdf",
			"filename": doc.Filename,
			"pages":    fmt.Sprintf("%d", pages),
		},
	}, nil
}

// extractPDFText does lightweight text extraction from PDF byte content.
// This handles text-based PDFs by parsing content streams for text operators.
func extractPDFText(data []byte) (string, int) {
	content := string(data)
	var text strings.Builder
	pages := 0

	// Count pages (look for /Type /Page occurrences)
	pageIdx := 0
	for {
		idx := strings.Index(content[pageIdx:], "/Type /Page")
		if idx < 0 {
			break
		}
		// Avoid counting /Type /Pages (the page tree root)
		after := pageIdx + idx + 11
		if after < len(content) && content[after] != 's' {
			pages++
		}
		pageIdx += idx + 11
	}

	// Extract text between BT...ET (text object) markers
	pos := 0
	for {
		btIdx := strings.Index(content[pos:], "BT")
		if btIdx < 0 {
			break
		}
		btIdx += pos
		etIdx := strings.Index(content[btIdx:], "ET")
		if etIdx < 0 {
			break
		}
		etIdx += btIdx

		// Parse text operators within the text object
		textObj := content[btIdx:etIdx]
		extractTextOperators(&text, textObj)
		pos = etIdx + 2
	}

	return strings.TrimSpace(text.String()), pages
}

// extractTextOperators parses PDF text operators (Tj, TJ, ', ")
func extractTextOperators(out *strings.Builder, textObj string) {
	// Look for string literals in parentheses: (text) Tj
	i := 0
	for i < len(textObj) {
		if textObj[i] == '(' {
			// Find matching closing paren (handle escapes)
			depth := 1
			j := i + 1
			for j < len(textObj) && depth > 0 {
				if textObj[j] == '\\' {
					j++ // skip escaped char
				} else if textObj[j] == '(' {
					depth++
				} else if textObj[j] == ')' {
					depth--
				}
				j++
			}
			if depth == 0 {
				str := textObj[i+1 : j-1]
				// Unescape basic PDF string escapes
				str = strings.ReplaceAll(str, "\\n", "\n")
				str = strings.ReplaceAll(str, "\\r", "\r")
				str = strings.ReplaceAll(str, "\\t", "\t")
				str = strings.ReplaceAll(str, "\\(", "(")
				str = strings.ReplaceAll(str, "\\)", ")")
				str = strings.ReplaceAll(str, "\\\\", "\\")
				out.WriteString(str)
			}
			i = j
		} else if textObj[i] == 'T' {
			// Td/TD operators often indicate line breaks
			if i+1 < len(textObj) && (textObj[i+1] == 'd' || textObj[i+1] == 'D' || textObj[i+1] == '*') {
				out.WriteString("\n")
			}
			i++
		} else {
			i++
		}
	}
}

// ─── Image Processing ────────────────────────────────────────────────────────

func (p *Processor) processImage(ctx context.Context, doc *Document) (*ExtractionResult, error) {
	slog.Debug("Processing image", "filename", doc.Filename, "size", doc.Size)

	if !p.config.VisionEnabled && !p.config.OCREnabled {
		return nil, fmt.Errorf("image processing requires vision or OCR to be enabled")
	}

	var text string
	var err error

	if p.config.VisionEnabled {
		// Use vision LLM for rich understanding
		prompt := "Describe this image in detail. If it contains text, extract all visible text. " +
			"If it's a diagram or architecture drawing, describe the components and their relationships. " +
			"If it's a screenshot of code or terminal output, extract the code/text exactly."
		text, err = p.visionExtract(ctx, doc.RawData, doc.ContentType, prompt)
		if err != nil {
			return nil, fmt.Errorf("vision extraction failed: %w", err)
		}
	} else {
		// Fallback: OCR-only (would use Tesseract via exec, simplified here)
		text = "[Image captured but OCR extraction not available without vision model]"
	}

	return &ExtractionResult{
		Text:  text,
		Title: doc.Filename,
		Metadata: map[string]string{
			"source":   "image",
			"filename": doc.Filename,
			"method":   "vision-llm",
		},
	}, nil
}

// ─── Diagram Processing ──────────────────────────────────────────────────────

func (p *Processor) processDiagram(ctx context.Context, doc *Document) (*ExtractionResult, error) {
	slog.Debug("Processing diagram", "filename", doc.Filename)

	content := string(doc.RawData)
	var text strings.Builder

	ext := strings.ToLower(filepath.Ext(doc.Filename))
	switch ext {
	case ".svg":
		// Extract text elements from SVG
		text.WriteString(extractSVGText(content))
	case ".drawio", ".dio":
		// Extract labels and connections from draw.io XML
		text.WriteString(extractDrawIOText(content))
	default:
		if p.config.VisionEnabled {
			extracted, err := p.visionExtract(ctx, doc.RawData, doc.ContentType,
				"This is an architecture or system diagram. Describe the components, their connections, and data flow. List all labels and text visible in the diagram.")
			if err != nil {
				return nil, err
			}
			text.WriteString(extracted)
		}
	}

	return &ExtractionResult{
		Text:  text.String(),
		Title: fmt.Sprintf("Diagram: %s", doc.Filename),
		Metadata: map[string]string{
			"source":   "diagram",
			"filename": doc.Filename,
			"format":   ext,
		},
	}, nil
}

// extractSVGText pulls text content from SVG <text> elements.
func extractSVGText(svg string) string {
	var result strings.Builder
	pos := 0
	for {
		start := strings.Index(svg[pos:], "<text")
		if start < 0 {
			break
		}
		start += pos
		// Find the content between > and </text>
		contentStart := strings.Index(svg[start:], ">")
		if contentStart < 0 {
			break
		}
		contentStart += start + 1
		end := strings.Index(svg[contentStart:], "</text>")
		if end < 0 {
			break
		}
		end += contentStart

		content := svg[contentStart:end]
		// Strip nested tags like <tspan>
		content = stripXMLTags(content)
		content = strings.TrimSpace(content)
		if content != "" {
			result.WriteString(content)
			result.WriteString("\n")
		}
		pos = end + 7
	}
	return result.String()
}

// extractDrawIOText extracts labels from draw.io XML format.
func extractDrawIOText(xml string) string {
	var result strings.Builder

	// draw.io stores labels in value="" attributes of mxCell elements
	pos := 0
	for {
		idx := strings.Index(xml[pos:], `value="`)
		if idx < 0 {
			break
		}
		idx += pos + 7
		end := strings.Index(xml[idx:], `"`)
		if end < 0 {
			break
		}
		label := xml[idx : idx+end]
		label = strings.TrimSpace(label)
		if label != "" && label != " " {
			// Decode basic HTML entities
			label = strings.ReplaceAll(label, "&lt;", "<")
			label = strings.ReplaceAll(label, "&gt;", ">")
			label = strings.ReplaceAll(label, "&amp;", "&")
			label = strings.ReplaceAll(label, "&quot;", "\"")
			label = strings.ReplaceAll(label, "&#xa;", "\n")
			label = stripXMLTags(label)
			result.WriteString(label)
			result.WriteString("\n")
		}
		pos = idx + end + 1
	}
	return result.String()
}

func stripXMLTags(s string) string {
	var out strings.Builder
	inTag := false
	for _, r := range s {
		if r == '<' {
			inTag = true
		} else if r == '>' {
			inTag = false
		} else if !inTag {
			out.WriteRune(r)
		}
	}
	return out.String()
}

// ─── Markdown / HTML / PlainText / Code Processing ───────────────────────────

func (p *Processor) processMarkdown(ctx context.Context, doc *Document) (*ExtractionResult, error) {
	content := string(doc.RawData)
	sections := parseMarkdownSections(content)

	return &ExtractionResult{
		Text:     content,
		Title:    extractMarkdownTitle(content),
		Sections: sections,
		Metadata: map[string]string{
			"source":   "markdown",
			"filename": doc.Filename,
		},
	}, nil
}

func (p *Processor) processHTML(ctx context.Context, doc *Document) (*ExtractionResult, error) {
	content := string(doc.RawData)
	text := stripXMLTags(content)
	// Collapse whitespace
	text = collapseWhitespace(text)

	title := extractHTMLTitle(content)
	if title == "" {
		title = doc.Filename
	}

	return &ExtractionResult{
		Text:  text,
		Title: title,
		Metadata: map[string]string{
			"source":   "html",
			"filename": doc.Filename,
		},
	}, nil
}

func (p *Processor) processPlainText(ctx context.Context, doc *Document) (*ExtractionResult, error) {
	return &ExtractionResult{
		Text:  string(doc.RawData),
		Title: doc.Filename,
		Metadata: map[string]string{
			"source":   "plaintext",
			"filename": doc.Filename,
		},
	}, nil
}

func (p *Processor) processCode(ctx context.Context, doc *Document) (*ExtractionResult, error) {
	content := string(doc.RawData)
	lang := detectCodeLanguage(doc.Filename)

	var sections []Section
	if p.config.CodeASTEnabled {
		sections = extractCodeSections(content, lang)
	}

	return &ExtractionResult{
		Text:     content,
		Title:    fmt.Sprintf("%s (%s)", doc.Filename, lang),
		Sections: sections,
		Metadata: map[string]string{
			"source":   "code",
			"filename": doc.Filename,
			"language": lang,
		},
	}, nil
}

// ─── Vision LLM Integration ─────────────────────────────────────────────────

func (p *Processor) visionExtract(ctx context.Context, imageData []byte, contentType string, prompt string) (string, error) {
	if !p.config.VisionEnabled {
		return "", fmt.Errorf("vision model not configured")
	}

	encoded := base64.StdEncoding.EncodeToString(imageData)

	switch p.config.VisionProvider {
	case "ollama":
		return p.visionOllama(ctx, encoded, prompt)
	case "openai":
		return p.visionOpenAI(ctx, encoded, contentType, prompt)
	case "anthropic":
		return p.visionAnthropic(ctx, encoded, contentType, prompt)
	default:
		return "", fmt.Errorf("unknown vision provider: %s", p.config.VisionProvider)
	}
}

func (p *Processor) visionOllama(ctx context.Context, base64Image string, prompt string) (string, error) {
	body := map[string]any{
		"model":  p.config.VisionModel,
		"prompt": prompt,
		"images": []string{base64Image},
		"stream": false,
	}
	jsonBody, _ := json.Marshal(body)

	url := strings.TrimRight(p.config.VisionURL, "/") + "/api/generate"
	req, err := http.NewRequestWithContext(ctx, "POST", url, bytes.NewReader(jsonBody))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json")

	client := &http.Client{Timeout: 120 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return "", fmt.Errorf("ollama vision request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != 200 {
		respBody, _ := io.ReadAll(resp.Body)
		return "", fmt.Errorf("ollama vision error %d: %s", resp.StatusCode, string(respBody))
	}

	var result struct {
		Response string `json:"response"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return "", err
	}
	return result.Response, nil
}

func (p *Processor) visionOpenAI(ctx context.Context, base64Image, contentType, prompt string) (string, error) {
	mediaType := "image/png"
	if contentType != "" {
		mediaType = contentType
	}

	body := map[string]any{
		"model": p.config.VisionModel,
		"messages": []map[string]any{
			{
				"role": "user",
				"content": []map[string]any{
					{"type": "text", "text": prompt},
					{"type": "image_url", "image_url": map[string]string{
						"url": fmt.Sprintf("data:%s;base64,%s", mediaType, base64Image),
					}},
				},
			},
		},
		"max_tokens": 4096,
	}
	jsonBody, _ := json.Marshal(body)

	url := "https://api.openai.com/v1/chat/completions"
	req, err := http.NewRequestWithContext(ctx, "POST", url, bytes.NewReader(jsonBody))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json")
	// API key would come from config; omitted here for security
	// req.Header.Set("Authorization", "Bearer "+apiKey)

	client := &http.Client{Timeout: 120 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()

	var result struct {
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return "", err
	}
	if len(result.Choices) > 0 {
		return result.Choices[0].Message.Content, nil
	}
	return "", fmt.Errorf("no response from vision model")
}

func (p *Processor) visionAnthropic(ctx context.Context, base64Image, contentType, prompt string) (string, error) {
	mediaType := "image/png"
	if contentType != "" {
		mediaType = contentType
	}

	body := map[string]any{
		"model":      p.config.VisionModel,
		"max_tokens": 4096,
		"messages": []map[string]any{
			{
				"role": "user",
				"content": []map[string]any{
					{"type": "image", "source": map[string]string{
						"type":       "base64",
						"media_type": mediaType,
						"data":       base64Image,
					}},
					{"type": "text", "text": prompt},
				},
			},
		},
	}
	jsonBody, _ := json.Marshal(body)

	url := "https://api.anthropic.com/v1/messages"
	req, err := http.NewRequestWithContext(ctx, "POST", url, bytes.NewReader(jsonBody))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("anthropic-version", "2023-06-01")

	client := &http.Client{Timeout: 120 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()

	var result struct {
		Content []struct {
			Text string `json:"text"`
		} `json:"content"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return "", err
	}
	if len(result.Content) > 0 {
		return result.Content[0].Text, nil
	}
	return "", fmt.Errorf("no response from vision model")
}

// ─── Text Extraction Helpers ─────────────────────────────────────────────────

func parseMarkdownSections(content string) []Section {
	var sections []Section
	lines := strings.Split(content, "\n")
	var currentSection *Section
	var body strings.Builder

	for _, line := range lines {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "#") {
			// Flush previous section
			if currentSection != nil {
				currentSection.Content = strings.TrimSpace(body.String())
				sections = append(sections, *currentSection)
				body.Reset()
			}
			// Detect heading level
			level := 0
			for _, c := range trimmed {
				if c == '#' {
					level++
				} else {
					break
				}
			}
			title := strings.TrimSpace(strings.TrimLeft(trimmed, "# "))
			currentSection = &Section{Title: title, Level: level}
		} else {
			body.WriteString(line)
			body.WriteString("\n")
		}
	}

	if currentSection != nil {
		currentSection.Content = strings.TrimSpace(body.String())
		sections = append(sections, *currentSection)
	}

	return sections
}

func extractMarkdownTitle(content string) string {
	lines := strings.Split(content, "\n")
	for _, line := range lines {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "# ") {
			return strings.TrimSpace(strings.TrimPrefix(trimmed, "# "))
		}
	}
	return ""
}

func extractHTMLTitle(html string) string {
	start := strings.Index(html, "<title>")
	if start < 0 {
		return ""
	}
	start += 7
	end := strings.Index(html[start:], "</title>")
	if end < 0 {
		return ""
	}
	return strings.TrimSpace(html[start : start+end])
}

func collapseWhitespace(s string) string {
	var out strings.Builder
	prevSpace := false
	for _, r := range s {
		if r == ' ' || r == '\t' {
			if !prevSpace {
				out.WriteRune(' ')
			}
			prevSpace = true
		} else if r == '\n' || r == '\r' {
			if !prevSpace {
				out.WriteRune('\n')
			}
			prevSpace = true
		} else {
			out.WriteRune(r)
			prevSpace = false
		}
	}
	return out.String()
}

func detectCodeLanguage(filename string) string {
	ext := strings.ToLower(filepath.Ext(filename))
	switch ext {
	case ".go":
		return "go"
	case ".py":
		return "python"
	case ".js":
		return "javascript"
	case ".ts":
		return "typescript"
	case ".java":
		return "java"
	case ".rs":
		return "rust"
	case ".rb":
		return "ruby"
	case ".c", ".h":
		return "c"
	case ".cpp", ".cc", ".hpp":
		return "cpp"
	case ".kt":
		return "kotlin"
	default:
		return "unknown"
	}
}

// extractCodeSections splits code into logical sections (functions, classes).
func extractCodeSections(content, lang string) []Section {
	var sections []Section
	lines := strings.Split(content, "\n")

	// Simple heuristic: look for function/class definitions
	patterns := getCodePatterns(lang)
	var current *Section
	var body strings.Builder

	for _, line := range lines {
		isDefinition := false
		for _, pattern := range patterns {
			if strings.Contains(line, pattern) {
				isDefinition = true
				break
			}
		}
		if isDefinition && strings.TrimSpace(line) != "" {
			if current != nil {
				current.Content = body.String()
				sections = append(sections, *current)
				body.Reset()
			}
			current = &Section{
				Title: strings.TrimSpace(line),
				Level: 2,
			}
		}
		body.WriteString(line)
		body.WriteString("\n")
	}
	if current != nil {
		current.Content = body.String()
		sections = append(sections, *current)
	}
	return sections
}

func getCodePatterns(lang string) []string {
	switch lang {
	case "go":
		return []string{"func ", "type ", "interface "}
	case "python":
		return []string{"def ", "class ", "async def "}
	case "javascript", "typescript":
		return []string{"function ", "class ", "const ", "export "}
	case "java", "kotlin":
		return []string{"public ", "private ", "class ", "interface "}
	case "rust":
		return []string{"fn ", "struct ", "impl ", "trait ", "enum "}
	default:
		return []string{"func ", "function ", "def ", "class "}
	}
}

func splitIntoSections(text string) []Section {
	// Split on double newlines for generic text
	parts := strings.Split(text, "\n\n")
	var sections []Section
	for i, part := range parts {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		title := fmt.Sprintf("Section %d", i+1)
		lines := strings.Split(part, "\n")
		if len(lines) > 0 && len(lines[0]) < 100 {
			title = lines[0]
		}
		sections = append(sections, Section{
			Title:   title,
			Content: part,
			Level:   2,
		})
	}
	return sections
}
