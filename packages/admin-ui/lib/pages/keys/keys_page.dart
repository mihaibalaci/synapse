import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:provider/provider.dart';
import '../../services/api_service.dart';

class ApiKeysPage extends StatefulWidget {
  const ApiKeysPage({super.key});
  @override
  State<ApiKeysPage> createState() => _ApiKeysPageState();
}

class _ApiKeysPageState extends State<ApiKeysPage> {
  List<dynamic> _keys = [];
  bool _loading = false;
  String? _newKey;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() => _loading = true);
    try {
      final data = await context.read<ApiService>().get('/api/v1/keys');
      if (mounted) setState(() => _keys = data['keys'] as List? ?? []);
    } catch (_) {}
    if (mounted) setState(() => _loading = false);
  }

  Future<void> _create() async {
    final name = await showDialog<String>(
      context: context,
      builder: (ctx) {
        final controller = TextEditingController(text: 'My API Key');
        return AlertDialog(
          title: const Text('Create API Key'),
          content: TextField(
            controller: controller,
            decoration: const InputDecoration(labelText: 'Key name'),
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(ctx),
              child: const Text('Cancel'),
            ),
            FilledButton(
              onPressed: () => Navigator.pop(ctx, controller.text),
              child: const Text('Create'),
            ),
          ],
        );
      },
    );
    if (name == null || name.isEmpty) return;
    if (!mounted) return;
    try {
      final data = await context.read<ApiService>().post('/api/v1/keys', {
        'name': name,
        'scopes': ['read', 'write'],
      });
      setState(() => _newKey = data['key'] as String?);
      _load();
    } catch (_) {}
  }

  Future<void> _revoke(String id) async {
    try {
      await context.read<ApiService>().delete('/api/v1/keys/$id');
      _load();
    } catch (_) {}
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Padding(
      padding: const EdgeInsets.all(24),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Text(
                'API Keys',
                style: theme.textTheme.headlineSmall?.copyWith(
                  fontWeight: FontWeight.bold,
                ),
              ),
              const Spacer(),
              FilledButton.icon(
                onPressed: _create,
                icon: const Icon(Icons.add),
                label: const Text('Create Key'),
              ),
            ],
          ),
          if (_newKey != null) ...[
            const SizedBox(height: 12),
            Card(
              color: theme.colorScheme.primaryContainer,
              child: Padding(
                padding: const EdgeInsets.all(16),
                child: Row(
                  children: [
                    Expanded(
                      child: SelectableText(
                        _newKey!,
                        style: const TextStyle(
                          fontFamily: 'monospace',
                          fontSize: 12,
                        ),
                      ),
                    ),
                    IconButton(
                      icon: const Icon(Icons.copy),
                      onPressed: () {
                        Clipboard.setData(ClipboardData(text: _newKey!));
                        ScaffoldMessenger.of(context).showSnackBar(
                          const SnackBar(content: Text('Copied!')),
                        );
                      },
                    ),
                    IconButton(
                      icon: const Icon(Icons.close),
                      onPressed: () => setState(() => _newKey = null),
                    ),
                  ],
                ),
              ),
            ),
            const SizedBox(height: 4),
            Text(
              'Save this key now. It cannot be shown again.',
              style: theme.textTheme.bodySmall?.copyWith(
                color: theme.colorScheme.error,
              ),
            ),
          ],
          const SizedBox(height: 16),
          if (_loading) const LinearProgressIndicator(),
          Expanded(
            child: _keys.isEmpty
                ? const Center(child: Text('No API keys'))
                : ListView.builder(
                    itemCount: _keys.length,
                    itemBuilder: (ctx, i) {
                      final k = _keys[i] as Map<String, dynamic>;
                      return Card(
                        child: ListTile(
                          title: Text(k['name'] ?? 'Unnamed'),
                          subtitle: Text(
                            '${k['keyPrefix']}... • ${(k['scopes'] as List?)?.join(', ') ?? ''} • Created: ${k['createdAt'] ?? ''}',
                          ),
                          trailing: IconButton(
                            icon: const Icon(Icons.delete_outline),
                            onPressed: () => _revoke(k['id']),
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
