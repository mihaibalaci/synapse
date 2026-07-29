import 'dart:async';
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../../services/api_service.dart';
import '../../widgets/stat_card.dart';

class DashboardPage extends StatefulWidget {
  const DashboardPage({super.key});

  @override
  State<DashboardPage> createState() => _DashboardPageState();
}

class _DashboardPageState extends State<DashboardPage> {
  Map<String, dynamic>? _stats;
  Map<String, dynamic>? _health;
  Map<String, dynamic>? _learning;
  String? _error;
  Timer? _timer;

  @override
  void initState() {
    super.initState();
    _refresh();
    _timer = Timer.periodic(const Duration(seconds: 5), (_) => _refresh());
  }

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }

  Future<void> _refresh() async {
    final api = context.read<ApiService>();
    try {
      final results = await Future.wait([
        api.getStats().catchError((_) => <String, dynamic>{}),
        api.getHealth().catchError((_) => <String, dynamic>{}),
        api.getLearningMetrics().catchError((_) => <String, dynamic>{}),
      ]);
      if (mounted) {
        setState(() {
          _stats = results[0];
          _health = results[1];
          _learning = results[2];
          _error = null;
        });
      }
    } catch (e) {
      if (mounted) setState(() => _error = e.toString());
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colorScheme = theme.colorScheme;

    return SingleChildScrollView(
      padding: const EdgeInsets.all(24),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          // Header
          Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text('Live Dashboard', style: theme.textTheme.headlineSmall?.copyWith(fontWeight: FontWeight.bold)),
                  const SizedBox(height: 4),
                  Text(
                    'Real-time system state, sessions, and learning activity',
                    style: theme.textTheme.bodyMedium?.copyWith(color: colorScheme.onSurface.withValues(alpha: 0.6)),
                  ),
                ],
              ),
              _StatusChip(healthy: _health?['status'] == 'ready'),
            ],
          ),
          const SizedBox(height: 24),

          if (_error != null)
            Container(
              padding: const EdgeInsets.all(12),
              margin: const EdgeInsets.only(bottom: 16),
              decoration: BoxDecoration(
                color: colorScheme.errorContainer,
                borderRadius: BorderRadius.circular(8),
              ),
              child: Text(_error!, style: TextStyle(color: colorScheme.onErrorContainer)),
            ),

          // Main stat cards
          _buildStatGrid(),
          const SizedBox(height: 24),

          // Live sessions + Learning Loop side by side
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Expanded(flex: 3, child: _buildSessionsFeed()),
              const SizedBox(width: 16),
              Expanded(flex: 2, child: _buildLearningPanel()),
            ],
          ),
          const SizedBox(height: 24),

          // Infrastructure + Queues
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Expanded(child: _buildInfraPanel()),
              const SizedBox(width: 16),
              Expanded(child: _buildQueuePanel()),
            ],
          ),
          const SizedBox(height: 24),

          // Trending Topics (Convergence Detection)
          _buildTrendingPanel(),
          const SizedBox(height: 24),

          // Data Sources
          _buildDataSourcesPanel(),
        ],
      ),
    );
  }

  Widget _buildStatGrid() {
    final counts = _stats?['counts'] ?? {};
    final processing = _stats?['processing'] ?? {};
    final isLearning = _learning?['metrics']?['health']?['isLearning'] ?? false;

    return Wrap(
      spacing: 12,
      runSpacing: 12,
      children: [
        SizedBox(
          width: 180,
          child: StatCard(
            icon: Icons.chat_bubble_outline,
            label: 'Sessions',
            value: '${counts['sessions'] ?? 0}',
            subtitle: '${processing['activeSessions'] ?? 0} processing',
            iconColor: Colors.blue,
          ),
        ),
        SizedBox(
          width: 180,
          child: StatCard(
            icon: Icons.layers_outlined,
            label: 'Chunks',
            value: '${counts['chunks'] ?? 0}',
            subtitle: '${counts['searchableChunks'] ?? 0} searchable',
            iconColor: Colors.teal,
          ),
        ),
        SizedBox(
          width: 180,
          child: StatCard(
            icon: Icons.lightbulb_outline,
            label: 'Facts',
            value: '${counts['facts'] ?? 0}',
            iconColor: Colors.amber,
          ),
        ),
        SizedBox(
          width: 180,
          child: StatCard(
            icon: Icons.hub_outlined,
            label: 'Graph Nodes',
            value: '${counts['graphNodes'] ?? 0}',
            iconColor: Colors.purple,
          ),
        ),
        SizedBox(
          width: 180,
          child: StatCard(
            icon: Icons.auto_awesome,
            label: 'Learning',
            value: isLearning ? 'Active' : 'Idle',
            valueColor: isLearning ? Colors.green : Colors.grey,
            subtitle: isLearning ? 'Writing insights' : 'No recent activity',
            iconColor: Colors.indigo,
          ),
        ),
      ],
    );
  }

  Widget _buildSessionsFeed() {
    final theme = Theme.of(context);
    final colorScheme = theme.colorScheme;
    final sessions = (_stats?['recentActivity'] as List?) ?? [];

    return Card(
      child: Padding(
        padding: const EdgeInsets.all(20),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                Text('Live Sessions', style: theme.textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w600)),
                Container(
                  padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                  decoration: BoxDecoration(
                    color: Colors.blue.withValues(alpha: 0.1),
                    borderRadius: BorderRadius.circular(12),
                  ),
                  child: Text('${sessions.length}', style: TextStyle(color: Colors.blue[300], fontSize: 12, fontWeight: FontWeight.w600)),
                ),
              ],
            ),
            const SizedBox(height: 16),
            if (sessions.isEmpty)
              Center(
                child: Padding(
                  padding: const EdgeInsets.all(32),
                  child: Column(
                    children: [
                      Icon(Icons.inbox_rounded, size: 40, color: colorScheme.onSurface.withValues(alpha: 0.2)),
                      const SizedBox(height: 8),
                      Text('No recent sessions', style: TextStyle(color: colorScheme.onSurface.withValues(alpha: 0.4))),
                    ],
                  ),
                ),
              )
            else
              ...sessions.take(10).map((s) => _SessionRow(session: s)),
          ],
        ),
      ),
    );
  }

  Widget _buildLearningPanel() {
    final theme = Theme.of(context);
    final metrics = _learning?['metrics'];
    final inline = metrics?['inline'] ?? {};
    final reflect = metrics?['reflect'] ?? {};

    return Card(
      child: Padding(
        padding: const EdgeInsets.all(20),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('Learning Loop', style: theme.textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w600)),
            const SizedBox(height: 4),
            Text('Last 7 days', style: theme.textTheme.bodySmall?.copyWith(color: theme.colorScheme.onSurface.withValues(alpha: 0.5))),
            const SizedBox(height: 20),
            _LearningMetric(label: 'Facts Extracted', value: inline['factsExtracted'] ?? 0, color: Colors.blue),
            _LearningMetric(label: 'Opinions Reinforced', value: inline['opinionsReinforced'] ?? 0, color: Colors.green),
            _LearningMetric(label: 'Opinions Contradicted', value: inline['opinionsContradicted'] ?? 0, color: Colors.red),
            _LearningMetric(label: 'Insights Written Back', value: reflect['insightsWrittenBack'] ?? 0, color: Colors.teal),
            _LearningMetric(label: 'Sources Boosted', value: reflect['sourcesBosted'] ?? 0, color: Colors.purple),
            const SizedBox(height: 16),
            const Divider(),
            const SizedBox(height: 12),
            // Confidence trend
            Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                Text('Confidence', style: theme.textTheme.bodySmall),
                Text(
                  '${((metrics?['health']?['confidenceTrend'] ?? 0) * 100).toStringAsFixed(0)}%',
                  style: theme.textTheme.bodySmall?.copyWith(fontWeight: FontWeight.bold),
                ),
              ],
            ),
            const SizedBox(height: 8),
            Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                Text('Coverage', style: theme.textTheme.bodySmall),
                Text(
                  '${((metrics?['health']?['observationCoverage'] ?? 0) * 100).toStringAsFixed(0)}%',
                  style: theme.textTheme.bodySmall?.copyWith(fontWeight: FontWeight.bold),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildInfraPanel() {
    final theme = Theme.of(context);
    final checks = (_health?['checks'] as Map?) ?? {};

    return Card(
      child: Padding(
        padding: const EdgeInsets.all(20),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('Infrastructure', style: theme.textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w600)),
            const SizedBox(height: 16),
            ...checks.entries.map((e) => Padding(
                  padding: const EdgeInsets.only(bottom: 12),
                  child: Row(
                    children: [
                      Container(
                        width: 10,
                        height: 10,
                        decoration: BoxDecoration(
                          color: e.value == 'ok' ? Colors.green : Colors.red,
                          shape: BoxShape.circle,
                        ),
                      ),
                      const SizedBox(width: 12),
                      Text(
                        (e.key as String).replaceAll(RegExp(r'([A-Z])'), ' \$1').trimLeft(),
                        style: theme.textTheme.bodyMedium,
                      ),
                      const Spacer(),
                      Text(
                        e.value == 'ok' ? 'Connected' : e.value.toString(),
                        style: TextStyle(
                          color: e.value == 'ok' ? Colors.green[300] : Colors.red[300],
                          fontWeight: FontWeight.w500,
                          fontSize: 13,
                        ),
                      ),
                    ],
                  ),
                )),
          ],
        ),
      ),
    );
  }

  Widget _buildQueuePanel() {
    final theme = Theme.of(context);
    final queues = _stats?['queues'] ?? {};

    final queueItems = <MapEntry<String, int>>[
      MapEntry('Sessions', queues['sessionProcessing'] ?? 0),
      MapEntry('Facts', queues['factExtraction'] ?? 0),
      MapEntry('Knowledge', queues['knowledgeExtraction'] ?? 0),
      MapEntry('Dedup', queues['deduplication'] ?? 0),
      MapEntry('Graph', queues['graphIndexing'] ?? 0),
      MapEntry('Search', queues['searchIndexing'] ?? 0),
      MapEntry('Capture', queues['captureProcessing'] ?? 0),
    ];

    return Card(
      child: Padding(
        padding: const EdgeInsets.all(20),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                Text('Queue Depths', style: theme.textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w600)),
                Text('Total: ${queues['total'] ?? 0}', style: theme.textTheme.bodySmall),
              ],
            ),
            const SizedBox(height: 16),
            ...queueItems.map((q) => Padding(
                  padding: const EdgeInsets.only(bottom: 8),
                  child: _QueueBar(name: q.key, depth: q.value),
                )),
          ],
        ),
      ),
    );
  }

  Widget _buildTrendingPanel() {
    final theme = Theme.of(context);

    // Mock trending data (in production, fetched from /api/v1/stats/trending)
    final trending = <Map<String, dynamic>>[];

    return Card(
      child: Padding(
        padding: const EdgeInsets.all(20),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                Row(
                  children: [
                    Icon(Icons.trending_up, size: 20, color: Colors.orange[300]),
                    const SizedBox(width: 8),
                    Text('Trending Topics', style: theme.textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w600)),
                  ],
                ),
                Container(
                  padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                  decoration: BoxDecoration(
                    color: Colors.orange.withValues(alpha: 0.1),
                    borderRadius: BorderRadius.circular(12),
                  ),
                  child: Text('${trending.length}', style: TextStyle(color: Colors.orange[300], fontSize: 12, fontWeight: FontWeight.w600)),
                ),
              ],
            ),
            const SizedBox(height: 4),
            Text(
              'Topics where 3+ engineers are converging (same question, same hour)',
              style: theme.textTheme.bodySmall?.copyWith(color: theme.colorScheme.onSurface.withValues(alpha: 0.5)),
            ),
            const SizedBox(height: 16),
            if (trending.isEmpty)
              Container(
                padding: const EdgeInsets.all(24),
                decoration: BoxDecoration(
                  color: theme.colorScheme.surfaceContainerHighest.withValues(alpha: 0.3),
                  borderRadius: BorderRadius.circular(8),
                ),
                child: Center(
                  child: Column(
                    children: [
                      Icon(Icons.explore_off, size: 32, color: theme.colorScheme.onSurface.withValues(alpha: 0.2)),
                      const SizedBox(height: 8),
                      Text(
                        'No convergence detected right now',
                        style: TextStyle(color: theme.colorScheme.onSurface.withValues(alpha: 0.4), fontSize: 13),
                      ),
                      const SizedBox(height: 4),
                      Text(
                        'When multiple engineers ask about the same topic, it will appear here',
                        style: TextStyle(color: theme.colorScheme.onSurface.withValues(alpha: 0.3), fontSize: 11),
                      ),
                    ],
                  ),
                ),
              )
            else
              ...trending.map((t) => _TrendingTopicRow(topic: t)),
          ],
        ),
      ),
    );
  }

  Widget _buildDataSourcesPanel() {
    final theme = Theme.of(context);

    // Data source definitions with icons, colors, and descriptions
    final sources = [
      _DataSource(
        name: 'Kiro',
        icon: Icons.code,
        color: Colors.indigo,
        type: 'IDE Plugin (MCP)',
        description: 'AI coding sessions captured via MCP server',
        status: 'active',
      ),
      _DataSource(
        name: 'Cursor',
        icon: Icons.edit_note,
        color: Colors.blue,
        type: 'IDE Plugin (MCP)',
        description: 'Cursor AI conversations, auto-captured',
        status: 'active',
      ),
      _DataSource(
        name: 'Claude Desktop',
        icon: Icons.smart_toy,
        color: Colors.amber,
        type: 'IDE Plugin (MCP)',
        description: 'Claude Desktop sessions via MCP',
        status: 'configured',
      ),
      _DataSource(
        name: 'Windsurf',
        icon: Icons.air,
        color: Colors.teal,
        type: 'IDE Plugin (MCP)',
        description: 'Windsurf AI sessions',
        status: 'configured',
      ),
      _DataSource(
        name: 'CLI',
        icon: Icons.terminal,
        color: Colors.green,
        type: 'Terminal Tool',
        description: 'synapse search / synapse insight commands',
        status: 'active',
      ),
      _DataSource(
        name: 'Slack Bot',
        icon: Icons.tag,
        color: Colors.purple,
        type: 'Chat Integration',
        description: '/synapse, @synapse, pin reactions',
        status: 'configured',
      ),
      _DataSource(
        name: 'Terminal Daemon',
        icon: Icons.monitor,
        color: Colors.orange,
        type: 'Ambient Capture',
        description: 'Background terminal output capture',
        status: 'planned',
      ),
      _DataSource(
        name: 'Browser Extension',
        icon: Icons.public,
        color: Colors.cyan,
        type: 'Ambient Capture',
        description: 'Documentation pages, Stack Overflow',
        status: 'planned',
      ),
      _DataSource(
        name: 'Git Hooks',
        icon: Icons.commit,
        color: Colors.red,
        type: 'VCS Integration',
        description: 'Commit messages, PR reviews',
        status: 'configured',
      ),
      _DataSource(
        name: 'Meeting Transcripts',
        icon: Icons.mic,
        color: Colors.pink,
        type: 'Ambient Capture',
        description: 'Zoom/Meet/Teams meeting captures',
        status: 'planned',
      ),
    ];

    return Card(
      child: Padding(
        padding: const EdgeInsets.all(20),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                Text('Data Sources', style: theme.textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w600)),
                Row(
                  children: [
                    _SourceStatusLegend(color: Colors.green, label: 'Active'),
                    const SizedBox(width: 12),
                    _SourceStatusLegend(color: Colors.blue, label: 'Configured'),
                    const SizedBox(width: 12),
                    _SourceStatusLegend(color: Colors.grey, label: 'Planned'),
                  ],
                ),
              ],
            ),
            const SizedBox(height: 4),
            Text(
              'Where knowledge flows into Synapse',
              style: theme.textTheme.bodySmall?.copyWith(color: theme.colorScheme.onSurface.withValues(alpha: 0.5)),
            ),
            const SizedBox(height: 20),
            Wrap(
              spacing: 12,
              runSpacing: 12,
              children: sources.map((s) => _DataSourceCard(source: s)).toList(),
            ),
          ],
        ),
      ),
    );
  }
}

