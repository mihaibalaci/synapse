import 'dart:async';
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../../services/api_service.dart';
import '../../services/refresh_bus.dart';

class SystemPage extends StatefulWidget {
  const SystemPage({super.key});

  @override
  State<SystemPage> createState() => _SystemPageState();
}

class _SystemPageState extends State<SystemPage> {
  Map<String, dynamic>? _health;
  Map<String, dynamic>? _stats;
  Timer? _timer;
  RefreshBus? _bus;
  int _lastTick = -1;

  @override
  void initState() {
    super.initState();
    _refresh();
    _timer = Timer.periodic(const Duration(seconds: 5), (_) => _refresh());
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final bus = context.read<RefreshBus>();
    if (_bus != bus) {
      _bus?.removeListener(_onRefreshRequested);
      _bus = bus;
      _lastTick = bus.tick;
      bus.addListener(_onRefreshRequested);
    }
  }

  void _onRefreshRequested() {
    final bus = _bus;
    if (bus == null || bus.tick == _lastTick) return;
    _lastTick = bus.tick;
    _refresh();
  }

  @override
  void dispose() {
    _bus?.removeListener(_onRefreshRequested);
    _timer?.cancel();
    super.dispose();
  }

  Future<void> _refresh() async {
    final api = context.read<ApiService>();
    try {
      final results = await Future.wait([
        api.getHealth().catchError((_) => <String, dynamic>{}),
        api.getStats().catchError((_) => <String, dynamic>{}),
      ]);
      if (mounted) {
        setState(() {
          _health = results[0];
          _stats = results[1];
        });
      }
    } catch (_) {}
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colorScheme = theme.colorScheme;
    final checks = (_health?['checks'] as Map?) ?? {};

    return SingleChildScrollView(
      padding: const EdgeInsets.all(24),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            'System Components',
            style: theme.textTheme.headlineSmall?.copyWith(
              fontWeight: FontWeight.bold,
            ),
          ),
          const SizedBox(height: 4),
          Text(
            'Infrastructure health and component topology',
            style: theme.textTheme.bodyMedium?.copyWith(
              color: colorScheme.onSurface.withValues(alpha: 0.6),
            ),
          ),
          const SizedBox(height: 24),

          // Component cards
          Wrap(
            spacing: 16,
            runSpacing: 16,
            children: [
              _ComponentCard(
                name: 'PostgreSQL 16',
                description: 'pgvector + full-text search',
                icon: Icons.storage,
                status: checks['database'] == 'ok'
                    ? 'Connected'
                    : 'Disconnected',
                healthy: checks['database'] == 'ok',
                details: [
                  'Chunks: ${_stats?['counts']?['chunks'] ?? '—'}',
                  'Facts: ${_stats?['counts']?['facts'] ?? '—'}',
                  'Graph: ${_stats?['counts']?['graphNodes'] ?? '—'} nodes',
                ],
              ),
              _ComponentCard(
                name: 'Redis 7',
                description: 'Lists + cache + rate limits',
                icon: Icons.bolt,
                status: checks['redis'] == 'ok' ? 'Connected' : 'Disconnected',
                healthy: checks['redis'] == 'ok',
                details: [
                  'Queue depth: ${_stats?['queues']?['total'] ?? '—'}',
                  'Role: cache + job queue',
                ],
              ),
              _ComponentCard(
                name: 'Object Storage',
                description: 'S3-compatible (MinIO)',
                icon: Icons.cloud_outlined,
                status: checks['objectStorage'] == 'ok'
                    ? 'Connected'
                    : 'Disconnected',
                healthy: checks['objectStorage'] == 'ok',
                details: [
                  'Bucket: synapse-raw',
                  'Sessions: ${_stats?['counts']?['sessions'] ?? '—'}',
                ],
              ),
              _ComponentCard(
                name: 'API Server',
                description: 'Go + chi + JWT',
                icon: Icons.api,
                status: _health?['status'] == 'ready' ? 'Running' : 'Down',
                healthy: _health?['status'] == 'ready',
                details: [
                  'Port: 3000',
                  '3-signal retrieval',
                  'Dependency-aware readiness',
                ],
              ),
              _ComponentCard(
                name: 'Worker Service',
                description: 'Redis list consumers + recovery',
                icon: Icons.settings_suggest,
                status: checks['queue'] == 'ok' ? 'Running' : 'Down',
                healthy: checks['queue'] == 'ok',
                details: [
                  'Concurrency: configured by WORKER_CONCURRENCY',
                  'Pipeline: segment, embed, facts, index',
                  'Recovery: retries, dead letters, reaper',
                ],
              ),
              _ComponentCard(
                name: 'Learning Loop',
                description: 'Reflect and write-back are planned',
                icon: Icons.auto_awesome,
                status: 'Planned',
                healthy: false,
                details: [
                  'Current: heuristic fact extraction',
                  'Reflect: placeholder response',
                  'Compaction: disabled no-op',
                ],
              ),
            ],
          ),
          const SizedBox(height: 32),

          // Architecture diagram
          Card(
            child: Padding(
              padding: const EdgeInsets.all(24),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    'Data Flow',
                    style: theme.textTheme.titleMedium?.copyWith(
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                  const SizedBox(height: 16),
                  _DataFlowDiagram(),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _ComponentCard extends StatelessWidget {
  final String name;
  final String description;
  final IconData icon;
  final String status;
  final bool healthy;
  final List<String> details;

  const _ComponentCard({
    required this.name,
    required this.description,
    required this.icon,
    required this.status,
    required this.healthy,
    required this.details,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final color = healthy ? Colors.green : Colors.red;

    return SizedBox(
      width: 280,
      child: Card(
        child: Padding(
          padding: const EdgeInsets.all(20),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  Container(
                    padding: const EdgeInsets.all(8),
                    decoration: BoxDecoration(
                      color: color.withValues(alpha: 0.1),
                      borderRadius: BorderRadius.circular(8),
                    ),
                    child: Icon(icon, size: 20, color: color),
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          name,
                          style: theme.textTheme.titleSmall?.copyWith(
                            fontWeight: FontWeight.w600,
                          ),
                        ),
                        Text(
                          description,
                          style: theme.textTheme.bodySmall?.copyWith(
                            color: theme.colorScheme.onSurface.withValues(
                              alpha: 0.5,
                            ),
                          ),
                        ),
                      ],
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 12),
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                decoration: BoxDecoration(
                  color: color.withValues(alpha: 0.1),
                  borderRadius: BorderRadius.circular(4),
                ),
                child: Text(
                  status,
                  style: TextStyle(
                    fontSize: 11,
                    color: color,
                    fontWeight: FontWeight.w600,
                  ),
                ),
              ),
              const SizedBox(height: 12),
              ...details.map(
                (d) => Padding(
                  padding: const EdgeInsets.only(bottom: 4),
                  child: Text(
                    '  $d',
                    style: theme.textTheme.bodySmall?.copyWith(
                      color: theme.colorScheme.onSurface.withValues(alpha: 0.6),
                    ),
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _DataFlowDiagram extends StatelessWidget {
  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);

    final writeSteps = [
      'Capture',
      'S3 PUT',
      'Queue',
      'Segment',
      'Embed',
      'Facts',
      'Dedup',
      'Graph',
      'Contradictions',
      'Index',
    ];
    final readSteps = [
      'Query',
      'Embed',
      '4-Signal Search',
      'RRF Fusion',
      'Adaptive Rank',
      'Results',
    ];

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text('Write Path (Ingestion)', style: theme.textTheme.labelLarge),
        const SizedBox(height: 8),
        SingleChildScrollView(
          scrollDirection: Axis.horizontal,
          child: Row(
            children: _buildStepRow(
              theme,
              writeSteps,
              theme.colorScheme.primary,
            ),
          ),
        ),
        const SizedBox(height: 20),
        Text('Read Path (Retrieval)', style: theme.textTheme.labelLarge),
        const SizedBox(height: 8),
        SingleChildScrollView(
          scrollDirection: Axis.horizontal,
          child: Row(children: _buildStepRow(theme, readSteps, Colors.green)),
        ),
        const SizedBox(height: 20),
        Text(
          'Cost Optimization (every LLM call)',
          style: theme.textTheme.labelLarge,
        ),
        const SizedBox(height: 8),
        SingleChildScrollView(
          scrollDirection: Axis.horizontal,
          child: Row(
            children: _buildStepRow(theme, [
              'Compress',
              'Verbosity Steer',
              'Effort Route',
              'LLM',
              'Terse Output',
            ], Colors.purple),
          ),
        ),
        const SizedBox(height: 20),
        Text('Intelligence (Background)', style: theme.textTheme.labelLarge),
        const SizedBox(height: 8),
        SingleChildScrollView(
          scrollDirection: Axis.horizontal,
          child: Row(
            children: _buildStepRow(theme, [
              'Compaction',
              'Contradictions',
              'Confidence Decay',
              'Feedback → Weights',
              'Session Learning',
            ], Colors.orange),
          ),
        ),
        const SizedBox(height: 12),
        Text(
          'Every LLM call is cost-optimized (30-60% fewer tokens). Knowledge quality improves over time '
          'via contradiction detection, confidence calibration, and adaptive ranking from feedback.',
          style: theme.textTheme.bodySmall?.copyWith(
            color: theme.colorScheme.onSurfaceVariant,
          ),
        ),
      ],
    );
  }

  List<Widget> _buildStepRow(ThemeData theme, List<String> steps, Color color) {
    return steps.asMap().entries.map((entry) {
      final i = entry.key;
      final step = entry.value;
      return Row(
        children: [
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
            decoration: BoxDecoration(
              color: color.withValues(alpha: 0.1),
              borderRadius: BorderRadius.circular(6),
              border: Border.all(color: color.withValues(alpha: 0.3)),
            ),
            child: Text(
              step,
              style: TextStyle(
                fontSize: 11,
                color: color,
                fontWeight: FontWeight.w500,
              ),
            ),
          ),
          if (i < steps.length - 1)
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 3),
              child: Icon(
                Icons.arrow_forward,
                size: 12,
                color: color.withValues(alpha: 0.5),
              ),
            ),
        ],
      );
    }).toList();
  }
}
