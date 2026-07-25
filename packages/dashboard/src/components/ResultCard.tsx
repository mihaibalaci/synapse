'use client';

import { useState } from 'react';
import { submitFeedback } from '@/lib/api';

interface ResultCardProps {
  result: {
    id: string;
    title: string;
    summary: string;
    content?: string;
    finalScore: number;
    scores: Record<string, number>;
    repository?: string;
    language?: string;
    frameworks?: string[];
    createdAt?: string;
    codeSnippets?: Array<{ language: string; code: string; filePath?: string }>;
    citations?: Array<{ type: string; reference: string }>;
  };
}

export function ResultCard({ result }: ResultCardProps) {
  const [expanded, setExpanded] = useState(false);
  const [voted, setVoted] = useState<'up' | 'down' | null>(null);

  async function handleVote(action: 'thumbs_up' | 'thumbs_down') {
    try {
      await submitFeedback(result.id, action);
      setVoted(action === 'thumbs_up' ? 'up' : 'down');
    } catch { /* ignore */ }
  }

  const scorePercent = Math.round(result.finalScore * 100);

  return (
    <div className="p-4 bg-white border border-gray-200 rounded-lg hover:border-gray-300 transition-colors">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div className="flex-1">
          <button
            onClick={() => setExpanded(!expanded)}
            className="text-left font-medium text-gray-900 hover:text-blue-600"
          >
            {result.title}
          </button>
          <div className="flex items-center gap-2 mt-1 text-xs text-gray-500">
            {result.repository && <span className="bg-gray-100 px-2 py-0.5 rounded">{result.repository}</span>}
            {result.language && <span>{result.language}</span>}
            {result.createdAt && <span>{result.createdAt.substring(0, 10)}</span>}
          </div>
        </div>
        <div className="flex items-center gap-2 ml-4">
          <span className={`text-sm font-mono ${scorePercent >= 80 ? 'text-green-600' : scorePercent >= 60 ? 'text-yellow-600' : 'text-gray-400'}`}>
            {scorePercent}%
          </span>
        </div>
      </div>

      {/* Summary */}
      <p className="mt-2 text-sm text-gray-600">{result.summary}</p>

      {/* Expanded content */}
      {expanded && (
        <div className="mt-4 space-y-3">
          {result.content && (
            <div className="p-3 bg-gray-50 rounded text-sm text-gray-700 whitespace-pre-wrap max-h-64 overflow-y-auto">
              {result.content}
            </div>
          )}

          {result.codeSnippets?.[0] && (
            <pre className="p-3 bg-gray-900 text-green-400 rounded text-xs overflow-x-auto">
              <code>{result.codeSnippets[0].code}</code>
            </pre>
          )}

          {/* Score breakdown */}
          <div className="flex gap-2 flex-wrap text-xs">
            {Object.entries(result.scores).filter(([, v]) => v > 0).map(([key, val]) => (
              <span key={key} className="px-2 py-0.5 bg-blue-50 text-blue-700 rounded">
                {key}: {(val as number).toFixed(2)}
              </span>
            ))}
          </div>

          {/* Citations */}
          {result.citations?.length ? (
            <div className="text-xs text-gray-400">
              Sources: {result.citations.map(c => c.reference).join(', ')}
            </div>
          ) : null}
        </div>
      )}

      {/* Actions */}
      <div className="mt-3 flex items-center gap-2">
        <button
          onClick={() => setExpanded(!expanded)}
          className="text-xs text-gray-500 hover:text-gray-700"
        >
          {expanded ? 'Collapse' : 'Expand'}
        </button>
        <span className="text-gray-300">|</span>
        <button
          onClick={() => handleVote('thumbs_up')}
          disabled={voted !== null}
          className={`text-xs ${voted === 'up' ? 'text-green-600' : 'text-gray-400 hover:text-green-600'}`}
        >
          {voted === 'up' ? 'Upvoted' : 'Useful'}
        </button>
        <button
          onClick={() => handleVote('thumbs_down')}
          disabled={voted !== null}
          className={`text-xs ${voted === 'down' ? 'text-red-600' : 'text-gray-400 hover:text-red-600'}`}
        >
          {voted === 'down' ? 'Downvoted' : 'Not helpful'}
        </button>
      </div>
    </div>
  );
}