// ─── Data Source Model ────────────────────────────────────────────────────────

class _DataSource {
  final String name;
  final IconData icon;
  final Color color;
  final String type;
  final String description;
  final String status; // active, configured, planned

  const _DataSource({
    required this.name,
    required this.icon,
    required this.color,
    required this.type,
    required this.description,
    required this.status,
  });
}

class _DataSourceCard extends StatelessWidget {
  final _DataSource source;
  const _DataSourceCard({super.key, required this.source});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final statusColor = switch (source.status) {
      'active' => Colors.green,
      'configured' => Colors.blue,
      _ => Colors.grey,
    };

    return Container(
      width: 200,
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: source.color.withValues(alpha: 0.04),
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: source.color.withValues(alpha: 0.15)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(source.icon, size: 18, color: source.color),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  source.name,
                  style: theme.textTheme.bodyMedium?.copyWith(fontWeight: FontWeight.w600),
                  overflow: TextOverflow.ellipsis,
                ),
              ),
              Container(
                width: 8,
                height: 8,
                decoration: BoxDecoration(
                  color: statusColor,
                  shape: BoxShape.circle,
                  boxShadow: source.status == 'active'
                      ? [BoxShadow(color: statusColor.withValues(alpha: 0.5), blurRadius: 4)]
                      : null,
                ),
              ),
            ],
          ),
          const SizedBox(height: 8),
          Text(
            source.type,
            style: TextStyle(fontSize: 10, color: source.color, fontWeight: FontWeight.w500),
          ),
          const SizedBox(height: 4),
          Text(
            source.description,
            style: theme.textTheme.bodySmall?.copyWith(
              color: theme.colorScheme.onSurface.withValues(alpha: 0.5),
              fontSize: 11,
            ),
            maxLines: 2,
            overflow: TextOverflow.ellipsis,
          ),
        ],
      ),
    );
  }
}

