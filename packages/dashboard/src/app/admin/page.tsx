'use client';

import { useState, useEffect, useCallback } from 'react';
import { getHealth, getStats, getLearningMetrics, triggerLearningCycle } from '@/lib/api';

// ─── Types ───────────────────────────────────────────────────────────────────

interface LearningData {
  metrics: {
    period: { from: string; to: string };
    inline: {
      factsExtracted: number;
      opinionsReinforced: number;
      opinionsWeakened: number;
      opinionsContradicted: number;
      observationsTriggered: number;
    };
    reflect: {
      reflectCalls: number;
      highConfidenceAnswers: number;
      insightsWrittenBack: number;
      sourcesBosted: number;
    };
    health: {
      isLearning: boolean;
      confidenceTrend: number;
      compressionRatio: number;
      observationCoverage: number;
    };
  };
  health: {
    healthy: boolean;
    reasons: string[];
  };
  config: {
    inlineReinforcementEnabled: boolean;
    reflectWriteBackEnabled: boolean;
    sourceBoostEnabled: boolean;
    writeBackMinConfidence: string;
    maxInsightsPerReflect: number;
    observationRefreshDelay: number;
  };
}

interface SystemStats {
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
  };
  queues: { total: number };
}

// ─── Components ──────────────────────────────────────────────────────────────

