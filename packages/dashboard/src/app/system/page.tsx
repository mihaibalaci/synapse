'use client';

import { useState, useEffect, useCallback } from 'react';
import { getHealth, getStats } from '@/lib/api';

const POLL_INTERVAL = 5000;

// ─── Types ───────────────────────────────────────────────────────────────────

interface HealthData {
  status: string;
  checks: Record<string, string>;
}

interface StatsData {
  organization: string;
  timestamp: string;
  counts: {
    sessions: number;
    chunks: number;
    searchableChunks: number;
    facts: number;
    clusters: number;
    knowledgeRecords: number;
    graphNodes: number;
  };
  processing: {
    activeSessions: number;
    searchable: number;
    blocked: number;
    failed: number;
    byStatus: Record<string, number>;
  };
  queues: {
    sessionProcessing?: number;
    factExtraction?: number;
    knowledgeExtraction?: number;
    deduplication?: number;
    graphIndexing?: number;
    searchIndexing?: number;
    captureProcessing?: number;
    total: number;
  };
  recentActivity: Array<{
    id: string;
    developerId: string;
    searchableStatus: string;
    enrichmentStatus: string;
    totalTokens: number;
    createdAt: string;
    updatedAt: string;
  }>;
}

// ─── Components ──────────────────────────────────────────────────────────────

function StatusDot({ ok }: { ok: boolean }) {
  return (
    <span className={`inline-block w-2.5 h-2.5 rounded-full ${ok ? 'bg-green-500 animate-pulse' : 'bg-red-500'}`} />
  );
}

function MetricCard({ label, value, sub }: { label: string; value: string | number; sub?: string }) {
  return (
    <div className="p-4 bg-white border border-gray-200 rounded-lg">
      <div className="text-2xl font-bold tabular-nums">{typeof value === 'number' ? value.toLocaleString() : value}</div>
      <div className="text-xs text-gray-500 mt-1">{label}</div>
      {sub && <div className="text-xs text-gray-400 mt-0.5">{sub}</div>}
    </div>
  );
}

function QueueBar({ name, depth }: { name: string; depth: number }) {
  const width = Math.min(depth / 50 * 100, 100);
  return (
    <div className="flex items-center gap-3">
      <div className="w-32 text-xs text-gray-600 truncate">{name}</div>
      <div className="flex-1 bg-gray-100 rounded h-3 overflow-hidden">
        <div
          className={`h-full rounded transition-all duration-500 ${depth > 20 ? 'bg-amber-500' : depth > 0 ? 'bg-blue-500' : 'bg-gray-200'}`}
          style={{ width: `${width}%` }}
        />
      </div>
      <div className="w-10 text-xs text-right tabular-nums text-gray-500">{depth}</div>
    </div>
  );
}

function ActivityRow({ session }: { session: StatsData['recentActivity'][number] }) {
  const statusColor: Record<string, string> = {
    searchable: 'text-green-600',
    complete: 'text-green-600',
    processing: 'text-blue-600',
    pending: 'text-gray-500',
    failed: 'text-red-600',
    blocked: 'text-amber-600',
    partial: 'text-amber-600',
    not_required: 'text-gray-400',
  };
  const age = Math.round((Date.now() - new Date(session.updatedAt).getTime()) / 1000);
  const ageLabel = age < 60 ? `${age}s ago` : age < 3600 ? `${Math.round(age / 60)}m ago` : `${Math.round(age / 3600)}h ago`;

  return (
    <div className="flex items-center gap-3 py-2 border-b border-gray-100 last:border-0">
      <StatusDot ok={session.searchableStatus === 'searchable'} />
      <div className="flex-1 min-w-0">
        <div className="text-xs font-mono truncate text-gray-700">{session.id.slice(0, 8)}</div>
        <div className="text-xs text-gray-400">{session.developerId}</div>
      </div>
      <div className="flex gap-2 text-xs">
        <span className={statusColor[session.searchableStatus] ?? 'text-gray-500'}>
          {session.searchableStatus}
        </span>
        <span className="text-gray-300">|</span>
        <span className={statusColor[session.enrichmentStatus] ?? 'text-gray-500'}>
          {session.enrichmentStatus}
        </span>
      </div>
      <div className="text-xs text-gray-400 w-16 text-right">{ageLabel}</div>
    </div>
  );
}

// ─── Topology Diagram ────────────────────────────────────────────────────────

