import 'dart:async';
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../../services/api_service.dart';
import '../../services/refresh_bus.dart';

class OperationsPage extends StatefulWidget {
  const OperationsPage({super.key});
  @override
  State<OperationsPage> createState() => _OperationsPageState();
}

class _OperationsPageState extends State<OperationsPage> {
  List<dynamic> _queues = [];
  List<dynamic> _deadLetters = [];
  List<dynamic> _jobs = [];
  Map<String, dynamic> _backup = {};
  List<dynamic> _audit = [];
  bool _loading = false;
  RefreshBus? _bus;
  int _lastTick = -1;

  @override
  void initState() {
    super.initState();
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
    if (_bus != null && _bus!.tick != _lastTick) {
      _lastTick = _bus!.tick;
      _load();
    }
  }

  Future<void> _load() async {
    setState(() => _loading = true);
    final api = context.read<ApiService>();
    try {
      final results = await Future.wait([
        api.get('/api/v1/admin/queues').catchError((_) => <String, dynamic>{}),
        api
            .get('/api/v1/admin/dead-letters?limit=10')
            .catchError((_) => <String, dynamic>{}),
        api
            .get('/api/v1/admin/jobs?limit=20')
            .catchError((_) => <String, dynamic>{}),
        api
            .get('/api/v1/admin/backup-status')
            .catchError((_) => <String, dynamic>{}),
        api
            .get('/api/v1/admin/audit?limit=20')
            .catchError((_) => <String, dynamic>{}),
      ]);
      if (mounted) {
        setState(() {
          _queues = results[0]['queues'] as List? ?? [];
          _deadLetters = results[1]['items'] as List? ?? [];
          _jobs = results[2]['jobs'] as List? ?? [];
          _backup = results[3] as Map<String, dynamic>? ?? {};
          _audit = results[4]['entries'] as List? ?? [];
        });
      }
    } catch (_) {}
    if (mounted) setState(() => _loading = false);
  }

  Future<void> _retryDeadLetters() async {
    try {
      await context.read<ApiService>().post(
        '/api/v1/admin/dead-letters/retry',
        {'limit': 10},
      );
      _load();
    } catch (_) {}
  }

  @override
  void dispose() {
    _bus?.removeListener(_onRefresh);
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return SingleChildScrollView(
      padding: const EdgeInsets.all(24),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            'Operations',
            style: theme.textTheme.headlineSmall?.copyWith(
              fontWeight: FontWeight.bold,
            ),
          ),
          if (_loading) const LinearProgressIndicator(),
          const SizedBox(height: 20),
          Text('Queue Status', style: theme.textTheme.titleMedium),
          const SizedBox(height: 8),
          Wrap(
            spacing: 12,
            runSpacing: 12,
            children: _queues.map((q) {
              final m = q as Map<String, dynamic>;
              return SizedBox(
                width: 200,
                child: Card(
                  child: Padding(
                    padding: const EdgeInsets.all(12),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          (m['name'] as String? ?? '').replaceAll(
                            'synapse:',
                            '',
                          ),
                          style: theme.textTheme.labelLarge,
                        ),
                        Text('Depth: ${m['depth'] ?? 0}'),
                        Text(
                          'Dead: ${m['deadCount'] ?? 0}',
                          style: TextStyle(
                            color: (m['deadCount'] as int? ?? 0) > 0
                                ? Colors.red
                                : null,
                          ),
                        ),
                      ],
                    ),
                  ),
                ),
              );
            }).toList(),
          ),
          if (_deadLetters.isNotEmpty) ...[
            const SizedBox(height: 20),
            Row(
              children: [
                Text(
                  'Dead Letters (${_deadLetters.length})',
                  style: theme.textTheme.titleMedium,
                ),
                const SizedBox(width: 12),
                FilledButton.tonal(
                  onPressed: _retryDeadLetters,
                  child: const Text('Retry All'),
                ),
              ],
            ),
            const SizedBox(height: 8),
            ...(_deadLetters
                .take(5)
                .map(
                  (d) => Card(
                    child: Padding(
                      padding: const EdgeInsets.all(8),
                      child: Text(
                        d.toString(),
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                        style: theme.textTheme.bodySmall,
                      ),
                    ),
                  ),
                )),
          ],
          const SizedBox(height: 24),
          Text('Recent Jobs', style: theme.textTheme.titleMedium),
          const SizedBox(height: 8),
          if (_jobs.isEmpty)
            const Text('No recent jobs')
          else
            ...(_jobs.take(10).map((j) {
              final m = j as Map<String, dynamic>;
              return ListTile(
                dense: true,
                title: Text(
                  '${m['sessionId'] ?? ''}',
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                ),
                subtitle: Text(
                  '${m['status']} | ${m['searchableStatus']} | ${m['totalTokens']} tokens',
                ),
                trailing: Text(
                  m['developerId'] ?? '',
                  style: theme.textTheme.bodySmall,
                ),
              );
            })),
          const SizedBox(height: 24),
          Text('Database', style: theme.textTheme.titleMedium),
          const SizedBox(height: 8),
          if (_backup.isNotEmpty)
            Card(
              child: Padding(
                padding: const EdgeInsets.all(16),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      'Size: ${(_backup['database'] as Map?)?['size'] ?? 'unknown'}',
                    ),
                    Text(
                      'Tables: ${(_backup['database'] as Map?)?['tables'] ?? 0}',
                    ),
                    Text(
                      'Sessions: ${(_backup['counts'] as Map?)?['sessions'] ?? 0}',
                    ),
                    Text(
                      'Chunks: ${(_backup['counts'] as Map?)?['chunks'] ?? 0}',
                    ),
                    Text(
                      'Facts: ${(_backup['counts'] as Map?)?['facts'] ?? 0}',
                    ),
                  ],
                ),
              ),
            ),
          const SizedBox(height: 24),
          Text('Audit Log', style: theme.textTheme.titleMedium),
          const SizedBox(height: 8),
          if (_audit.isEmpty)
            const Text('No audit entries')
          else
            ...(_audit.take(10).map((a) {
              final m = a as Map<String, dynamic>;
              return ListTile(
                dense: true,
                title: Text(
                  '${m['action']} ${m['resourceType']}${(m['resourceId'] as String? ?? '').isNotEmpty ? ' (${m['resourceId']})' : ''}',
                ),
                subtitle: Text(
                  'by ${m['actorId'] ?? 'system'} • ${m['timestamp'] ?? ''}',
                ),
              );
            })),
        ],
      ),
    );
  }
}
