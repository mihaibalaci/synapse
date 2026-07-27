import 'dart:async';
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../../services/api_service.dart';

class ActivityPage extends StatefulWidget {
  const ActivityPage({super.key});

  @override
  State<ActivityPage> createState() => _ActivityPageState();
}

class _ActivityPageState extends State<ActivityPage> {
  List<dynamic> _sessions = [];
  Timer? _timer;
  bool _loading = true;

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
      final stats = await api.getStats();
      if (mounted) {
        setState(() {
          _sessions = (stats['recentActivity'] as List?) ?? [];
          _loading = false;
        });
      }
    } catch (_) {
      if (mounted) setState(() => _loading = false);
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
          Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text('Activity Log', style: theme.textTheme.headlineSmall?.copyWith(fontWeight: FontWeight.bold)),
                  const SizedBox(height: 4),
                  Text('Real-time session ingestion, processing status, and context flow', style: theme.textTheme.bodyMedium?.copyWith(color: colorScheme.onSurface.withValues(alpha: 0.6))),
                ],
              ),
              Row(
                children: [
                  Container(
                    width: 8,
                    height: 8,
                    decoration: const BoxDecoration(color: Colors.green, shape: BoxShape.circle),
                  ),
                  const SizedBox(width: 6),
                  Text('Live', style: TextStyle(fontSize: 12, color: Colors.green[300])),
                  const SizedBox(width: 4),
                  Text('(5s refresh)', style: TextStyle(fontSize: 11, color: colorScheme.onSurface.withValues(alpha: 0.4))),
                ],
              ),
            ],
          ),
          const SizedBox(height: 24),

          if (_loading)
            const Center(child: CircularProgressIndicator())
          else if (_sessions.isEmpty)
            Center(
              child: Padding(
                padding: const EdgeInsets.all(48),
                child: Column(
                  children: [
                    Icon(Icons.inbox_rounded, size: 48, color: colorScheme.onSurface.withValues(alpha: 0.2)),
                    const SizedBox(height: 12),
                    Text('No sessions captured yet', style: TextStyle(color: colorScheme.onSurface.withValues(alpha: 0.4))),
                    const SizedBox(height: 4),
                    Text('Connect an IDE via MCP and start coding', style: TextStyle(fontSize: 12, color: colorScheme.onSurface.withValues(alpha: 0.3))),
                  ],
                ),
              ),
            )
          else
            Card(
              child: Column(
                children: _sessions.asMap().entries.map((entry) {
                  final i = entry.key;
                  final s = entry.value;
                  return _ActivityRow(session: s, isLast: i == _sessions.length - 1);
                }).toList(),
              ),
            ),
        ],
      ),
    );
  }
}

class _ActivityRow extends StatelessWidget {
  final dynamic session;
  final bool isLast;
  const _ActivityRow({required this.session, required this.isLast});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colorScheme = theme.colorScheme;
    final searchStatus = session['searchableStatus'] ?? 'unknown';
    final enrichStatus = session['enrichmentStatus'] ?? 'unknown';
    final tokens = session['totalTokens'] ?? 0;
    final updatedAt = session['updatedAt'] ?? '';

    final statusColors = {
      'searchable': Colors.green,
      'complete': Colors.green,
      'processing': Colors.blue,
      'pending': Colors.grey,
      'failed': Colors.red,
      'blocked': Colors.amber,
      'partial': Colors.orange,
      'not_required': Colors.grey,
    };

    String timeAgo = '';
    try {
      final diff = DateTime.now().difference(DateTime.parse(updatedAt));
      if (diff.inSeconds < 60) {
        timeAgo = '${diff.inSeconds}s ago';
      } else if (diff.inMinutes < 60) {
        timeAgo = '${diff.inMinutes}m ago';
      } else if (diff.inHours < 24) {
        timeAgo = '${diff.inHours}h ago';
      } else {
        timeAgo = '${diff.inDays}d ago';
      }
    } catch (_) {
      timeAgo = '';
    }

    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 14),
      decoration: BoxDecoration(
        border: isLast ? null : Border(bottom: BorderSide(color: colorScheme.outlineVariant.withValues(alpha: 0.2))),
      ),
      child: Row(
        children: [
          // Status dot
          Container(
            width: 10,
            height: 10,
            decoration: BoxDecoration(
              color: statusColors[searchStatus] ?? Colors.grey,
              shape: BoxShape.circle,
              boxShadow: searchStatus == 'processing'
                  ? [BoxShadow(color: Colors.blue.withValues(alpha: 0.4), blurRadius: 6)]
                  : null,
            ),
          ),
          const SizedBox(width: 16),

          // Session info
          Expanded(
            flex: 2,
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  (session['id'] ?? '').toString().substring(0, 8),
                  style: theme.textTheme.bodyMedium?.copyWith(fontFamily: 'monospace', fontWeight: FontWeight.w500),
                ),
                Text(
                  session['developerId'] ?? 'unknown',
                  style: theme.textTheme.bodySmall?.copyWith(color: colorScheme.onSurface.withValues(alpha: 0.5)),
                ),
              ],
            ),
          ),

          // Tokens
          SizedBox(
            width: 80,
            child: Text(
              '${(tokens / 1000).toStringAsFixed(1)}K tok',
              style: theme.textTheme.bodySmall?.copyWith(fontFamily: 'monospace'),
            ),
          ),

          // Search status
          SizedBox(
            width: 100,
            child: _StatusBadge(status: searchStatus, color: statusColors[searchStatus] ?? Colors.grey),
          ),
          const SizedBox(width: 8),

          // Enrichment status
          SizedBox(
            width: 100,
            child: _StatusBadge(status: enrichStatus, color: statusColors[enrichStatus] ?? Colors.grey),
          ),

          // Time ago
          SizedBox(
            width: 70,
            child: Text(timeAgo, style: theme.textTheme.bodySmall?.copyWith(color: colorScheme.onSurface.withValues(alpha: 0.4)), textAlign: TextAlign.right),
          ),
        ],
      ),
    );
  }
}

class _StatusBadge extends StatelessWidget {
  final String status;
  final Color color;
  const _StatusBadge({required this.status, required this.color});

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.1),
        borderRadius: BorderRadius.circular(4),
      ),
      child: Text(
        status.replaceAll('_', ' '),
        style: TextStyle(fontSize: 11, color: color, fontWeight: FontWeight.w500),
      ),
    );
  }
}
