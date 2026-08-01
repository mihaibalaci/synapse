import 'dart:async';
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../../services/api_service.dart';

class SearchPage extends StatefulWidget {
  const SearchPage({super.key});

  @override
  State<SearchPage> createState() => _SearchPageState();
}

class _SearchPageState extends State<SearchPage> {
  final _controller = TextEditingController();
  Timer? _debounce;
  List<dynamic> _results = [];
  bool _loading = false;
  String _latency = '';
  int _totalCount = 0;

  void _onSearch(String query) {
    _debounce?.cancel();
    _debounce = Timer(const Duration(milliseconds: 500), () => _execute(query));
  }

  Future<void> _execute(String query) async {
    if (query.trim().isEmpty) {
      setState(() {
        _results = [];
        _totalCount = 0;
        _latency = '';
      });
      return;
    }
    setState(() => _loading = true);
    try {
      final api = context.read<ApiService>();
      final data = await api.post('/api/v1/search', {
        'query': query.trim(),
        'topK': 10,
        'maxTokens': 5000,
        'includeContent': true,
      });
      if (mounted) {
        setState(() {
          _results = data['results'] as List? ?? [];
          _totalCount = data['totalCount'] as int? ?? 0;
          _latency = '${data['latencyMs'] ?? 0}ms';
        });
      }
    } catch (_) {
      if (mounted) {
        setState(() {
          _results = [];
        });
      }
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  @override
  void dispose() {
    _debounce?.cancel();
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Padding(
      padding: const EdgeInsets.all(24),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            'Knowledge Search',
            style: theme.textTheme.headlineSmall?.copyWith(
              fontWeight: FontWeight.bold,
            ),
          ),
          const SizedBox(height: 16),
          TextField(
            controller: _controller,
            onChanged: _onSearch,
            decoration: InputDecoration(
              hintText: 'Ask a question about your engineering knowledge...',
              prefixIcon: const Icon(Icons.search),
              suffixIcon: _loading
                  ? const Padding(
                      padding: EdgeInsets.all(12),
                      child: SizedBox(
                        width: 20,
                        height: 20,
                        child: CircularProgressIndicator(strokeWidth: 2),
                      ),
                    )
                  : null,
              border: OutlineInputBorder(
                borderRadius: BorderRadius.circular(12),
              ),
            ),
          ),
          if (_latency.isNotEmpty)
            Padding(
              padding: const EdgeInsets.only(top: 8),
              child: Text(
                '$_totalCount results in $_latency',
                style: theme.textTheme.bodySmall,
              ),
            ),
          const SizedBox(height: 16),
          Expanded(
            child: _results.isEmpty
                ? Center(
                    child: Text(
                      _controller.text.isEmpty
                          ? 'Type a query to search'
                          : 'No results',
                      style: theme.textTheme.bodyMedium,
                    ),
                  )
                : ListView.builder(
                    itemCount: _results.length,
                    itemBuilder: (ctx, i) {
                      final r = _results[i] as Map<String, dynamic>;
                      return Card(
                        margin: const EdgeInsets.only(bottom: 12),
                        child: Padding(
                          padding: const EdgeInsets.all(16),
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Row(
                                children: [
                                  Expanded(
                                    child: Text(
                                      r['title'] ?? 'Untitled',
                                      style: theme.textTheme.titleSmall
                                          ?.copyWith(
                                            fontWeight: FontWeight.w600,
                                          ),
                                    ),
                                  ),
                                  Chip(
                                    label: Text(
                                      '${((r['finalScore'] as num? ?? 0) * 100).toStringAsFixed(0)}%',
                                      style: const TextStyle(fontSize: 11),
                                    ),
                                  ),
                                ],
                              ),
                              if (r['repository'] != null &&
                                  (r['repository'] as String).isNotEmpty)
                                Padding(
                                  padding: const EdgeInsets.only(top: 4),
                                  child: Text(
                                    r['repository'],
                                    style: theme.textTheme.bodySmall?.copyWith(
                                      color: theme.colorScheme.primary,
                                    ),
                                  ),
                                ),
                              const SizedBox(height: 8),
                              Text(
                                r['content'] ?? r['summary'] ?? '',
                                maxLines: 4,
                                overflow: TextOverflow.ellipsis,
                                style: theme.textTheme.bodySmall,
                              ),
                              const SizedBox(height: 8),
                              Text(
                                'ID: ${r['id']}  •  ${r['createdAt'] ?? ''}',
                                style: theme.textTheme.labelSmall?.copyWith(
                                  color: theme.colorScheme.onSurfaceVariant,
                                ),
                              ),
                              if (r['supersededBy'] != null &&
                                  (r['supersededBy'] as String).isNotEmpty)
                                Padding(
                                  padding: const EdgeInsets.only(top: 4),
                                  child: Chip(
                                    avatar: const Icon(
                                      Icons.warning_amber,
                                      size: 14,
                                    ),
                                    label: Text(
                                      'Superseded by ${(r['supersededBy'] as String).substring(0, 8)}',
                                      style: const TextStyle(fontSize: 10),
                                    ),
                                  ),
                                ),
                            ],
                          ),
                        ),
                      );
                    },
                  ),
          ),
        ],
      ),
    );
  }
}
