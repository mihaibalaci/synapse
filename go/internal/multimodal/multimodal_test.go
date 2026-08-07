package multimodal

import (
	"testing"
)

func TestDetectType(t *testing.T) {
	tests := []struct {
		filename    string
		contentType string
		data        []byte
		want        DocumentType
	}{
		{"report.pdf", "", []byte("%PDF-1.4"), TypePDF},
		{"photo.png", "", []byte("\x89PNG\r\n"), TypeImage},
		{"photo.jpg", "image/jpeg", nil, TypeImage},
		{"arch.svg", "", nil, TypeDiagram},
		{"flow.drawio", "", nil, TypeDiagram},
		{"README.md", "", nil, TypeMarkdown},
		{"index.html", "", nil, TypeHTML},
		{"main.go", "", nil, TypeCode},
		{"app.py", "", nil, TypeCode},
		{"utils.ts", "", nil, TypeCode},
		{"server.rs", "", nil, TypeCode},
		{"notes.txt", "", nil, TypePlainText},
		{"unknown.xyz", "text/plain", nil, TypePlainText},
		{"unknown.xyz", "application/pdf", nil, TypePDF},
		{"unknown.xyz", "image/png", nil, TypeImage},
		{"data.bin", "application/octet-stream", []byte{0x00, 0x01, 0x02, 0xFF}, TypeUnknown},
		{"valid.xyz", "", []byte("hello world"), TypePlainText},
	}

	for _, tt := range tests {
		t.Run(tt.filename, func(t *testing.T) {
			got := DetectType(tt.filename, tt.contentType, tt.data)
			if got != tt.want {
				t.Errorf("DetectType(%q, %q) = %q, want %q", tt.filename, tt.contentType, got, tt.want)
			}
		})
	}
}

func TestDetectCodeLanguage(t *testing.T) {
	tests := []struct {
		filename string
		want     string
	}{
		{"main.go", "go"},
		{"app.py", "python"},
		{"index.js", "javascript"},
		{"server.ts", "typescript"},
		{"App.java", "java"},
		{"lib.rs", "rust"},
		{"script.rb", "ruby"},
		{"main.c", "c"},
		{"main.cpp", "cpp"},
		{"Main.kt", "kotlin"},
		{"unknown.xyz", "unknown"},
	}

	for _, tt := range tests {
		t.Run(tt.filename, func(t *testing.T) {
			got := detectCodeLanguage(tt.filename)
			if got != tt.want {
				t.Errorf("detectCodeLanguage(%q) = %q, want %q", tt.filename, got, tt.want)
			}
		})
	}
}

func TestExtractSVGText(t *testing.T) {
	svg := `<svg>
		<text x="10" y="20">Hello World</text>
		<text x="30" y="40"><tspan>Nested</tspan> Text</text>
		<text x="50" y="60"></text>
		<rect width="100" height="100"/>
		<text x="70" y="80">Third Label</text>
	</svg>`

	result := extractSVGText(svg)
	if result == "" {
		t.Fatal("extractSVGText returned empty string")
	}
	if !contains(result, "Hello World") {
		t.Error("missing 'Hello World' in SVG text extraction")
	}
	if !contains(result, "Nested") {
		t.Error("missing 'Nested' in SVG text extraction")
	}
	if !contains(result, "Third Label") {
		t.Error("missing 'Third Label' in SVG text extraction")
	}
}

func TestExtractDrawIOText(t *testing.T) {
	xml := `<mxGraphModel>
		<root>
			<mxCell id="0"/>
			<mxCell id="1" value="API Gateway" vertex="1"/>
			<mxCell id="2" value="Database" vertex="1"/>
			<mxCell id="3" value="" edge="1"/>
			<mxCell id="4" value="Auth Service" vertex="1"/>
		</root>
	</mxGraphModel>`

	result := extractDrawIOText(xml)
	if result == "" {
		t.Fatal("extractDrawIOText returned empty string")
	}
	if !contains(result, "API Gateway") {
		t.Error("missing 'API Gateway' in draw.io text extraction")
	}
	if !contains(result, "Database") {
		t.Error("missing 'Database' in draw.io text extraction")
	}
	if !contains(result, "Auth Service") {
		t.Error("missing 'Auth Service' in draw.io text extraction")
	}
}

