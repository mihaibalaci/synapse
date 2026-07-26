import './globals.css';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Recall',
  description: 'Engineering knowledge base — search, browse, and validate organizational knowledge',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-gray-50 text-gray-900 min-h-screen">
        <nav className="bg-white border-b border-gray-200 px-6 py-3 flex items-center justify-between">
          <div className="flex items-center gap-6">
            <h1 className="text-lg font-semibold">Recall</h1>
            <a href="/" className="text-sm text-gray-600 hover:text-gray-900">Search</a>
            <a href="/facts" className="text-sm text-gray-600 hover:text-gray-900">Facts</a>
            <a href="/analytics" className="text-sm text-gray-600 hover:text-gray-900">Analytics</a>
            <a href="/system" className="text-sm text-gray-600 hover:text-gray-900">System</a>
          </div>
          <div className="text-sm text-gray-400">v0.1.0</div>
        </nav>
        <main className="max-w-6xl mx-auto px-6 py-8">
          {children}
        </main>
      </body>
    </html>
  );
}
