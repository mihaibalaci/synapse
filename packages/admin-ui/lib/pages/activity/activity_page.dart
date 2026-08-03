import 'dart:async';
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../../services/api_service.dart';
import '../../services/refresh_bus.dart';

class ActivityPage extends StatefulWidget {
  const ActivityPage({super.key});

  @override
  State<ActivityPage> createState() => _ActivityPageState();
}

class _ActivityPageState extends State<ActivityPage> {
  List<dynamic> _sessions = [];
  Map<String, dynamic>? _metrics;
  Timer? _timer;
  bool _loading = true;
  String? _error;
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

  /// Formats a latency value that may arrive as int or double.
  static String _ms(dynamic value) {
    final n = (value is num) ? value.toDouble() : 0.0;
    if (n == 0) return '0ms';
    if (n < 1) return '${(n * 1000).toStringAsFixed(0)}\u00B5s';
    return '${n.toStringAsFixed(2)}ms';
  }

  Future<void> _refresh() async {
    final api = context.read<ApiService>();
    _bus?.setBusy(true);
    final errors = <String>[];

    Future<Map<String, dynamic>> guard(
      String name,
      Future<Map<String, dynamic>> future,
    ) async {
      try {
        return await future;
      } catch (e) {
        errors.add('$name: $e');
        return <String, dynamic>{};
      }
    }

    final results = await Future.wait([
      guard('stats', api.getStats()),
      guard('metrics', api.getMetrics()),
    ]);

    if (!mounted) {
      _bus?.setBusy(false);
      return;
    }
    setState(() {
      _sessions = (results[0]['recentActivity'] as List?) ?? [];
      _metrics = results[1];
      _error = errors.isEmpty ? null : errors.join('\n');
      _loading = false;
    });
    _bus?.setBusy(false);
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
                  Text(
                    'Activity & Metrics',
                    style: theme.textTheme.headlineSmall?.copyWith(
                      fontWeight: FontWeight.bold,
                    ),
                  ),
                  const SizedBox(height: 4),
                  Text(
                    'Real-time operational metrics, cache performance, and pipeline activity',
                    style: theme.textTheme.bodyMedium?.copyWith(
                      color: colorScheme.onSurface.withValues(alpha: 0.6),
                    ),
                  ),
                ],
              ),
              Row(
                children: [
                  Container(
                    width: 8,
                    height: 8,
                    decoration: const BoxDecoration(
                      color: Colors.green,
                      shape: BoxShape.circle,
                    ),
                  ),
                  const SizedBox(width: 6),
                  Text(
                    'Live',
                    style: TextStyle(fontSize: 12, color: Colors.green[300]),
                  ),
                  const SizedBox(width: 4),
                  Text(
                    '(5s refresh)',
                    style: TextStyle(
                      fontSize: 11,
                      color: colorScheme.onSurface.withValues(alpha: 0.4),
                    ),
                  ),
                ],
              ),
            ],
          ),
          const SizedBox(height: 24),

          if (_error != null)
            Container(
              width: double.infinity,
              padding: const EdgeInsets.all(12),
              margin: const EdgeInsets.only(bottom: 16),
              decoration: BoxDecoration(
                color: colorScheme.errorContainer,
                borderRadius: BorderRadius.circular(8),
              ),
              child: Text(
                _error!,
                style: TextStyle(
                  color: colorScheme.onErrorContainer,
                  fontSize: 12,
                ),
              ),
            ),

          if (_loading && _metrics == null)
            const Padding(
              padding: EdgeInsets.only(bottom: 16),
              child: LinearProgressIndicator(minHeight: 2),
            ),

          // Cache metrics
          _buildCachePanel(),
          const SizedBox(height: 16),

          // Retrieval metrics
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Expanded(child: _buildRetrievalPanel()),
              const SizedBox(width: 16),
              Expanded(child: _buildIngestionPanel()),
            ],
          ),
          const SizedBox(height: 16),

          // Storage + Errors
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Expanded(child: _buildStoragePanel()),
              const SizedBox(width: 16),
              Expanded(child: _buildErrorsPanel()),
            ],
          ),
          const SizedBox(height: 24),

          // Live Sessions
          _buildSessionsPanel(),
        ],
      ),
    );
  }

  Widget _buildCachePanel() {
    final theme = Theme.of(context);
    final cache = _metrics?['cache'] ?? {};
    final hits = cache['hits'] ?? 0;
    final misses = cache['misses'] ?? 0;
    final hitRate = (cache['hitRate'] ?? 0).toDouble();

    return Card(
      child: Padding(
        padding: const EdgeInsets.all(20),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Icon(Icons.speed, size: 18, color: Colors.cyan[300]),
                const SizedBox(width: 8),
                Text(
                  'Cache Performance',
                  style: theme.textTheme.titleMedium?.copyWith(
                    fontWeight: FontWeight.w600,
                  ),
                ),
              ],
            ),
            const SizedBox(height: 16),
            Row(
              children: [
                Expanded(
                  child: _MetricTile(
                    label: 'Hits',
                    value: '$hits',
                    color: Colors.green,
                  ),
                ),
                Expanded(
                  child: _MetricTile(
                    label: 'Misses',
                    value: '$misses',
                    color: Colors.red,
                  ),
                ),
                Expanded(
                  child: _MetricTile(
                    label: 'Hit Rate',
                    value: '${hitRate.toStringAsFixed(1)}%',
                    color: hitRate > 80 ? Colors.green : Colors.orange,
                  ),
                ),
                Expanded(
                  child: _MetricTile(
                    label: 'Evictions',
                    value: '${cache['evictions'] ?? 0}',
                    color: Colors.amber,
                  ),
                ),
                Expanded(
                  child: _MetricTile(
                    label: 'Cache Size',
                    value: '${cache['size'] ?? 0}',
                    color: Colors.blue,
                  ),
                ),
              ],
            ),
            const SizedBox(height: 12),
            // Hit rate bar
            ClipRRect(
              borderRadius: BorderRadius.circular(4),
              child: LinearProgressIndicator(
                value: hitRate / 100,
                minHeight: 8,
                backgroundColor: Colors.red.withValues(alpha: 0.2),
                valueColor: AlwaysStoppedAnimation<Color>(
                  hitRate > 80 ? Colors.green : Colors.orange,
                ),
              ),
            ),
            const SizedBox(height: 4),
            Text(
              'Cache hit ratio',
              style: TextStyle(
                fontSize: 10,
                color: theme.colorScheme.onSurface.withValues(alpha: 0.4),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildRetrievalPanel() {
    final theme = Theme.of(context);
    final retrieval = _metrics?['retrieval'] ?? {};

    return Card(
      child: Padding(
        padding: const EdgeInsets.all(20),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Icon(Icons.search, size: 18, color: Colors.indigo[300]),
                const SizedBox(width: 8),
                Text(
                  'Retrieval',
                  style: theme.textTheme.titleMedium?.copyWith(
                    fontWeight: FontWeight.w600,
                  ),
                ),
              ],
            ),
            const SizedBox(height: 16),
            _MetricRow(
              label: 'Total Queries',
              value: '${retrieval['totalQueries'] ?? 0}',
            ),
            _MetricRow(
              label: 'Avg Latency',
              value: _ms(retrieval['avgLatencyMs']),
            ),
            _MetricRow(
              label: 'p95 Latency',
              value: _ms(retrieval['p95LatencyMs']),
            ),
            _MetricRow(
              label: 'Concurrent Now',
              value: '${retrieval['concurrentNow'] ?? 0}',
              highlight: (retrieval['concurrentNow'] ?? 0) > 0,
            ),
            _MetricRow(
              label: 'Peak Concurrent',
              value: '${retrieval['peakConcurrent'] ?? 0}',
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildIngestionPanel() {
    final theme = Theme.of(context);
    final ingestion = _metrics?['ingestion'] ?? {};

    return Card(
      child: Padding(
        padding: const EdgeInsets.all(20),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Icon(Icons.input, size: 18, color: Colors.teal[300]),
                const SizedBox(width: 8),
                Text(
                  'Ingestion Pipeline',
                  style: theme.textTheme.titleMedium?.copyWith(
                    fontWeight: FontWeight.w600,
                  ),
                ),
              ],
            ),
            const SizedBox(height: 16),
            _MetricRow(
              label: 'Sessions Processed',
              value: '${ingestion['sessionsProcessed'] ?? 0}',
            ),
            _MetricRow(
              label: 'Chunks Created',
              value: '${ingestion['chunksCreated'] ?? 0}',
            ),
            _MetricRow(
              label: 'Facts Extracted',
              value: '${ingestion['factsExtracted'] ?? 0}',
            ),
            _MetricRow(
              label: 'Segmentations',
              value: '${ingestion['segmentations'] ?? 0}',
            ),
            _MetricRow(
              label: 'Embeddings Generated',
              value: '${ingestion['embeddingsGenerated'] ?? 0}',
            ),
            _MetricRow(
              label: 'Deduplications Run',
              value: '${ingestion['deduplicationsRun'] ?? 0}',
            ),
            _MetricRow(
              label: 'Graph Updates',
              value: '${ingestion['graphUpdates'] ?? 0}',
            ),
            _MetricRow(
              label: 'Search Indexed',
              value: '${ingestion['searchIndexed'] ?? 0}',
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildStoragePanel() {
    final theme = Theme.of(context);
    final storage = _metrics?['storage'] ?? {};

    return Card(
      child: Padding(
        padding: const EdgeInsets.all(20),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Icon(Icons.storage, size: 18, color: Colors.purple[300]),
                const SizedBox(width: 8),
                Text(
                  'Storage I/O',
                  style: theme.textTheme.titleMedium?.copyWith(
                    fontWeight: FontWeight.w600,
                  ),
                ),
              ],
            ),
            const SizedBox(height: 16),
            _MetricRow(
              label: 'PG Active Conns',
              value:
                  '${storage['pgActiveConns'] ?? 0} / ${storage['pgMaxConns'] ?? 20}',
            ),
            _MetricRow(
              label: 'Redis Connections',
              value: '${storage['redisConns'] ?? 0}',
            ),
            _MetricRow(
              label: 'S3 PUT Operations',
              value: '${storage['s3Puts'] ?? 0}',
            ),
            _MetricRow(
              label: 'S3 GET Operations',
              value: '${storage['s3Gets'] ?? 0}',
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildErrorsPanel() {
    final theme = Theme.of(context);
    final errors = _metrics?['errors'] ?? {};
    final total = errors['total'] ?? 0;

    return Card(
      child: Padding(
        padding: const EdgeInsets.all(20),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Icon(
                  Icons.error_outline,
                  size: 18,
                  color: total > 0 ? Colors.red[300] : Colors.green[300],
                ),
                const SizedBox(width: 8),
                Text(
                  'Errors',
                  style: theme.textTheme.titleMedium?.copyWith(
                    fontWeight: FontWeight.w600,
                  ),
                ),
              ],
            ),
            const SizedBox(height: 16),
            _MetricRow(
              label: 'Total Errors',
              value: '$total',
              highlight: total > 0,
            ),
            _MetricRow(
              label: 'Last 5 min',
              value: '${errors['last5min'] ?? 0}',
              highlight: (errors['last5min'] ?? 0) > 0,
            ),
            _MetricRow(
              label: 'Retrieval Errors',
              value: '${errors['retrieval'] ?? 0}',
            ),
            _MetricRow(
              label: 'Ingestion Errors',
              value: '${errors['ingestion'] ?? 0}',
            ),
            _MetricRow(
              label: 'Storage Errors',
              value: '${errors['storage'] ?? 0}',
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildSessionsPanel() {
    final theme = Theme.of(context);
    final colorScheme = theme.colorScheme;

    return Card(
      child: Padding(
        padding: const EdgeInsets.all(20),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              'Recent Sessions',
              style: theme.textTheme.titleMedium?.copyWith(
                fontWeight: FontWeight.w600,
              ),
            ),
            const SizedBox(height: 12),
            if (_sessions.isEmpty)
              Center(
                child: Padding(
                  padding: const EdgeInsets.all(32),
                  child: Column(
                    children: [
                      Icon(
                        Icons.inbox_rounded,
                        size: 40,
                        color: colorScheme.onSurface.withValues(alpha: 0.2),
                      ),
                      const SizedBox(height: 8),
                      Text(
                        'No sessions captured yet',
                        style: TextStyle(
                          color: colorScheme.onSurface.withValues(alpha: 0.4),
                        ),
                      ),
                    ],
                  ),
                ),
              )
            else
              ...(_sessions.take(10).map((s) => _SessionRow(session: s))),
          ],
        ),
      ),
    );
  }
}

// ─── Sub-widgets ─────────────────────────────────────────────────────────────

class _MetricTile extends StatelessWidget {
  final String label;
  final String value;
  final Color color;
  const _MetricTile({
    required this.label,
    required this.value,
    required this.color,
  });

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        Text(
          value,
          style: TextStyle(
            fontSize: 22,
            fontWeight: FontWeight.bold,
            color: color,
          ),
        ),
        const SizedBox(height: 4),
        Text(
          label,
          style: TextStyle(
            fontSize: 11,
            color: Theme.of(
              context,
            ).colorScheme.onSurface.withValues(alpha: 0.5),
          ),
        ),
      ],
    );
  }
}

class _MetricRow extends StatelessWidget {
  final String label;
  final String value;
  final bool highlight;
  const _MetricRow({
    required this.label,
    required this.value,
    this.highlight = false,
  });

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.spaceBetween,
        children: [
          Text(label, style: Theme.of(context).textTheme.bodySmall),
          Text(
            value,
            style: TextStyle(
              fontWeight: FontWeight.w600,
              fontSize: 13,
              fontFamily: 'monospace',
              color: highlight ? Colors.orange[300] : null,
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
    };

    return Container(
      padding: const EdgeInsets.symmetric(vertical: 8),
      decoration: BoxDecoration(
        border: Border(
          bottom: BorderSide(
            color: colorScheme.outlineVariant.withValues(alpha: 0.2),
          ),
        ),
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
            child: Text(
              (session['id'] ?? '').toString().substring(0, 8),
              style: const TextStyle(fontFamily: 'monospace', fontSize: 12),
            ),
          ),
          Text(
            session['developerId'] ?? '',
            style: TextStyle(
              fontSize: 11,
              color: colorScheme.onSurface.withValues(alpha: 0.5),
            ),
          ),
          const SizedBox(width: 12),
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
            decoration: BoxDecoration(
              color: (statusColors[status] ?? Colors.grey).withValues(
                alpha: 0.1,
              ),
              borderRadius: BorderRadius.circular(4),
            ),
            child: Text(
              status,
              style: TextStyle(fontSize: 10, color: statusColors[status]),
            ),
          ),
        ],
      ),
    );
  }
}
