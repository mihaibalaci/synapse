/**
 * API Client — shared HTTP client for all CLI commands.
 */

const BASE_URL = process.env.RECALL_API_URL ?? 'http://localhost:3000';
const TOKEN = process.env.RECALL_TOKEN ?? '';
const DEVELOPER_ID = process.env.DEVELOPER_ID ?? process.env.USER ?? 'unknown';
const ORGANIZATION_ID = process.env.ORGANIZATION_ID ?? 'default';

export function getIdentity() {
  return { developerId: DEVELOPER_ID, organizationId: ORGANIZATION_ID };
}

export async function api(path: string, method: string = 'GET', body?: unknown): Promise<any> {
  const url = `${BASE_URL}${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(TOKEN ? { 'Authorization': `Bearer ${TOKEN}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${method} ${path} → ${res.status}: ${text}`);
  }

  return res.json();
}
