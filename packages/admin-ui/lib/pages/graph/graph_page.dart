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
    _loadAllNodes();
  }

  Future<void> _loadAllNodes() async {
    try {
      final data = await context.read<ApiService>().get(
        '/api/v1/admin/graph/important?limit=100',
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

  void _selectEntity(String name) {
    _entityController.text = name;
    setState(() => _activeTab = 'explore');
    _exploreEntity();
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
                if (_entityController.text.isNotEmpty) ...[
                  const SizedBox(width: 8),
                  IconButton(
                    icon: const Icon(Icons.clear),
                    onPressed: () {
                      _entityController.clear();
                      setState(() => _edges = []);
                    },
                  ),
                ],
              ],
            ),
            const SizedBox(height: 16),
            Expanded(
              child: _entityController.text.isEmpty && _edges.isEmpty
                  ? _buildMindMap(theme)
                  : _edges.isEmpty
                  ? const Center(child: Text('No connections found'))
                  : ListView.builder(
                      itemCount: _edges.length,
                      itemBuilder: (_, i) {
                        final e = _edges[i] as Map<String, dynamic>;
                        return ListTile(
                          leading: const Icon(Icons.link, size: 18),
                          title: Text(e['neighbor'] ?? ''),
                          subtitle: Text(
                            '${e['relation']} (weight: ${e['weight']})',
                          ),
                          onTap: () => _selectEntity(e['neighbor'] ?? ''),
                        );
                      },
                    ),
            ),
          ],
        );
    }
  }

  Widget _buildMindMap(ThemeData theme) {
    if (_important.isEmpty) {
      return const Center(
        child: Text(
          'No graph data yet.\nCapture sessions to build the knowledge graph.',
          textAlign: TextAlign.center,
        ),
      );
    }
    final maxWeight = _important.fold<double>(1, (prev, e) {
      final w = ((e as Map)['totalWeight'] as num?)?.toDouble() ?? 1;
      return w > prev ? w : prev;
    });
    return SingleChildScrollView(
      child: Padding(
        padding: const EdgeInsets.all(8),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              '${_important.length} entities in the knowledge graph. Click to explore:',
              style: theme.textTheme.bodyMedium,
            ),
            const SizedBox(height: 16),
            Wrap(
              spacing: 6,
              runSpacing: 6,
              children: _important.map((e) {
                final entity = e as Map<String, dynamic>;
                final name = entity['name'] as String? ?? '';
                final weight = (entity['totalWeight'] as num?)?.toDouble() ?? 1;
                final normalized = (weight / maxWeight).clamp(0.2, 1.0);
                final fontSize = 11.0 + (normalized * 8);
                return ActionChip(
                  label: Text(name, style: TextStyle(fontSize: fontSize)),
                  backgroundColor: theme.colorScheme.primaryContainer
                      .withValues(alpha: normalized),
                  side: BorderSide(
                    color: theme.colorScheme.primary.withValues(
                      alpha: normalized * 0.5,
                    ),
                  ),
                  onPressed: () => _selectEntity(name),
                );
              }).toList(),
            ),
          ],
        ),
      ),
    );
  }
}