class _TrendingTopicRow extends StatelessWidget {
  final Map<String, dynamic> topic;
  const _TrendingTopicRow({required this.topic});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Container(
      padding: const EdgeInsets.symmetric(vertical: 10, horizontal: 12),
      margin: const EdgeInsets.only(bottom: 8),
      decoration: BoxDecoration(
        color: Colors.orange.withValues(alpha: 0.05),
        borderRadius: BorderRadius.circular(8),
        border: Border.all(color: Colors.orange.withValues(alpha: 0.15)),
      ),
      child: Row(
        children: [
          Container(
            padding: const EdgeInsets.all(6),
            decoration: BoxDecoration(
              color: Colors.orange.withValues(alpha: 0.15),
              borderRadius: BorderRadius.circular(6),
            ),
            child: Icon(Icons.people, size: 14, color: Colors.orange[300]),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(topic['topic'] ?? '', style: theme.textTheme.bodyMedium?.copyWith(fontWeight: FontWeight.w500)),
                Text('${topic['engineers'] ?? 0} engineers • ${topic['queries'] ?? 0} queries',
                    style: TextStyle(fontSize: 11, color: theme.colorScheme.onSurface.withValues(alpha: 0.5))),
              ],
            ),
          ),
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
            decoration: BoxDecoration(
              color: Colors.orange.withValues(alpha: 0.15),
              borderRadius: BorderRadius.circular(4),
            ),
            child: Text('LIVE', style: TextStyle(fontSize: 10, color: Colors.orange[300], fontWeight: FontWeight.w700)),
          ),
        ],
      ),
    );
  }
}