function StatusBadge({ healthy }: { healthy: boolean }) {
  return (
    <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium ${
      healthy ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'
    }`}>
      <span className={`w-2 h-2 rounded-full ${healthy ? 'bg-green-500 animate-pulse' : 'bg-red-500'}`} />
      {healthy ? 'Healthy' : 'Unhealthy'}
    </span>
  );
}

function MetricCard({ label, value, sub, color }: { label: string; value: string | number; sub?: string; color?: string }) {
  return (
    <div className="p-5 bg-white border border-gray-200 rounded-xl shadow-sm">
      <div className={`text-3xl font-bold tabular-nums ${color ?? 'text-gray-900'}`}>
        {typeof value === 'number' ? value.toLocaleString() : value}
      </div>
      <div className="text-sm text-gray-500 mt-1">{label}</div>
      {sub && <div className="text-xs text-gray-400 mt-0.5">{sub}</div>}
    </div>
  );
}

function ProgressBar({ label, value, max, color }: { label: string; value: number; max: number; color: string }) {
  const pct = max > 0 ? Math.min((value / max) * 100, 100) : 0;
  return (
    <div className="flex items-center gap-3">
      <div className="w-36 text-sm text-gray-600">{label}</div>
      <div className="flex-1 bg-gray-100 rounded-full h-2.5 overflow-hidden">
        <div className={`h-full rounded-full transition-all duration-700 ${color}`} style={{ width: `${pct}%` }} />
      </div>
      <div className="w-12 text-sm text-right tabular-nums text-gray-700">{value}</div>
    </div>
  );
}

function ConfigItem({ label, value, enabled }: { label: string; value: string; enabled?: boolean }) {
  return (
    <div className="flex items-center justify-between py-2 border-b border-gray-100 last:border-0">
      <span className="text-sm text-gray-600">{label}</span>
      <span className={`text-sm font-mono ${enabled === false ? 'text-red-500' : enabled === true ? 'text-green-600' : 'text-gray-800'}`}>
        {value}
      </span>
    </div>
  );
}

// ─── Page ────────────────────────────────────────────────────────────────────

export default function AdminPage() {
  const [learning, setLearning] = useState<LearningData | null>(null);
  const [stats, setStats] = useState<SystemStats | null>(null);
  const [systemHealth, setSystemHealth] = useState<{ status: string; checks: Record<string, string> } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [triggerResult, setTriggerResult] = useState<string | null>(null);
  const [triggering, setTriggering] = useState(false);
  const [lastRefresh, setLastRefresh] = useState<string>('—');

  const refresh = useCallback(async () => {
    try {
      const [l, s, h] = await Promise.all([
        getLearningMetrics().catch(() => null),
        getStats().catch(() => null),
        getHealth().catch(() => ({ status: 'unreachable', checks: {} })),
      ]);
      setLearning(l);
      setStats(s);
      setSystemHealth(h);
      setLastRefresh(new Date().toLocaleTimeString());
      setError(null);
    } catch (e: any) {
      setError(e.message);
    }
  }, []);

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, 10000);
    return () => clearInterval(timer);
  }, [refresh]);

  async function handleTrigger() {
    setTriggering(true);
    setTriggerResult(null);
    try {
      const result = await triggerLearningCycle();
      setTriggerResult(
        `Cycle complete: ${result.result.opinionsReinforced} opinions reinforced, ` +
        `${result.result.observationsRefreshed} observations refreshed, ` +
        `${result.result.observationsDiscovered} new observations discovered`
      );
      refresh();
    } catch (e: any) {
      setTriggerResult(`Error: ${e.message}`);
    } finally {
      setTriggering(false);
    }
  }

  const isHealthy = systemHealth?.status === 'ready';
  const isLearning = learning?.metrics?.health?.isLearning ?? false;

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-8">
        <div>
          <h2 className="text-2xl font-bold">Admin Dashboard</h2>
          <p className="text-gray-500 text-sm mt-1">System health, learning loop metrics, and administration.</p>
        </div>
        <div className="flex items-center gap-4">
          <StatusBadge healthy={isHealthy} />
          <span className="text-xs text-gray-400">Updated: {lastRefresh}</span>
        </div>
      </div>

      {error && (
        <div className="mb-6 p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">{error}</div>
      )}

      {/* System Health Overview */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
        <MetricCard
          label="System Status"
          value={isHealthy ? 'Operational' : 'Degraded'}
          color={isHealthy ? 'text-green-600' : 'text-red-600'}
        />
        <MetricCard
          label="Learning Loop"
          value={isLearning ? 'Active' : 'Inactive'}
          color={isLearning ? 'text-indigo-600' : 'text-gray-400'}
          sub={isLearning ? 'Writing insights' : 'No recent insights'}
        />
        <MetricCard
          label="Knowledge Base"
          value={stats?.counts?.facts ?? 0}
          sub={`${stats?.counts?.chunks ?? 0} chunks, ${stats?.counts?.clusters ?? 0} clusters`}
        />
        <MetricCard
          label="Queue Depth"
          value={stats?.queues?.total ?? 0}
          sub={`${stats?.processing?.activeSessions ?? 0} processing`}
          color={(stats?.queues?.total ?? 0) > 50 ? 'text-amber-600' : undefined}
        />
      </div>

      {/* Infrastructure Health */}
      <div className="grid md:grid-cols-2 gap-6 mb-8">
        <div className="p-5 bg-white border border-gray-200 rounded-xl">
          <h3 className="font-semibold mb-4">Infrastructure</h3>
          <div className="space-y-3">
            {Object.entries(systemHealth?.checks ?? {}).map(([service, status]) => (
              <div key={service} className="flex items-center justify-between">
                <span className="text-sm text-gray-700 capitalize">{service}</span>
                <span className={`text-sm font-medium ${status === 'ok' ? 'text-green-600' : 'text-red-600'}`}>
                  {status === 'ok' ? 'Connected' : status}
                </span>
              </div>
            ))}
          </div>
        </div>

        <div className="p-5 bg-white border border-gray-200 rounded-xl">
          <h3 className="font-semibold mb-4">Learning Loop Health</h3>
          {learning?.health ? (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-sm text-gray-700">Status</span>
                <StatusBadge healthy={learning.health.healthy} />
              </div>
              {learning.health.reasons.length > 0 && (
                <div className="mt-2 space-y-1">
                  {learning.health.reasons.map((reason, i) => (
                    <div key={i} className="text-xs text-amber-700 bg-amber-50 px-2 py-1 rounded">{reason}</div>
                  ))}
                </div>
              )}
              <div className="flex items-center justify-between">
                <span className="text-sm text-gray-700">Opinion Confidence</span>
                <span className="text-sm font-mono">{(learning.metrics.health.confidenceTrend * 100).toFixed(0)}%</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-sm text-gray-700">Observation Coverage</span>
                <span className="text-sm font-mono">{(learning.metrics.health.observationCoverage * 100).toFixed(0)}%</span>
              </div>
            </div>
          ) : (
            <div className="text-sm text-gray-400">Loading...</div>
          )}
        </div>
      </div>

      {/* Learning Metrics */}
      <div className="p-5 bg-white border border-gray-200 rounded-xl mb-8">
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-semibold">Learning Loop Activity (Last 7 Days)</h3>
          <span className="text-xs text-gray-400">
            {learning?.metrics?.period?.from?.substring(0, 10)} — {learning?.metrics?.period?.to?.substring(0, 10)}
          </span>
        </div>

        <div className="grid md:grid-cols-2 gap-6">
          {/* Inline Learning */}
          <div>
            <h4 className="text-sm font-medium text-gray-700 mb-3">Inline Learning (at ingestion)</h4>
            <div className="space-y-2">
              <ProgressBar label="Facts Extracted" value={learning?.metrics?.inline?.factsExtracted ?? 0} max={5000} color="bg-blue-500" />
              <ProgressBar label="Opinions Reinforced" value={learning?.metrics?.inline?.opinionsReinforced ?? 0} max={100} color="bg-green-500" />
              <ProgressBar label="Opinions Weakened" value={learning?.metrics?.inline?.opinionsWeakened ?? 0} max={50} color="bg-amber-500" />
              <ProgressBar label="Contradicted" value={learning?.metrics?.inline?.opinionsContradicted ?? 0} max={20} color="bg-red-500" />
              <ProgressBar label="Observations Triggered" value={learning?.metrics?.inline?.observationsTriggered ?? 0} max={500} color="bg-purple-500" />
            </div>
          </div>

          {/* Reflect Learning */}
          <div>
            <h4 className="text-sm font-medium text-gray-700 mb-3">Reflect Learning (at query time)</h4>
            <div className="space-y-2">
              <ProgressBar label="Reflect Calls" value={learning?.metrics?.reflect?.reflectCalls ?? 0} max={200} color="bg-indigo-500" />
              <ProgressBar label="High Confidence" value={learning?.metrics?.reflect?.highConfidenceAnswers ?? 0} max={100} color="bg-green-500" />
              <ProgressBar label="Insights Written" value={learning?.metrics?.reflect?.insightsWrittenBack ?? 0} max={100} color="bg-teal-500" />
              <ProgressBar label="Sources Boosted" value={learning?.metrics?.reflect?.sourcesBosted ?? 0} max={1000} color="bg-blue-400" />
            </div>
          </div>
        </div>
      </div>

      {/* Actions + Config */}
      <div className="grid md:grid-cols-2 gap-6">
        {/* Manual Trigger */}
        <div className="p-5 bg-white border border-gray-200 rounded-xl">
          <h3 className="font-semibold mb-3">Manual Actions</h3>
          <p className="text-sm text-gray-500 mb-4">
            Trigger a full learning cycle: opinion reinforcement + observation refresh + entity discovery.
          </p>
          <button
            onClick={handleTrigger}
            disabled={triggering}
            className="px-4 py-2 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {triggering ? 'Running...' : 'Trigger Learning Cycle'}
          </button>
          {triggerResult && (
            <div className={`mt-3 p-2 rounded text-xs ${
              triggerResult.startsWith('Error') ? 'bg-red-50 text-red-700' : 'bg-green-50 text-green-700'
            }`}>
              {triggerResult}
            </div>
          )}
        </div>

        {/* Configuration */}
        <div className="p-5 bg-white border border-gray-200 rounded-xl">
          <h3 className="font-semibold mb-3">Learning Loop Configuration</h3>
          {learning?.config ? (
            <div>
              <ConfigItem label="Inline Reinforcement" value={learning.config.inlineReinforcementEnabled ? 'Enabled' : 'Disabled'} enabled={learning.config.inlineReinforcementEnabled} />
              <ConfigItem label="Reflect Write-Back" value={learning.config.reflectWriteBackEnabled ? 'Enabled' : 'Disabled'} enabled={learning.config.reflectWriteBackEnabled} />
              <ConfigItem label="Source Boosting" value={learning.config.sourceBoostEnabled ? 'Enabled' : 'Disabled'} enabled={learning.config.sourceBoostEnabled} />
              <ConfigItem label="Write-Back Threshold" value={learning.config.writeBackMinConfidence} />
              <ConfigItem label="Max Insights / Reflect" value={String(learning.config.maxInsightsPerReflect)} />
              <ConfigItem label="Observation Refresh Delay" value={`${learning.config.observationRefreshDelay}s`} />
            </div>
          ) : (
            <div className="text-sm text-gray-400">Loading configuration...</div>
          )}
        </div>
      </div>

      {/* Learning Loop Diagram */}
      <div className="mt-8 p-5 bg-white border border-gray-200 rounded-xl">
        <h3 className="font-semibold mb-4">Learning Loop Cycle</h3>
        <div className="flex items-center justify-center gap-2 flex-wrap text-sm">
          {['RETAIN', 'EXTRACT', 'REINFORCE', 'OBSERVE', 'RECALL', 'REFLECT', 'WRITE-BACK'].map((step, i) => (
            <span key={step} className="flex items-center gap-2">
              <span className="px-3 py-1.5 bg-indigo-50 text-indigo-700 rounded-lg font-medium text-xs">{step}</span>
              {i < 6 && <span className="text-gray-300">→</span>}
            </span>
          ))}
          <span className="text-gray-300 ml-1">↩ RETAIN</span>
        </div>
        <p className="text-xs text-gray-400 text-center mt-3">
          Each interaction strengthens the knowledge network. Insights flow back as new facts, opinions evolve with evidence, observations sharpen over time.
        </p>
      </div>
    </div>
  );
}
