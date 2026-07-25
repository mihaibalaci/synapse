'use client';

import { useState } from 'react';
import { SearchBar } from '@/components/SearchBar';
import { ResultCard } from '@/components/ResultCard';
import { searchKnowledge } from '@/lib/api';

export default function SearchPage() {
  const [results, setResults] = useState<any[]>([]);
  const [meta, setMeta] = useState<{ totalCount: number; latencyMs: number; estimatedTokens: number } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSearch(query: string, filters: { repo?: string; lang?: string }) {
    setLoading(true);
    setError(null);
    try {
      const data = await searchKnowledge(query, { repo: filters.repo, lang: filters.lang, limit: 10 });
      setResults(data.results ?? []);
      setMeta({ totalCount: data.totalCount, latencyMs: data.latencyMs, estimatedTokens: data.estimatedTokens });
    } catch (e: any) {
      setError(e.message);
      setResults([]);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div>
      <div className="mb-8">
        <h2 className="text-2xl font-bold mb-2">Search Knowledge</h2>
        <p className="text-gray-500 text-sm">Search across all engineering AI sessions, facts, and decisions.</p>
      </div>

      <SearchBar onSearch={handleSearch} loading={loading} />

      {error && (
        <div className="mt-4 p-3 bg-red-50 border border-red-200 rounded text-red-700 text-sm">{error}</div>
      )}

      {meta && (
        <div className="mt-4 text-sm text-gray-500">
          {meta.totalCount} results in {meta.latencyMs}ms (~{meta.estimatedTokens} tokens)
        </div>
      )}

      <div className="mt-6 space-y-4">
        {results.map((r) => (
          <ResultCard key={r.id} result={r} />
        ))}
      </div>

      {!loading && results.length === 0 && meta && (
        <div className="mt-8 text-center text-gray-400">No results found. Try a different query.</div>
      )}
    </div>
  );
}
