'use client';

import { useState, useEffect } from 'react';
import { getHealth, getStats } from '@/lib/api';

export default function AnalyticsPage() {
  const [health, setHealth] = useState<any>(null);
  const [stats, setStats] = useState<any>(null);

  useEffect(() => {
    getHealth().then(setHealth).catch(() => setHealth({ status: 'unreachable' }));
    getStats().then(setStats).catch(() => null);
  }, []);

  const counts = stats?.counts ?? {};
  const processing = stats?.processing ?? {};

  return (
    <div>
      <h2 className="text-2xl font-bold mb-2">Analytics</h2>
      <p className="text-gray-500 text-sm mb-6">Live system health, knowledge growth, and usage metrics.</p>

      {/* System Status */}
      <div className="mb-8 p-4 bg-white border border-gray-200 rounded-lg">
        <h3 className="font-semibold mb-3">System Status</h3>
        {health ? (
          <div className="flex gap-4 flex-wrap">
            {Object.entries(health.checks ?? {}).map(([service, status]) => (
              <div key={service} className="flex items-center gap-2">
                <div className={`w-2.5 h-2.5 rounded-full ${status === 'ok' ? 'bg-green-500 animate-pulse' : 'bg-red-500'}`} />
                <span className="text-sm">{service}</span>
              </div>
            ))}
            <div className="ml-auto text-xs text-gray-400">
              {health.status === 'ready' ? 'All systems operational' : 'Degraded'}
            </div>
          </div>
        ) : (
          <div className="text-sm text-gray-400">Loading...</div>
        )}
      </div>

      {/* Real Metrics Grid */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
        {[
          { label: 'Total Sessions', value: counts.sessions ?? '—' },
          { label: 'Total Chunks', value: counts.chunks ?? '—' },
          { label: 'Searchable Chunks', value: counts.searchableChunks ?? '—' },
          { label: 'Total Facts', value: counts.facts ?? '—' },
          { label: 'Clusters', value: counts.clusters ?? '—' },
          { label: 'Knowledge Records', value: counts.knowledgeRecords ?? '—' },
          { label: 'Graph Nodes', value: counts.graphNodes ?? '—' },
          { label: 'Active Processing', value: processing.activeSessions ?? '—' },
        ].map((m) => (
          <div key={m.label} className="p-4 bg-white border border-gray-200 rounded-lg">
            <div className="text-2xl font-bold tabular-nums">{typeof m.value === 'number' ? m.value.toLocaleString() : m.value}</div>
            <div className="text-xs text-gray-500 mt-1">{m.label}</div>
          </div>
        ))}
      </div>

      {/* Processing Breakdown */}
      <div className="grid md:grid-cols-2 gap-6 mb-8">
        <div className="p-4 bg-white border border-gray-200 rounded-lg">
          <h3 className="font-semibold mb-3">Sessions by Status</h3>
          {processing.byStatus ? (
            <div className="space-y-2">
              {Object.entries(processing.byStatus).map(([status, count]) => (
                <div key={status} className="flex items-center gap-3">
                  <div className="w-24 text-sm text-gray-600">{status}</div>
                  <div className="flex-1 bg-gray-100 rounded-full h-4 overflow-hidden">
                    <div
                      className={`h-full rounded-full ${status === 'searchable' ? 'bg-green-500' : status === 'processing' ? 'bg-blue-500' : status === 'failed' ? 'bg-red-500' : 'bg-gray-400'}`}
                      style={{ width: `${Math.min(((count as number) / Math.max(counts.sessions, 1)) * 100, 100)}%` }}
                    />
                  </div>
                  <div className="text-xs text-gray-400 w-12 text-right tabular-nums">{(count as number).toLocaleString()}</div>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-sm text-gray-400">Loading...</div>
          )}
        </div>

        <div className="p-4 bg-white border border-gray-200 rounded-lg">
          <h3 className="font-semibold mb-3">Queue Depth</h3>
          {stats?.queues ? (
            <div className="space-y-2">
              {Object.entries(stats.queues)
                .filter(([key]) => key !== 'total')
                .map(([queue, depth]) => (
                  <div key={queue} className="flex items-center gap-3">
                    <div className="w-32 text-xs text-gray-600 truncate">{queue.replace(/([A-Z])/g, ' $1').trim()}</div>
                    <div className="flex-1 bg-gray-100 rounded h-3 overflow-hidden">
                      <div
                        className={`h-full rounded ${(depth as number) > 10 ? 'bg-amber-500' : 'bg-blue-500'}`}
                        style={{ width: `${Math.min((depth as number) / 50 * 100, 100)}%` }}
                      />
                    </div>
                    <div className="text-xs text-gray-400 w-8 text-right tabular-nums">{depth as number}</div>
                  </div>
                ))}
              <div className="text-xs text-gray-400 text-right pt-1">Total: {stats.queues.total}</div>
            </div>
          ) : (
            <div className="text-sm text-gray-400">Loading...</div>
          )}
        </div>
      </div>

      {/* Performance Reference */}
      <div className="p-4 bg-white border border-gray-200 rounded-lg">
        <h3 className="font-semibold mb-3">Measured Retrieval Performance</h3>
        <p className="text-xs text-gray-500 mb-3">120-chunk corpus, single process, cache cleared. Reproduce: <code className="bg-gray-100 px-1 rounded">npm run load:retrieval</code></p>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-xs text-gray-500 border-b">
              <tr>
                <th className="text-left py-2 pr-4">Concurrency</th>
                <th className="text-right py-2 px-3">p50</th>
                <th className="text-right py-2 px-3">p95</th>
                <th className="text-right py-2 px-3">p99</th>
                <th className="text-right py-2 pl-3">Throughput</th>
              </tr>
            </thead>
            <tbody className="font-mono text-xs">
              {[
                { c: 1, p50: '9.8ms', p95: '13.2ms', p99: '20.5ms', rps: '97' },
                { c: 4, p50: '21.1ms', p95: '34.4ms', p99: '46.5ms', rps: '178' },
                { c: 8, p50: '38.1ms', p95: '58.5ms', p99: '72.3ms', rps: '204' },
                { c: 16, p50: '80.6ms', p95: '134.0ms', p99: '176.7ms', rps: '188' },
                { c: 'cache', p50: '8.5ms', p95: '11.8ms', p99: '15.3ms', rps: '1,818' },
              ].map((row) => (
                <tr key={String(row.c)} className="border-b border-gray-50">
                  <td className="py-1.5 pr-4 text-gray-700">{row.c === 'cache' ? 'warm cache (c=16)' : `c=${row.c}`}</td>
                  <td className="py-1.5 px-3 text-right">{row.p50}</td>
                  <td className="py-1.5 px-3 text-right">{row.p95}</td>
                  <td className="py-1.5 px-3 text-right">{row.p99}</td>
                  <td className="py-1.5 pl-3 text-right text-gray-700">{row.rps} rps</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
