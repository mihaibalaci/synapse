import 'dart:async';

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../services/api_service.dart';
import '../../services/refresh_bus.dart';

class MemoryPage extends StatefulWidget {
  const MemoryPage({super.key});

  @override
  State<MemoryPage> createState() => _MemoryPageState();
}

class _MemoryPageState extends State<MemoryPage>
    with SingleTickerProviderStateMixin {
  late final TabController _tab;
  final _searchController = TextEditingController();
  Timer? _debounce;
  String _query = '';

  List<dynamic> _chunks = [];
  List<dynamic> _facts = [];
  bool _loading = false;

  RefreshBus? _bus;
  int _lastTick = -1;

  @override
  void initState() {
    super.initState();
    _tab = TabController(length: 2, vsync: this);
    _tab.addListener(_onTabChanged);
    _load();
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final bus = context.read<RefreshBus>();
    if (_bus != bus) {
      _bus?.removeListener(_onRefresh);
      _bus = bus;
      _lastTick = bus.tick;
      bus.addListener(_onRefresh);
    }
  }

  void _onRefresh() {
    final bus = _bus;
    if (bus == null || bus.tick == _lastTick) return;
    _lastTick = bus.tick;
    _load();
  }

  void _onTabChanged() {
    if (!_tab.indexIsChanging) _load();
  }

  void _onSearchChanged(String value) {
    _debounce?.cancel();
    _debounce = Timer(const Duration(milliseconds: 400), () {
      setState(() => _query = value.trim());
      _load();
    });
  }

  Future<void> _load() async {
    if (!mounted) return;
    setState(() => _loading = true);
    final api = context.read<ApiService>();
    try {
      if (_tab.index == 0) {
        final params = _query.isEmpty
            ? ''
            : '&q=${Uri.encodeQueryComponent(_query)}';
        final data = await api.get('/api/v1/admin/chunks?limit=50$params');
        if (mounted) setState(() => _chunks = data['chunks'] as List? ?? []);
      } else {
        final params = _query.isEmpty
            ? ''
            : '&q=${Uri.encodeQueryComponent(_query)}';
        final data = await api.get('/api/v1/admin/facts?limit=50$params');
        if (mounted) setState(() => _facts = data['facts'] as List? ?? []);
      }
    } catch (_) {
      // Network errors are visible as empty results
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _deleteChunk(String id) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Archive chunk?'),
        content: const Text('This chunk will be excluded from search results.'),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx, false),
            child: const Text('Cancel'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(ctx, true),
            child: const Text('Archive'),
          ),
        ],
      ),
    );
    if (confirmed != true) return;
    if (!mounted) return;
    try {
      await context.read<ApiService>().delete('/api/v1/admin/chunks/$id');
      _load();
    } catch (_) {}
  }

  Future<void> _deleteFact(String id) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Supersede fact?'),
        content: const Text('This fact will be marked as no longer valid.'),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx, false),
            child: const Text('Cancel'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(ctx, true),
            child: const Text('Supersede'),
          ),
        ],
      ),
    );
    if (confirmed != true) return;
    if (!mounted) return;
    try {
      await context.read<ApiService>().delete('/api/v1/admin/facts/$id');
      _load();
    } catch (_) {}
  }

  @override
  void dispose() {
    _bus?.removeListener(_onRefresh);
    _debounce?.cancel();
    _searchController.dispose();
    _tab.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(24, 24, 24, 0),
          child: Row(
            children: [
              Text(
                'Memory Explorer',
                style: theme.textTheme.headlineSmall?.copyWith(
                  fontWeight: FontWeight.bold,
                ),
              ),
              const Spacer(),
              SizedBox(
                width: 300,
                child: TextField(
                  controller: _searchController,
                  onChanged: _onSearchChanged,
                  decoration: InputDecoration(
                    hintText: 'Search chunks and facts...',
                    prefixIcon: const Icon(Icons.search, size: 20),
                    isDense: true,
                    border: OutlineInputBorder(
                      borderRadius: BorderRadius.circular(8),
                    ),
                  ),
                ),
              ),
            ],
          ),
        ),
        TabBar(
          controller: _tab,
          isScrollable: true,
          tabs: const [
            Tab(text: 'Chunks'),
            Tab(text: 'Facts'),
          ],
        ),
        if (_loading) const LinearProgressIndicator(),
        Expanded(
          child: TabBarView(
            controller: _tab,
            children: [_buildChunksTab(theme), _buildFactsTab(theme)],
          ),
        ),
      ],
    );
  }

  Widget _buildChunksTab(ThemeData theme) {
    if (_chunks.isEmpty) {
      return const Center(child: Text('No chunks found'));
    }
    return ListView.builder(
      padding: const EdgeInsets.all(16),
      itemCount: _chunks.length,
      itemBuilder: (context, index) {
        final chunk = _chunks[index] as Map<String, dynamic>;
        return Card(
          margin: const EdgeInsets.only(bottom: 8),
          child: ListTile(
            title: Text(
              chunk['title'] ?? 'Untitled',
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
            ),
            subtitle: Text(
              chunk['contentPreview'] ?? '',
              maxLines: 2,
              overflow: TextOverflow.ellipsis,
            ),
            trailing: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                Chip(
                  label: Text(
                    chunk['type'] ?? '',
                    style: const TextStyle(fontSize: 11),
                  ),
                ),
                const SizedBox(width: 8),
                IconButton(
                  icon: const Icon(Icons.archive_outlined, size: 18),
                  tooltip: 'Archive',
                  onPressed: () => _deleteChunk(chunk['id']),
                ),
              ],
            ),
          ),
        );
      },
    );
  }

  Widget _buildFactsTab(ThemeData theme) {
    if (_facts.isEmpty) {
      return const Center(child: Text('No facts found'));
    }
    return ListView.builder(
      padding: const EdgeInsets.all(16),
      itemCount: _facts.length,
      itemBuilder: (context, index) {
        final fact = _facts[index] as Map<String, dynamic>;
        final entities = (fact['entities'] as List?)?.join(', ') ?? '';
        return Card(
          margin: const EdgeInsets.only(bottom: 8),
          child: ListTile(
            title: Text(
              fact['content'] ?? '',
              maxLines: 2,
              overflow: TextOverflow.ellipsis,
            ),
            subtitle: Text('${fact['type']} | $entities', maxLines: 1),
            trailing: IconButton(
              icon: const Icon(Icons.remove_circle_outline, size: 18),
              tooltip: 'Supersede',
              onPressed: () => _deleteFact(fact['id']),
            ),
          ),
        );
      },
    );
  }
}
