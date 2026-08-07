package api

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"time"

	"github.com/google/uuid"

	"github.com/mihaibalaci/synapse/internal/auth"
	"github.com/mihaibalaci/synapse/internal/multimodal"
)

// MaxUploadSize is the maximum allowed upload size (50MB).
const MaxUploadSize = 50 << 20

// CaptureDocumentHandler handles multi-modal document uploads.
// POST /api/v1/capture/document
//
// Accepts multipart/form-data with:
//   - file: the document file (PDF, image, diagram, code, text)
//   - repository: (optional) associated repository
//   - language: (optional) programming language hint
//   - source: (optional) capture source identifier
//
// Or application/json with base64-encoded content:
//
//	{
//	  "filename": "architecture.pdf",
//	  "content": "<base64-encoded>",
//	  "contentType": "application/pdf",
//	  "repository": "my-service",
//	  "source": "manual-upload"
//	}
func CaptureDocumentHandler(app *App) http.HandlerFunc {
	processor := multimodal.NewProcessor(multimodal.DefaultProcessorConfig())

	return func(w http.ResponseWriter, r *http.Request) {
		claims := auth.GetClaims(r)
		if claims == nil {
			http.Error(w, `{"error":"AUTH_ERROR"}`, http.StatusUnauthorized)
			return
		}

		var doc *multimodal.Document
		var repository, source string

		contentType := r.Header.Get("Content-Type")

		if isMultipart(contentType) {
			// Multipart form upload
			r.Body = http.MaxBytesReader(w, r.Body, MaxUploadSize)
			if err := r.ParseMultipartForm(MaxUploadSize); err != nil {
				http.Error(w, `{"error":"FILE_TOO_LARGE","message":"Maximum upload size is 50MB"}`, http.StatusRequestEntityTooLarge)
				return
			}

			file, header, err := r.FormFile("file")
			if err != nil {
				http.Error(w, `{"error":"VALIDATION_ERROR","message":"No file provided"}`, http.StatusBadRequest)
				return
			}
			defer file.Close()

			data, err := io.ReadAll(io.LimitReader(file, MaxUploadSize))
			if err != nil {
				http.Error(w, `{"error":"READ_ERROR"}`, http.StatusInternalServerError)
				return
			}

			repository = r.FormValue("repository")
			source = r.FormValue("source")
			if source == "" {
				source = "document-upload"
			}

			docType := multimodal.DetectType(header.Filename, header.Header.Get("Content-Type"), data)
			doc = &multimodal.Document{
				ID:           uuid.New().String(),
				Filename:     header.Filename,
				ContentType:  header.Header.Get("Content-Type"),
				DocumentType: docType,
				Size:         int64(len(data)),
				RawData:      data,
			}
		} else {
			// JSON upload with base64 content
			var req struct {
				Filename    string `json:"filename"`
				Content     string `json:"content"` // base64
				ContentType string `json:"contentType"`
				Repository  string `json:"repository"`
				Source      string `json:"source"`
			}
			if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
				http.Error(w, `{"error":"VALIDATION_ERROR","message":"Invalid JSON"}`, http.StatusBadRequest)
				return
			}

			if req.Filename == "" || req.Content == "" {
				http.Error(w, `{"error":"VALIDATION_ERROR","message":"filename and content required"}`, http.StatusBadRequest)
				return
			}

			data, err := decodeBase64(req.Content)
			if err != nil {
				http.Error(w, `{"error":"VALIDATION_ERROR","message":"Invalid base64 content"}`, http.StatusBadRequest)
				return
			}

			repository = req.Repository
			source = req.Source
			if source == "" {
				source = "document-upload"
			}

			docType := multimodal.DetectType(req.Filename, req.ContentType, data)
			doc = &multimodal.Document{
				ID:           uuid.New().String(),
				Filename:     req.Filename,
				ContentType:  req.ContentType,
				DocumentType: docType,
				Size:         int64(len(data)),
				RawData:      data,
			}
		}

		// Process the document
		slog.Info("Processing document",
			"id", doc.ID,
			"filename", doc.Filename,
			"type", doc.DocumentType,
			"size", doc.Size,
		)

		result, err := processor.Process(r.Context(), doc)
		if err != nil {
			slog.Warn("Document processing failed",
				"filename", doc.Filename,
				"error", err,
			)
			http.Error(w, fmt.Sprintf(`{"error":"PROCESSING_ERROR","message":"%s"}`, err.Error()), http.StatusUnprocessableEntity)
			return
		}

		// Store the raw document in object storage
		storageKey := fmt.Sprintf("documents/%s/%s", claims.OrganizationID, doc.ID)
		if err := app.Objects.Put(r.Context(), storageKey, doc.RawData, doc.ContentType); err != nil {
			slog.Warn("Failed to store document", "error", err)
			// Non-fatal: continue with text extraction
		}

		// Convert to messages and feed into the standard capture pipeline
		messages := documentToMessages(doc, result)

		// Create a session for this document
		sessionID := uuid.New().String()
		totalTokens := len(result.Text) / 4

		metadata, _ := json.Marshal(map[string]string{
			"source":       source,
			"repository":   repository,
			"filename":     doc.Filename,
			"documentType": string(doc.DocumentType),
			"documentId":   doc.ID,
		})

		// Store raw in object storage
		rawKey := fmt.Sprintf("sessions/%s/%s.json", claims.OrganizationID, sessionID)
		rawData, _ := json.Marshal(map[string]any{
			"messages": messages,
			"document": map[string]string{
				"id":       doc.ID,
				"filename": doc.Filename,
				"type":     string(doc.DocumentType),
			},
		})
		_ = app.Objects.Put(r.Context(), rawKey, rawData, "application/json")

		// Insert session record
		now := time.Now()
		err = app.DB.Exec(r.Context(), `
			INSERT INTO sessions (id, client_id, developer_id, organization_id,
				status, searchable_status, raw_storage_key,
				total_tokens, message_count, metadata, started_at, ended_at)
			VALUES ($1, $2, $3, $4, 'processing', 'pending', $5, $6, $7, $8, $9, $9)`,
			sessionID, "document-"+doc.ID, claims.UserID, claims.OrganizationID,
			rawKey, totalTokens, len(messages), metadata, now,
		)
		if err != nil {
			slog.Warn("Failed to create session for document", "error", err)
			http.Error(w, `{"error":"STORAGE_ERROR"}`, http.StatusInternalServerError)
			return
		}

		// Enqueue for standard ingestion
		job, _ := json.Marshal(map[string]string{
			"session_id":      sessionID,
			"organization_id": claims.OrganizationID,
		})
		_ = app.Cache.Enqueue(r.Context(), "synapse:session", job)

		// Respond
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusAccepted)
		json.NewEncoder(w).Encode(map[string]any{
			"documentId":   doc.ID,
			"sessionId":    sessionID,
			"filename":     doc.Filename,
			"documentType": doc.DocumentType,
			"extractedText": truncateForResponse(result.Text, 500),
			"sections":     len(result.Sections),
			"pages":        result.Pages,
			"tokens":       totalTokens,
			"status":       "processing",
		})
	}
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

