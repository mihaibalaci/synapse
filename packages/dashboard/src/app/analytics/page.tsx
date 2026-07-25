'use client';

import { useState, useEffect } from 'react';
import { getHealth } from '@/lib/api';

export default function AnalyticsPage() {
  const [health, setHealth] = useState<any>(null);

  useEffect(() => {
    getHealth().then(setHealth).catch(() => setHealth({ status: 'unreachable' }));
  }, []);

  // Placeholder metrics — in production these come from the API
  const metrics = {
    totalSessions: '24,381',
    totalChunks: '241,205',
    totalFacts: '89,412',
    totalClusters: '12,847',
    avgTokensPerQuery: '1,842',
    cacheHitRate: '34%',
    avgLatency: '98ms',
    adoptionRate: '72%',
    topEntities: ['Lambda', 'PostgreSQL', 'Docker', 'Kafka', 'React', 'Kubernetes', 'S3', 'Redis'],
    topTypes: [
      { type: 'lesson', count: 31204 },
      { type: 'decision', count: 22156 },
      { type: 'pattern', count: 18903 },
      { type: 'constraint', count: 8721 },
      { type: 'procedure', count: 8428 },
    ],
  };

  return (
    <div>
      <h2 className="text-2xl font-bold mb-2">Analytics</h2>
      <p className="text-gray-500 text-sm mb-6">System health, knowledge growth, and usage metrics.</p>

      {/* System Status */}
      <div className="mb-8 p-4 bg-white border border-gray-200 rounded-lg">
        <h3 className="font-semibold mb-3">System Status</h3>
        {health ? (
          <div className="flex gap-4 flex-wrap">
            {Object.entries(health.checks ?? {}).map(([service, status]) => (
              <div key={service} className="flex items-center gap-2">
                <div className={`w-2 h-2 rounded-full ${status === 'ok' ? 'bg-green-500' : 'bg-red-500'}`} />
                <span className="text-sm">{service}</span>
              </div>
            ))}
          </div>
        ) : (
          <div className="text-sm text-gray-400">Loading...</div>
        )}
      </div>

      {/* Metrics Grid */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
        {[
          { label: 'Total Sessions', value: metrics.totalSessions },
          { label: 'Total Chunks', value: metrics.totalChunks },
          { label: 'Total Facts', value: metrics.totalFacts },
          { label: 'Clusters', value: metrics.totalClusters },
          { label: 'Avg Tokens/Query', value: metrics.avgTokensPerQuery },
          { label: 'Cache Hit Rate', value: metrics.cacheHitRate },
          { label: 'Avg Latency', value: metrics.avgLatency },
          { label: 'Adoption Rate', value: metrics.adoptionRate },
        ].map((m) => (
          <div key={m.label} className="p-4 bg-white border border-gray-200 rounded-lg">
            <div className="text-2xl font-bold">{m.value}</div>
            <div className="text-xs text-gray-500 mt-1">{m.label}</div>
          </div>
        ))}
      </div>

      {/* Top Entities */}
      <div className="grid md:grid-cols-2 gap-6">
        <div className="p-4 bg-white border border-gray-200 rounded-lg">
          <h3 className="font-semibold mb-3">Top Entities</h3>
          <div className="flex flex-wrap gap-2">
            {metrics.topEntities.map((e) => (
              <span key={e} className="px-3 py-1 bg-blue-50 text-blue-700 rounded-full text-sm">{e}</span>
            ))}
          </div>
        </div>

        <div className="p-4 bg-white border border-gray-200 rounded-lg">
          <h3 className="font-semibold mb-3">Knowledge by Type</h3>
          <div className="space-y-2">
            {metrics.topTypes.map((t) => (
              <div key={t.type} className="flex items-center gap-3">
                <div className="w-20 text-sm text-gray-600">{t.type}</div>
                <div className="flex-1 bg-gray-100 rounded-full h-4 overflow-hidden">
                  <div
                    className="bg-blue-500 h-full rounded-full"
                    style={{ width: `${(t.count / metrics.topTypes[0].count) * 100}%` }}
                  />
                </div>
                <div className="text-xs text-gray-400 w-16 text-right">{t.count.toLocaleString()}</div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Token Savings Projection */}
      <div className="mt-6 p-4 bg-white border border-gray-200 rounded-lg">
        <h3 className="font-semibold mb-3">Token Savings Over Time</h3>
        <div className="grid grid-cols-5 gap-2 text-center text-sm">
          {[
            { month: 'Month 1', tokens: '12,000', pct: '0%' },
            { month: 'Month 3', tokens: '4,000', pct: '67%' },
            { month: 'Month 6', tokens: '2,500', pct: '79%' },
            { month: 'Month 12', tokens: '1,500', pct: '88%' },
            { month: 'Month 24', tokens: '800', pct: '93%' },
          ].map((p) => (
            <div key={p.month} className="p-3 bg-green-50 rounded-lg">
              <div className="font-bold text-green-700">{p.pct}</div>
              <div className="text-xs text-gray-500">{p.tokens} tok/q</div>
              <div className="text-xs text-gray-400 mt-1">{p.month}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
