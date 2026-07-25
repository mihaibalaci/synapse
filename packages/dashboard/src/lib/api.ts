/**
 * API client for the dashboard — wraps fetch calls to the Context Store API.
 */

const BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3000';

export async function api(path: string, options?: RequestInit): Promise<any> {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options?.headers,
    },
  });
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json();
}

export async function searchKnowledge(query: string, opts?: { repo?: string; lang?: string; limit?: number }) {
  return api('/api/v1/search', {
    method: 'POST',
    body: JSON.stringify({
      query,
      context: { repository: opts?.repo, language: opts?.lang },
      topK: opts?.limit ?? 10,
      strategy: 'hybrid',
      includeContent: true,
      developerId: 'dashboard',
      organizationId: 'default',
    }),
  });
}

export async function getFacts(params?: { entities?: string[]; types?: string[]; limit?: number }) {
  const qs = new URLSearchParams();
  if (params?.entities?.length) qs.set('entities', params.entities.join(','));
  if (params?.types?.length) qs.set('types', params.types.join(','));
  qs.set('limit', String(params?.limit ?? 20));
  return api(`/api/v1/facts?${qs}`);
}

export async function getFactHistory(entity: string) {
  return api(`/api/v1/facts/${encodeURIComponent(entity)}/history`);
}

export async function getHealth() {
  return api('/health/ready');
}

export async function submitFeedback(resultId: string, action: string) {
  return api('/api/v1/feedback', {
    method: 'POST',
    body: JSON.stringify({
      searchId: crypto.randomUUID(),
      resultId,
      developerId: 'dashboard',
      action,
    }),
  });
}