func documentToMessages(doc *multimodal.Document, result *multimodal.ExtractionResult) []map[string]string {
	var messages []map[string]string

	// System message describing the document
	messages = append(messages, map[string]string{
		"role":    "system",
		"content": fmt.Sprintf("Document captured: %s (type: %s, %d pages)", doc.Filename, doc.DocumentType, result.Pages),
	})

	// If we have sections, create a message per section for better chunking
	if len(result.Sections) > 0 {
		for _, section := range result.Sections {
			content := section.Content
			if section.Title != "" {
				content = section.Title + "\n\n" + content
			}
			messages = append(messages, map[string]string{
				"role":    "assistant",
				"content": content,
			})
		}
	} else {
		// Single message with all extracted text
		messages = append(messages, map[string]string{
			"role":    "assistant",
			"content": result.Text,
		})
	}

	return messages
}

func isMultipart(contentType string) bool {
	return len(contentType) > 19 && contentType[:19] == "multipart/form-data"
}

func decodeBase64(s string) ([]byte, error) {
	// Try standard encoding first, then URL encoding
	data, err := base64.StdEncoding.DecodeString(s)
	if err != nil {
		data, err = base64.URLEncoding.DecodeString(s)
	}
	return data, err
}

func truncateForResponse(s string, maxLen int) string {
	if len(s) <= maxLen {
		return s
	}
	return s[:maxLen] + "..."
}
