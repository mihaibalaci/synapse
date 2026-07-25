'use client';

import { useState, useEffect } from 'react';
import { getFacts, getFactHistory } from '@/lib/api';

export default function FactsPage() {
  const [facts, setFacts] = useState<any[]>([]);
  const [entityFilter, setEntityFilter] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [history, setHistory] = useState<{ entity: string; items: any[] } | null>(null);
  const [loading, setLoading] = useState(false);

  async function loadFacts() {
    setLoading(true);
    try {
      const params: any = { limit: 30 };
      if (entityFilter) params.entities = entityFilter.split(',').map((e: string) => e.trim());
      if (typeFilter) params.types = [typeFilter];
      const data = await getFacts(params);
      setFacts(data.facts ?? []);
    } catch { /* ignore */ }
    setLoading(false);
  }

  async function viewHistory(entity: string) {
    const data = await getFactHistory(entity);
    setHistory({ entity, items: data.history ?? [] });
  }

  useEffect(() => { loadFacts(); }, []);

  const typeColors: Record<string, string> = {
    decision: 'bg-blue-100 text-blue-800',
    lesson: 'bg-purple-100 text-purple-800',
    pattern: 'bg-green-100 text-green-800',
    constraint: 'bg-red-100 text-red-800',
    procedure: 'bg-yellow-100 text-yellow-800',
    preference: 'bg-indigo-100 text-indigo-800',
    definition: 'bg-gray-100 text-gray-800',
    relationship: 'bg-orange-100 text-orange-800',
  };

  return (
    <div>
      <h2 className="text-2xl font-bold mb-2">Facts</h2>
      <p className="text-gray-500 text-sm mb-6">Atomic knowledge extracted from AI sessions. Filter by entity or type.</p>

      {/* Filters */}
      <div className="flex gap-3 mb-6">
        <input
          type="text"
          placeholder="Filter by entities (comma-separated)"
          value={entityFilter}
          onChange={(e) => setEntityFilter(e.target.value)}
          className="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm"
        />
        <select
          value={typeFilter}
          onChange={(e) => setTypeFilter(e.target.value)}
          className="px-3 py-2 border border-gray-300 rounded-lg text-sm"
        >
          <option value="">All types</option>
          <option value="decision">Decision</option>
          <option value="lesson">Lesson</option>
          <option value="pattern">Pattern</option>
          <option value="constraint">Constraint</option>
          <option value="procedure">Procedure</option>
          <option value="preference">Preference</option>
          <option value="definition">Definition</option>
          <option value="relationship">Relationship</option>
        </select>
        <button
          onClick={loadFacts}
          disabled={loading}
          className="px-4 py-2 bg-gray-900 text-white rounded-lg text-sm hover:bg-gray-700 disabled:opacity-50"
        >
          {loading ? 'Loading...' : 'Filter'}
        </button>
      </div>

      {/* Facts List */}
      <div className="space-y-3">
        {facts.map((f) => (
          <div key={f.id} className="p-4 bg-white border border-gray-200 rounded-lg">
            <div className="flex items-start justify-between">
              <div className="flex-1">
                <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium mr-2 ${typeColors[f.type] ?? 'bg-gray-100'}`}>
                  {f.type}
                </span>
                <span className="text-sm">{f.content}</span>
              </div>
              <div className="text-xs text-gray-400 ml-4 whitespace-nowrap">
                {f.confidence ? `${Math.round(f.confidence * 100)}%` : ''} | used {f.usageCount ?? 0}x
              </div>
            </div>
            {f.entities?.length > 0 && (
              <div className="mt-2 flex gap-1 flex-wrap">
                {f.entities.map((e: string) => (
                  <button
                    key={e}
                    onClick={() => viewHistory(e)}
                    className="px-2 py-0.5 bg-gray-100 rounded text-xs text-gray-600 hover:bg-gray-200"
                  >
                    {e}
                  </button>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>

      {facts.length === 0 && !loading && (
        <div className="text-center text-gray-400 mt-8">No facts found. Adjust filters or ingest more sessions.</div>
      )}

      {/* History Modal */}
      {history && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={() => setHistory(null)}>
          <div className="bg-white rounded-xl p-6 max-w-lg w-full max-h-[80vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-lg font-bold mb-4">History: {history.entity}</h3>
            {history.items.length === 0 ? (
              <p className="text-gray-400">No history available.</p>
            ) : (
              <div className="space-y-3">
                {history.items.map((item: any, i: number) => {
                  const isCurrent = !item.temporal?.validUntil;
                  return (
                    <div key={i} className={`p-3 rounded border ${isCurrent ? 'border-green-200 bg-green-50' : 'border-gray-200 bg-gray-50'}`}>
                      <div className="text-xs text-gray-500 mb-1">
                        {item.temporal?.validFrom?.substring(0, 10) ?? '?'} → {item.temporal?.validUntil?.substring(0, 10) ?? 'now'}
                      </div>
                      <div className={isCurrent ? 'font-medium' : 'line-through text-gray-400'}>
                        {item.content}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
            <button onClick={() => setHistory(null)} className="mt-4 px-4 py-2 bg-gray-900 text-white rounded-lg text-sm">Close</button>
          </div>
        </div>
      )}
    </div>
  );
}