class _SourceStatusLegend extends StatelessWidget {
  final Color color;
  final String label;
  const _SourceStatusLegend({required this.color, required this.label});

  @override
  Widget build(BuildContext context) {
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        Container(width: 8, height: 8, decoration: BoxDecoration(color: color, shape: BoxShape.circle)),
        const SizedBox(width: 4),
        Text(label, style: TextStyle(fontSize: 11, color: Theme.of(context).colorScheme.onSurface.withValues(alpha: 0.6))),
      ],
    );
  }
}

// ─── Sub-widgets ─────────────────────────────────────────────────────────────

class _StatusChip extends StatelessWidget {
  final bool healthy;
  const _StatusChip({required this.healthy});

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
      decoration: BoxDecoration(
        color: (healthy ? Colors.green : Colors.red).withValues(alpha: 0.1),
        borderRadius: BorderRadius.circular(20),
        border: Border.all(color: (healthy ? Colors.green : Colors.red).withValues(alpha: 0.3)),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Container(
            width: 8,
            height: 8,
            decoration: BoxDecoration(
              color: healthy ? Colors.green : Colors.red,
              shape: BoxShape.circle,
            ),
          ),
          const SizedBox(width: 8),
          Text(
            healthy ? 'All Systems Online' : 'Degraded',
            style: TextStyle(
              color: healthy ? Colors.green[300] : Colors.red[300],
              fontSize: 12,
              fontWeight: FontWeight.w600,
            ),
          ),
        ],
      ),
    );
  }
}