func TestParseMarkdownSections(t *testing.T) {
	md := `# Main Title

Introduction paragraph.

## Section One

Content for section one.
More content.

## Section Two

Content for section two.

### Subsection

Nested content.
`
	sections := parseMarkdownSections(md)
	if len(sections) < 3 {
		t.Fatalf("expected at least 3 sections, got %d", len(sections))
	}
	if sections[0].Title != "Main Title" {
		t.Errorf("first section title = %q, want 'Main Title'", sections[0].Title)
	}
	if sections[0].Level != 1 {
		t.Errorf("first section level = %d, want 1", sections[0].Level)
	}
	if sections[1].Title != "Section One" {
		t.Errorf("second section title = %q, want 'Section One'", sections[1].Title)
	}
	if sections[1].Level != 2 {
		t.Errorf("second section level = %d, want 2", sections[1].Level)
	}
}

func TestExtractMarkdownTitle(t *testing.T) {
	tests := []struct {
		content string
		want    string
	}{
		{"# Hello World\n\nBody", "Hello World"},
		{"## Not a title\n\n# Real Title", "Real Title"},
		{"No heading here", ""},
	}

	for _, tt := range tests {
		got := extractMarkdownTitle(tt.content)
		if got != tt.want {
			t.Errorf("extractMarkdownTitle() = %q, want %q", got, tt.want)
		}
	}
}

func TestExtractHTMLTitle(t *testing.T) {
	tests := []struct {
		html string
		want string
	}{
		{"<html><head><title>My Page</title></head></html>", "My Page"},
		{"<html><body>No title</body></html>", ""},
		{"<title>  Spaced  </title>", "Spaced"},
	}

	for _, tt := range tests {
		got := extractHTMLTitle(tt.html)
		if got != tt.want {
			t.Errorf("extractHTMLTitle() = %q, want %q", got, tt.want)
		}
	}
}

func TestStripXMLTags(t *testing.T) {
	tests := []struct {
		input string
		want  string
	}{
		{"<b>bold</b>", "bold"},
		{"<p>hello <em>world</em></p>", "hello world"},
		{"no tags", "no tags"},
		{"<a href='x'>link</a> text", "link text"},
	}

	for _, tt := range tests {
		got := stripXMLTags(tt.input)
		if got != tt.want {
			t.Errorf("stripXMLTags(%q) = %q, want %q", tt.input, got, tt.want)
		}
	}
}

func TestTokenize(t *testing.T) {
	// tokenize is in the storage package; tested there via TextIndex.Search
	// This test verifies the multimodal tokenization indirectly through parseMarkdownSections
	sections := parseMarkdownSections("# Title\n\nContent with words for tokenization testing")
	if len(sections) == 0 {
		t.Error("parseMarkdownSections returned no sections")
	}
}

func TestExtractPDFText(t *testing.T) {
	// Minimal PDF-like content with text operators
	pdfContent := `%PDF-1.4
1 0 obj
<< /Type /Page >>
endobj
BT
(Hello PDF World) Tj
ET
`
	text, pages := extractPDFText([]byte(pdfContent))
	if pages == 0 {
		t.Error("expected at least 1 page")
	}
	if !contains(text, "Hello PDF World") {
		t.Errorf("expected 'Hello PDF World' in extracted text, got: %q", text)
	}
}

func contains(s, substr string) bool {
	return len(s) >= len(substr) && (s == substr || len(s) > 0 && containsStr(s, substr))
}

func containsStr(s, sub string) bool {
	for i := 0; i <= len(s)-len(sub); i++ {
		if s[i:i+len(sub)] == sub {
			return true
		}
	}
	return false
}
