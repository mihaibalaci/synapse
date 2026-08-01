package api

import (
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/mihaibalaci/synapse/internal/auth"
)

// handleGraphEntity returns an entity's direct neighbors and edge weights.
func handleGraphEntity(w http.ResponseWriter, r *http.Request) {
	claims := auth.GetClaims(r)
	if claims == nil {
		writeError(w, http.StatusUnauthorized, "AUTH_ERROR", "Missing claims")
		return
	}
	entity := chi.URLParam(r, "entity")
	if entity == "" {
		writeError(w, http.StatusBadRequest, "BAD_REQUEST", "entity is required")
		return
	}

	rows, err := appFromRequest(r).DB.Query(r.Context(), `
		SELECT neighbor.name, ge.relation, ge.weight, ge.created_at
		FROM graph_nodes gn
		JOIN graph_edges ge ON ge.source_id = gn.id OR ge.target_id = gn.id
		JOIN graph_nodes neighbor ON neighbor.id = CASE
			WHEN ge.source_id = gn.id THEN ge.target_id ELSE ge.source_id END
		WHERE gn.organization_id = $1 AND gn.name = $2 AND gn.kind = 'entity'
		ORDER BY ge.weight DESC
		LIMIT 50`, claims.OrganizationID, entity)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "QUERY_ERROR", err.Error())
		return
	}
	defer rows.Close()

	type edge struct {
		Neighbor  string  `json:"neighbor"`
		Relation  string  `json:"relation"`
		Weight    float64 `json:"weight"`
		CreatedAt string  `json:"createdAt"`
	}
	var edges []edge
	for rows.Next() {
		var e edge
		var createdAt time.Time
		if err := rows.Scan(&e.Neighbor, &e.Relation, &e.Weight, &createdAt); err != nil {
			continue
		}
		e.CreatedAt = createdAt.Format(time.RFC3339)
		edges = append(edges, e)
	}
	if edges == nil {
		edges = []edge{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"entity": entity, "edges": edges, "count": len(edges)})
}

// handleGraphPath finds the shortest path between two entities (BFS, max 4 hops).
func handleGraphPath(w http.ResponseWriter, r *http.Request) {
	claims := auth.GetClaims(r)
	if claims == nil {
		writeError(w, http.StatusUnauthorized, "AUTH_ERROR", "Missing claims")
		return
	}
	from := r.URL.Query().Get("from")
	to := r.URL.Query().Get("to")
	if from == "" || to == "" {
		writeError(w, http.StatusBadRequest, "BAD_REQUEST", "from and to query params required")
		return
	}

	// Use PostgreSQL recursive CTE for BFS path finding (max 4 hops)
	rows, err := appFromRequest(r).DB.Query(r.Context(), `
		WITH RECURSIVE paths AS (
			SELECT gn.id AS current_id, gn.name AS current_name,
				ARRAY[gn.name] AS path, 1 AS depth
			FROM graph_nodes gn
			WHERE gn.organization_id = $1 AND gn.name = $2 AND gn.kind = 'entity'
			UNION ALL
			SELECT neighbor.id, neighbor.name,
				p.path || neighbor.name, p.depth + 1
			FROM paths p
			JOIN graph_edges ge ON ge.source_id = p.current_id OR ge.target_id = p.current_id
			JOIN graph_nodes neighbor ON neighbor.id = CASE
				WHEN ge.source_id = p.current_id THEN ge.target_id ELSE ge.source_id END
			WHERE p.depth < 4 AND NOT neighbor.name = ANY(p.path)
		)
		SELECT path FROM paths WHERE current_name = $3
		ORDER BY depth ASC LIMIT 5`, claims.OrganizationID, from, to)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "QUERY_ERROR", err.Error())
		return
	}
	defer rows.Close()

	var paths [][]string
	for rows.Next() {
		var path []string
		if err := rows.Scan(&path); err != nil {
			continue
		}
		paths = append(paths, path)
	}
	if paths == nil {
		paths = [][]string{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"from": from, "to": to, "paths": paths, "count": len(paths)})
}

// handleGraphImportant returns top entities by edge weight (importance scoring).
func handleGraphImportant(w http.ResponseWriter, r *http.Request) {
	claims := auth.GetClaims(r)
	if claims == nil {
		writeError(w, http.StatusUnauthorized, "AUTH_ERROR", "Missing claims")
		return
	}
	limit := queryInt(r, "limit", 20)

	rows, err := appFromRequest(r).DB.Query(r.Context(), `
		SELECT gn.name, SUM(ge.weight) AS total_weight, COUNT(*) AS edge_count
		FROM graph_nodes gn
		JOIN graph_edges ge ON ge.source_id = gn.id OR ge.target_id = gn.id
		WHERE gn.organization_id = $1 AND gn.kind = 'entity'
		GROUP BY gn.id, gn.name
		ORDER BY total_weight DESC
		LIMIT $2`, claims.OrganizationID, limit)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "QUERY_ERROR", err.Error())
		return
	}
	defer rows.Close()

	type entityRank struct {
		Name        string  `json:"name"`
		TotalWeight float64 `json:"totalWeight"`
		EdgeCount   int     `json:"edgeCount"`
	}
	var entities []entityRank
	for rows.Next() {
		var e entityRank
		if err := rows.Scan(&e.Name, &e.TotalWeight, &e.EdgeCount); err != nil {
			continue
		}
		entities = append(entities, e)
	}
	if entities == nil {
		entities = []entityRank{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"entities": entities, "count": len(entities)})
}