class _SessionRow extends StatelessWidget {
  final dynamic session;
  const _SessionRow({required this.session});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colorScheme = theme.colorScheme;
    final status = session['searchableStatus'] ?? 'unknown';
    final statusColors = {
      'searchable': Colors.green,
      'processing': Colors.blue,
      'pending': Colors.grey,
      'failed': Colors.red,
      'blocked': Colors.amber,
    };

    return Container(
      padding: const EdgeInsets.symmetric(vertical: 10),
      decoration: BoxDecoration(
        border: Border(bottom: BorderSide(color: colorScheme.outlineVariant.withValues(alpha: 0.2))),
      ),
      child: Row(
        children: [
          Container(
            width: 8,
            height: 8,
            decoration: BoxDecoration(
              color: statusColors[status] ?? Colors.grey,
              shape: BoxShape.circle,
            ),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  (session['id'] ?? '').toString().substring(0, 8),
                  style: theme.textTheme.bodySmall?.copyWith(fontFamily: 'monospace'),
                ),
                Text(
                  session['developerId'] ?? '',
                  style: theme.textTheme.bodySmall?.copyWith(color: colorScheme.onSurface.withValues(alpha: 0.5)),
                ),
              ],
            ),
          ),
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
            decoration: BoxDecoration(
              color: (statusColors[status] ?? Colors.grey).withValues(alpha: 0.1),
              borderRadius: BorderRadius.circular(4),
            ),
            child: Text(status, style: TextStyle(fontSize: 11, color: statusColors[status])),
          ),
        ],
      ),
    );
  }
}

