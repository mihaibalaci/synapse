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
		SELECT
			CASE WHEN ge.source_node_id = $2 THEN ge.target_node_id ELSE ge.source_node_id END AS neighbor,
			ge.edge_type AS relation,
			ge.weight,
			ge.created_at
		FROM graph_edges ge
		WHERE ge.organization_id = $1
			AND (ge.source_node_id = $2 OR ge.target_node_id = $2)
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

	rows, err := appFromRequest(r).DB.Query(r.Context(), `
		WITH RECURSIVE paths AS (
			SELECT source_node_id AS start_node,
				CASE WHEN source_node_id = $2 THEN target_node_id ELSE source_node_id END AS current_node,
				ARRAY[$2::text,
					CASE WHEN source_node_id = $2 THEN target_node_id ELSE source_node_id END
				] AS path,
				1 AS depth
			FROM graph_edges
			WHERE organization_id = $1
				AND (source_node_id = $2 OR target_node_id = $2)
			UNION ALL
			SELECT p.start_node,
				CASE WHEN ge.source_node_id = p.current_node THEN ge.target_node_id ELSE ge.source_node_id END,
				p.path || CASE WHEN ge.source_node_id = p.current_node THEN ge.target_node_id ELSE ge.source_node_id END,
				p.depth + 1
			FROM paths p
			JOIN graph_edges ge ON ge.organization_id = $1
				AND (ge.source_node_id = p.current_node OR ge.target_node_id = p.current_node)
			WHERE p.depth < 4
				AND NOT (CASE WHEN ge.source_node_id = p.current_node THEN ge.target_node_id ELSE ge.source_node_id END) = ANY(p.path)
		)
		SELECT path FROM paths WHERE current_node = $3
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
		SELECT gn.name, COALESCE(SUM(ge.weight), 0) AS total_weight, COUNT(ge.*) AS edge_count
		FROM graph_nodes gn
		LEFT JOIN graph_edges ge ON ge.organization_id = gn.organization_id
			AND (ge.source_node_id = gn.node_id OR ge.target_node_id = gn.node_id)
		WHERE gn.organization_id = $1
		GROUP BY gn.node_id, gn.name
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
