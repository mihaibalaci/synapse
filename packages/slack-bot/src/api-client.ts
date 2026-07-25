/**
 * Shared API client for the Slack bot.
 */

const BASE_URL = process.env.RECALL_API_URL ?? 'http://localhost:3000';
const TOKEN = process.env.RECALL_TOKEN ?? '';
const ORGANIZATION_ID = process.env.ORGANIZATION_ID ?? 'default';

export function getOrgId() { return ORGANIZATION_ID; }

export async function api(path: string, method: string = 'GET', body?: unknown): Promise<any> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${method} ${path} → ${res.status}: ${text}`);
  }
  return res.json();
}
