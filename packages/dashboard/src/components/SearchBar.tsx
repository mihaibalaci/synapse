'use client';

import { useState } from 'react';

interface SearchBarProps {
  onSearch: (query: string, filters: { repo?: string; lang?: string }) => void;
  loading?: boolean;
}

export function SearchBar({ onSearch, loading }: SearchBarProps) {
  const [query, setQuery] = useState('');
  const [repo, setRepo] = useState('');
  const [lang, setLang] = useState('');
  const [showFilters, setShowFilters] = useState(false);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!query.trim()) return;
    onSearch(query.trim(), { repo: repo || undefined, lang: lang || undefined });
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      <div className="flex gap-2">
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search engineering knowledge... (e.g. 'Lambda timeout VPC DNS')"
          className="flex-1 px-4 py-3 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
          autoFocus
        />
        <button
          type="submit"
          disabled={loading || !query.trim()}
          className="px-6 py-3 bg-gray-900 text-white rounded-lg text-sm font-medium hover:bg-gray-700 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {loading ? 'Searching...' : 'Search'}
        </button>
        <button
          type="button"
          onClick={() => setShowFilters(!showFilters)}
          className="px-3 py-3 border border-gray-300 rounded-lg text-sm text-gray-600 hover:bg-gray-50"
          title="Toggle filters"
        >
          Filters
        </button>
      </div>

      {showFilters && (
        <div className="flex gap-3">
          <input
            type="text"
            value={repo}
            onChange={(e) => setRepo(e.target.value)}
            placeholder="Repository (e.g. org/service)"
            className="flex-1 px-3 py-2 border border-gray-200 rounded-lg text-sm"
          />
          <input
            type="text"
            value={lang}
            onChange={(e) => setLang(e.target.value)}
            placeholder="Language"
            className="w-40 px-3 py-2 border border-gray-200 rounded-lg text-sm"
          />
        </div>
      )}
    </form>
  );
}
