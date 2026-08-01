import 'dart:async';
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../../services/api_service.dart';

class GraphPage extends StatefulWidget {
  const GraphPage({super.key});
  @override
  State<GraphPage> createState() => _GraphPageState();
}

class _GraphPageState extends State<GraphPage> {
  final _entityController = TextEditingController();
  final _fromController = TextEditingController();
  final _toController = TextEditingController();
  List<dynamic> _edges = [];
  List<dynamic> _important = [];
  List<dynamic> _paths = [];
  bool _loading = false;
  String _activeTab = 'explore';

  @override
  void initState() {
    super.initState();
    _loadImportant();
  }

  Future<void> _loadImportant() async {
    try {
      final data = await context.read<ApiService>().get(
        '/api/v1/admin/graph/important?limit=20',
      );
      if (mounted) setState(() => _important = data['entities'] as List? ?? []);
    } catch (_) {}
  }

  Future<void> _exploreEntity() async {
    final entity = _entityController.text.trim();
    if (entity.isEmpty) return;
    setState(() => _loading = true);
    try {
      final data = await context.read<ApiService>().get(
        '/api/v1/admin/graph/entity/${Uri.encodeComponent(entity)}',
      );
      if (mounted) setState(() => _edges = data['edges'] as List? ?? []);
    } catch (_) {
      if (mounted) setState(() => _edges = []);
    }
    if (mounted) setState(() => _loading = false);
  }

  Future<void> _findPath() async {
    final from = _fromController.text.trim();
    final to = _toController.text.trim();
    if (from.isEmpty || to.isEmpty) return;
    setState(() => _loading = true);
    try {
      final data = await context.read<ApiService>().get(
        '/api/v1/admin/graph/path?from=${Uri.encodeComponent(from)}&to=${Uri.encodeComponent(to)}',
      );
      if (mounted) setState(() => _paths = data['paths'] as List? ?? []);
    } catch (_) {
      if (mounted) setState(() => _paths = []);
    }
    if (mounted) setState(() => _loading = false);
  }

  @override
  void dispose() {
    _entityController.dispose();
    _fromController.dispose();
    _toController.dispose();
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
            'Knowledge Graph',
            style: theme.textTheme.headlineSmall?.copyWith(
              fontWeight: FontWeight.bold,
            ),
          ),
          const SizedBox(height: 16),
          Row(
            children: [
              ChoiceChip(
                label: const Text('Explore'),
                selected: _activeTab == 'explore',
                onSelected: (_) => setState(() => _activeTab = 'explore'),
              ),
              const SizedBox(width: 8),
              ChoiceChip(
                label: const Text('Path'),
                selected: _activeTab == 'path',
                onSelected: (_) => setState(() => _activeTab = 'path'),
              ),
              const SizedBox(width: 8),
              ChoiceChip(
                label: const Text('Important'),
                selected: _activeTab == 'important',
                onSelected: (_) => setState(() => _activeTab = 'important'),
              ),
            ],
          ),
          const SizedBox(height: 16),
          if (_loading) const LinearProgressIndicator(),
          Expanded(child: _buildTab(theme)),
        ],
      ),
    );
  }

  Widget _buildTab(ThemeData theme) {
    switch (_activeTab) {
      case 'path':
        return Column(
          children: [
            Row(
              children: [
                Expanded(
                  child: TextField(
                    controller: _fromController,
                    decoration: const InputDecoration(
                      labelText: 'From entity',
                      isDense: true,
                    ),
                  ),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: TextField(
                    controller: _toController,
                    decoration: const InputDecoration(
                      labelText: 'To entity',
                      isDense: true,
                    ),
                  ),
                ),
                const SizedBox(width: 12),
                FilledButton(
                  onPressed: _findPath,
                  child: const Text('Find Path'),
                ),
              ],
            ),
            const SizedBox(height: 16),
            Expanded(
              child: _paths.isEmpty
                  ? const Center(
                      child: Text(
                        'Enter two entities to find connection paths',
                      ),
                    )
                  : ListView.builder(
                      itemCount: _paths.length,
                      itemBuilder: (_, i) {
                        final path = (_paths[i] as List).cast<String>();
                        return Card(
                          child: Padding(
                            padding: const EdgeInsets.all(12),
                            child: Text(
                              path.join(' → '),
                              style: theme.textTheme.bodyMedium,
                            ),
                          ),
                        );
                      },
                    ),
            ),
          ],
        );
      case 'important':
        return _important.isEmpty
            ? const Center(child: Text('No graph data yet'))
            : ListView.builder(
                itemCount: _important.length,
                itemBuilder: (_, i) {
                  final e = _important[i] as Map<String, dynamic>;
                  return ListTile(
                    leading: CircleAvatar(child: Text('${i + 1}')),
                    title: Text(e['name'] ?? ''),
                    subtitle: Text(
                      'Weight: ${e['totalWeight']} • Edges: ${e['edgeCount']}',
                    ),
                  );
                },
              );
      default:
        return Column(
          children: [
            Row(
              children: [
                Expanded(
                  child: TextField(
                    controller: _entityController,
                    decoration: const InputDecoration(
                      labelText: 'Entity name',
                      isDense: true,
                    ),
                    onSubmitted: (_) => _exploreEntity(),
                  ),
                ),
                const SizedBox(width: 12),
                FilledButton(
                  onPressed: _exploreEntity,
                  child: const Text('Explore'),
                ),
              ],
            ),
            const SizedBox(height: 16),
            Expanded(
              child: _edges.isEmpty
                  ? const Center(
                      child: Text('Enter an entity name to see connections'),
                    )
                  : ListView.builder(
                      itemCount: _edges.length,
                      itemBuilder: (_, i) {
                        final e = _edges[i] as Map<String, dynamic>;
                        return ListTile(
                          title: Text(e['neighbor'] ?? ''),
                          subtitle: Text(
                            '${e['relation']} (weight: ${e['weight']})',
                          ),
                          onTap: () {
                            _entityController.text = e['neighbor'] ?? '';
                            _exploreEntity();
                          },
                        );
                      },
                    ),
            ),
          ],
        );
    }
  }
}