class _LearningMetric extends StatelessWidget {
  final String label;
  final int value;
  final Color color;
  const _LearningMetric({required this.label, required this.value, required this.color});

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 10),
      child: Row(
        children: [
          Container(width: 4, height: 16, decoration: BoxDecoration(color: color, borderRadius: BorderRadius.circular(2))),
          const SizedBox(width: 10),
          Expanded(child: Text(label, style: Theme.of(context).textTheme.bodySmall)),
          Text('$value', style: Theme.of(context).textTheme.bodySmall?.copyWith(fontWeight: FontWeight.bold)),
        ],
      ),
    );
  }
}

class _QueueBar extends StatelessWidget {
  final String name;
  final int depth;
  const _QueueBar({required this.name, required this.depth});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final pct = (depth / 50).clamp(0.0, 1.0);
    final color = depth > 20 ? Colors.amber : depth > 0 ? Colors.blue : Colors.grey.withValues(alpha: 0.3);

    return Row(
      children: [
        SizedBox(width: 80, child: Text(name, style: theme.textTheme.bodySmall)),
        Expanded(
          child: Container(
            height: 6,
            decoration: BoxDecoration(
              color: theme.colorScheme.surfaceContainerHighest,
              borderRadius: BorderRadius.circular(3),
            ),
            child: FractionallySizedBox(
              alignment: Alignment.centerLeft,
              widthFactor: pct == 0 ? 0.02 : pct, // min visible
              child: Container(
                decoration: BoxDecoration(color: color, borderRadius: BorderRadius.circular(3)),
              ),
            ),
          ),
        ),
        const SizedBox(width: 8),
        SizedBox(width: 24, child: Text('$depth', style: theme.textTheme.bodySmall, textAlign: TextAlign.right)),
      ],
    );
  }
}
