"""Core HTTP client for the Synapse API."""

from __future__ import annotations

import json
import os
from typing import Any, Dict, List, Optional
from urllib.error import HTTPError
from urllib.request import Request, urlopen


class SynapseClient:
    """Synchronous Synapse API client.

    Usage:
        client = SynapseClient(base_url="http://localhost:3000", token="sk_synapse_...")
        results = client.search("How does caching work?")
        client.capture(messages=[...], repository="org/repo")
    """

    def __init__(
        self,
        base_url: Optional[str] = None,
        token: Optional[str] = None,
        organization_id: str = "default",
        timeout: int = 30,
    ):
        self.base_url = (base_url or os.environ.get("SYNAPSE_URL", "http://localhost:3000")).rstrip("/")
        self.token = token or os.environ.get("SYNAPSE_TOKEN", "")
        self.organization_id = organization_id
        self.timeout = timeout

    def _headers(self) -> Dict[str, str]:
        h = {"Content-Type": "application/json"}
        if self.token:
            h["Authorization"] = f"Bearer {self.token}"
        return h

    def _request(self, method: str, path: str, body: Optional[Dict] = None) -> Dict[str, Any]:
        url = f"{self.base_url}{path}"
        data = json.dumps(body).encode() if body else None
        req = Request(url, data=data, headers=self._headers(), method=method)
        try:
            with urlopen(req, timeout=self.timeout) as resp:
                return json.loads(resp.read())
        except HTTPError as e:
            error_body = e.read().decode() if e.fp else ""
            raise SynapseAPIError(e.code, error_body) from e

    def health(self) -> Dict[str, Any]:
        """Check API health."""
        return self._request("GET", "/health/ready")

    def search(
        self,
        query: str,
        top_k: int = 5,
        max_tokens: int = 3000,
        repository: Optional[str] = None,
        include_content: bool = True,
    ) -> Dict[str, Any]:
        """Search the knowledge base."""
        body: Dict[str, Any] = {
            "query": query,
            "topK": top_k,
            "maxTokens": max_tokens,
            "includeContent": include_content,
        }
        if repository:
            body["context"] = {"repository": repository}
        return self._request("POST", "/api/v1/search", body)

    def get_context(
        self, query: str, max_tokens: int = 3000, repository: Optional[str] = None
    ) -> Dict[str, Any]:
        """Get token-budget-aware context for AI prompts."""
        body: Dict[str, Any] = {"query": query, "maxTokens": max_tokens}
        if repository:
            body["context"] = {"repository": repository}
        return self._request("POST", "/api/v1/context", body)

    def capture(
        self,
        messages: List[Dict[str, str]],
        source: str = "sdk-python",
        repository: str = "",
        language: str = "",
    ) -> Dict[str, Any]:
        """Capture a conversation session."""
        return self._request("POST", "/api/v1/capture/passive", {
            "messages": messages,
            "source": source,
            "repository": repository,
            "language": language,
        })

    def get_facts(
        self, entities: Optional[List[str]] = None, types: Optional[List[str]] = None, limit: int = 10
    ) -> Dict[str, Any]:
        """Query atomic facts."""
        params = []
        if entities:
            params.append(f"entities={','.join(entities)}")
        if types:
            params.append(f"types={','.join(types)}")
        params.append(f"limit={limit}")
        return self._request("GET", f"/api/v1/facts?{'&'.join(params)}")

    def create_fact(
        self, content: str, fact_type: str, entities: List[str], confidence: float = 0.9
    ) -> Dict[str, Any]:
        """Create a new atomic fact."""
        return self._request("POST", "/api/v1/facts", {
            "content": content,
            "type": fact_type,
            "entities": entities,
            "confidence": confidence,
        })

    def reflect(self, query: str, write_back: bool = False) -> Dict[str, Any]:
        """Reason over stored knowledge using LLM."""
        return self._request("POST", "/api/v1/reflect", {
            "query": query,
            "writeBack": write_back,
        })

    def feedback(self, result_id: str, score: int, query: str = "") -> Dict[str, Any]:
        """Submit feedback on a search result."""
        return self._request("POST", "/api/v1/feedback", {
            "resultId": result_id,
            "score": score,
            "query": query,
        })


class SynapseAPIError(Exception):
    """Raised when the API returns an error status."""

    def __init__(self, status_code: int, body: str):
        self.status_code = status_code
        self.body = body
        super().__init__(f"Synapse API {status_code}: {body[:200]}")