function Topology({ health, stats }: { health: HealthData | null; stats: StatsData | null }) {
  const ok = (service: string) => health?.checks?.[service] === 'ok';
  const qTotal = stats?.queues?.total ?? 0;
  const active = stats?.processing?.activeSessions ?? 0;

  return (
    <div className="p-6 bg-white border border-gray-200 rounded-lg overflow-x-auto">
      <h3 className="font-semibold mb-4">System Topology</h3>
      <div className="min-w-[700px]">
        {/* Row 1: Clients */}
        <div className="flex justify-center gap-3 mb-4">
          {['IDE / MCP', 'CLI', 'Slack', 'Dashboard'].map(name => (
            <div key={name} className="px-3 py-1.5 bg-gray-100 rounded text-xs text-gray-700 border border-gray-200">{name}</div>
          ))}
        </div>
        <div className="flex justify-center mb-4">
          <div className="w-px h-6 bg-gray-300" />
        </div>

        {/* Row 2: API */}
        <div className="flex justify-center mb-2">
          <div className={`px-4 py-2 rounded-lg border-2 text-sm font-medium ${ok('database') && ok('redis') ? 'border-green-500 bg-green-50 text-green-800' : 'border-red-400 bg-red-50 text-red-700'}`}>
            API Service
            {active > 0 && <span className="ml-2 px-1.5 py-0.5 bg-blue-100 text-blue-700 rounded text-xs">{active} processing</span>}
          </div>
        </div>
        <div className="flex justify-center gap-1 mb-4">
          <div className="w-px h-6 bg-gray-300" />
          <div className="w-32" />
          <div className="w-px h-6 bg-gray-300" />
        </div>

        {/* Row 3: Stores */}
        <div className="flex justify-center gap-6 mb-4">
          <div className={`px-3 py-2 rounded border text-xs ${ok('database') ? 'border-green-400 bg-green-50' : 'border-red-400 bg-red-50'}`}>
            <StatusDot ok={ok('database')} /> PostgreSQL
            <div className="text-gray-400 mt-0.5">{stats?.counts?.chunks?.toLocaleString() ?? '—'} chunks</div>
          </div>
          <div className={`px-3 py-2 rounded border text-xs ${ok('redis') ? 'border-green-400 bg-green-50' : 'border-red-400 bg-red-50'}`}>
            <StatusDot ok={ok('redis')} /> Redis
            <div className="text-gray-400 mt-0.5">{qTotal} queued</div>
          </div>
          <div className={`px-3 py-2 rounded border text-xs ${ok('objectStorage') ? 'border-green-400 bg-green-50' : 'border-red-400 bg-red-50'}`}>
            <StatusDot ok={ok('objectStorage')} /> Object Storage
            <div className="text-gray-400 mt-0.5">{stats?.counts?.sessions?.toLocaleString() ?? '—'} sessions</div>
          </div>
        </div>
        <div className="flex justify-center gap-1 mb-4">
          <div className="w-px h-6 bg-gray-300" />
        </div>

        {/* Row 4: Workers */}
        <div className="flex justify-center gap-4">
          <div className="px-3 py-2 rounded border border-purple-300 bg-purple-50 text-xs">
            Worker Service
            <div className="text-purple-600 mt-0.5">pipeline + enrichment</div>
          </div>
          <div className="px-3 py-2 rounded border border-amber-300 bg-amber-50 text-xs">
            Embedding
            <div className="text-amber-600 mt-0.5">1536d vectors</div>
          </div>
          <div className="px-3 py-2 rounded border border-teal-300 bg-teal-50 text-xs">
            Compaction
            <div className="text-teal-600 mt-0.5">weekly CronJob</div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Page ────────────────────────────────────────────────────────────────────

export default function SystemPage() {
  const [health, setHealth] = useState<HealthData | null>(null);
  const [stats, setStats] = useState<StatsData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdate, setLastUpdate] = useState<string>('—');

  const refresh = useCallback(async () => {
    try {
      const [h, s] = await Promise.all([
        getHealth().catch(() => ({ status: 'unreachable', checks: {} })),
        getStats().catch(() => null),
      ]);
      setHealth(h);
      setStats(s);
      setLastUpdate(new Date().toLocaleTimeString());
      setError(null);
    } catch (e: any) {
      setError(e.message);
    }
  }, []);

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, POLL_INTERVAL);
    return () => clearInterval(timer);
  }, [refresh]);

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-2xl font-bold">System</h2>
          <p className="text-gray-500 text-sm">Live topology, data flow, and active conversations. Refreshes every 5s.</p>
        </div>
        <div className="text-xs text-gray-400">
          Last update: {lastUpdate}
          {error && <span className="ml-2 text-red-500">error</span>}
        </div>
      </div>

      {/* Topology */}
      <Topology health={health} stats={stats} />

      {/* Metrics Row */}
      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-3 mt-6">
        <MetricCard label="Sessions" value={stats?.counts?.sessions ?? 0} />
        <MetricCard label="Chunks" value={stats?.counts?.chunks ?? 0} sub={`${stats?.counts?.searchableChunks ?? 0} searchable`} />
        <MetricCard label="Facts" value={stats?.counts?.facts ?? 0} />
        <MetricCard label="Clusters" value={stats?.counts?.clusters ?? 0} />
        <MetricCard label="Knowledge" value={stats?.counts?.knowledgeRecords ?? 0} />
        <MetricCard label="Graph Nodes" value={stats?.counts?.graphNodes ?? 0} />
        <MetricCard label="Active" value={stats?.processing?.activeSessions ?? 0} sub="processing now" />
      </div>

      {/* Queues + Activity */}
      <div className="grid md:grid-cols-2 gap-6 mt-6">
        {/* Queue Depths */}
        <div className="p-4 bg-white border border-gray-200 rounded-lg">
          <h3 className="font-semibold mb-3">Queue Depths</h3>
          <div className="space-y-2">
            <QueueBar name="Session Processing" depth={stats?.queues?.sessionProcessing ?? 0} />
            <QueueBar name="Search Indexing" depth={stats?.queues?.searchIndexing ?? 0} />
            <QueueBar name="Fact Extraction" depth={stats?.queues?.factExtraction ?? 0} />
            <QueueBar name="Knowledge" depth={stats?.queues?.knowledgeExtraction ?? 0} />
            <QueueBar name="Deduplication" depth={stats?.queues?.deduplication ?? 0} />
            <QueueBar name="Graph Indexing" depth={stats?.queues?.graphIndexing ?? 0} />
            <QueueBar name="Capture" depth={stats?.queues?.captureProcessing ?? 0} />
          </div>
          <div className="mt-3 text-xs text-gray-400 text-right">
            Total queued: {stats?.queues?.total ?? 0}
          </div>
        </div>

        {/* Live Activity Feed */}
        <div className="p-4 bg-white border border-gray-200 rounded-lg">
          <h3 className="font-semibold mb-3">
            Live Conversations
            {(stats?.processing?.activeSessions ?? 0) > 0 && (
              <span className="ml-2 inline-flex items-center gap-1 px-2 py-0.5 bg-blue-100 text-blue-700 rounded-full text-xs font-normal">
                <span className="w-1.5 h-1.5 bg-blue-500 rounded-full animate-pulse" />
                {stats!.processing.activeSessions} active
              </span>
            )}
          </h3>
          <div className="max-h-80 overflow-y-auto">
            {stats?.recentActivity?.length ? (
              stats.recentActivity.map(session => (
                <ActivityRow key={session.id} session={session} />
              ))
            ) : (
              <div className="text-sm text-gray-400 py-4 text-center">No recent activity</div>
            )}
          </div>
        </div>
      </div>

      {/* Processing Status Breakdown */}
      <div className="mt-6 p-4 bg-white border border-gray-200 rounded-lg">
        <h3 className="font-semibold mb-3">Session Processing Status</h3>
        <div className="flex gap-4 flex-wrap">
          {Object.entries(stats?.processing?.byStatus ?? {}).map(([status, count]) => {
            const colors: Record<string, string> = {
              searchable: 'bg-green-100 text-green-800',
              processing: 'bg-blue-100 text-blue-800',
              pending: 'bg-gray-100 text-gray-700',
              blocked: 'bg-amber-100 text-amber-800',
              failed: 'bg-red-100 text-red-800',
            };
            return (
              <div key={status} className={`px-3 py-2 rounded-lg ${colors[status] ?? 'bg-gray-100'}`}>
                <div className="text-lg font-bold tabular-nums">{(count as number).toLocaleString()}</div>
                <div className="text-xs">{status}</div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Data Flow Legend */}
      <div className="mt-6 p-4 bg-white border border-gray-200 rounded-lg text-xs text-gray-500">
        <h3 className="font-semibold text-gray-700 mb-2">Data Flow</h3>
        <div className="grid md:grid-cols-2 gap-2">
          <div><span className="font-mono text-gray-700">POST /sessions</span> → Object Storage → PostgreSQL (session + outbox) → 202</div>
          <div><span className="font-mono text-gray-700">Outbox</span> → Redis queue → Worker → Embed → Chunks + Actions</div>
          <div><span className="font-mono text-gray-700">POST /search</span> → Cache check → Embed query → 3 parallel signals → RRF → ACL → Response</div>
          <div><span className="font-mono text-gray-700">Compaction</span> → Synthesize clusters → Supersede facts → Archive stale</div>
        </div>
      </div>
    </div>
  );
}
