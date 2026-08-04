import 'dart:math';
import 'package:flutter/material.dart';
import 'package:flutter/scheduler.dart';
import 'package:provider/provider.dart';
import '../../services/api_service.dart';

class GraphPage extends StatefulWidget {
  const GraphPage({super.key});
  @override
  State<GraphPage> createState() => _GraphPageState();
}

class _GraphPageState extends State<GraphPage>
    with SingleTickerProviderStateMixin {
  final _searchController = TextEditingController();
  List<dynamic> _allEntities = [];
  List<dynamic> _edges = [];
  String? _centerEntity;
  bool _loading = false;
  late Ticker _ticker;
  final List<_PhysicsNode> _nodes = [];
  final _random = Random();
  Size _canvasSize = Size.zero;
  Map<String, dynamic>? _nodeDetail;

  @override
  void initState() {
    super.initState();
    _ticker = createTicker(_onTick)..start();
    _loadAll();
  }

  void _onTick(Duration elapsed) {
    if (_nodes.isEmpty || _canvasSize == Size.zero) return;
    _simulatePhysics();
    setState(() {});
  }

  void _simulatePhysics() {
    final cx = _canvasSize.width / 2;
    final cy = _canvasSize.height / 2;
    const damping = 0.97;
    const repulsion = 400.0;

    for (final node in _nodes) {
      // Attract toward ideal radius (closer = higher weight)
      final idealDist = node.idealRadius;
      final dx = node.x - cx;
      final dy = node.y - cy;
      final dist = sqrt(dx * dx + dy * dy).clamp(1.0, 1000.0);
      final attraction = (dist - idealDist) * 0.001;
      node.vx -= (dx / dist) * attraction;
      node.vy -= (dy / dist) * attraction;

      // Very gentle circular drift for subtle organic motion
      final angle = atan2(dy, dx);
      node.vx += cos(angle + pi / 2) * 0.015;
      node.vy += sin(angle + pi / 2) * 0.015;

      // Repel from other nodes
      for (final other in _nodes) {
        if (other == node) continue;
        final odx = node.x - other.x;
        final ody = node.y - other.y;
        final odist = sqrt(odx * odx + ody * ody).clamp(1.0, 500.0);
        if (odist < 80) {
          final force = repulsion / (odist * odist);
          node.vx += (odx / odist) * force * 0.3;
          node.vy += (ody / odist) * force * 0.3;
        }
      }

      // Apply damping (high = slow movement)
      node.vx *= damping;
      node.vy *= damping;

      // Update position
      node.x += node.vx;
      node.y += node.vy;

      // Keep in bounds
      node.x = node.x.clamp(60, _canvasSize.width - 60);
      node.y = node.y.clamp(40, _canvasSize.height - 40);
    }
  }

  Future<void> _loadAll() async {
    setState(() => _loading = true);
    try {
      final data = await context.read<ApiService>().get(
        '/api/v1/admin/graph/important?limit=100',
      );
      if (mounted) {
        setState(() => _allEntities = data['entities'] as List? ?? []);
      }
    } catch (_) {}
    if (mounted) {
      setState(() => _loading = false);
    }
  }

  Future<void> _selectEntity(String name) async {
    setState(() {
      _centerEntity = name;
      _loading = true;
      _searchController.text = name;
    });
    try {
      final data = await context.read<ApiService>().get(
        '/api/v1/admin/graph/entity/${Uri.encodeComponent(name)}',
      );
      if (mounted) {
        final edges = data['edges'] as List? ?? [];
        setState(() => _edges = edges);
        _buildPhysicsNodes(edges);
      }
    } catch (_) {
      if (mounted) {
        setState(() => _edges = []);
      }
    }
    if (mounted) {
      setState(() => _loading = false);
    }
  }

  void _buildPhysicsNodes(List<dynamic> edges) {
    _nodes.clear();
    if (_canvasSize == Size.zero) return;
    final cx = _canvasSize.width / 2;
    final cy = _canvasSize.height / 2;
    final maxWeight = edges.fold<double>(0.01, (prev, e) {
      final w = ((e as Map)['weight'] as num?)?.toDouble() ?? 0.1;
      return w > prev ? w : prev;
    });

    for (int i = 0; i < edges.length && i < 15; i++) {
      final edge = edges[i] as Map<String, dynamic>;
      final weight = (edge['weight'] as num?)?.toDouble() ?? 0.1;
      final normalized = (weight / maxWeight).clamp(0.1, 1.0);

      // Higher weight = closer to center (smaller ideal radius)
      final idealRadius = 80 + (1.0 - normalized) * 180;

      // Initial position: spread around center
      final angle =
          (2 * pi * i / min(edges.length, 15)) + _random.nextDouble() * 0.3;
      final startDist = idealRadius + _random.nextDouble() * 30 - 15;

      _nodes.add(
        _PhysicsNode(
          name: edge['neighbor'] as String? ?? '',
          x: cx + startDist * cos(angle),
          y: cy + startDist * sin(angle),
          weight: normalized,
          idealRadius: idealRadius,
          relation: edge['relation'] as String? ?? '',
        ),
      );
    }
  }

  void _clearSelection() {
    setState(() {
      _centerEntity = null;
      _edges = [];
      _nodes.clear();
      _searchController.clear();
      _nodeDetail = null;
    });
  }

  Future<void> _showNodeDetail(String name) async {
    try {
      final api = context.read<ApiService>();
      final facts = await api.get(
        '/api/v1/facts?entities=${Uri.encodeComponent(name)}&limit=5',
      );
      final graph = await api.get(
        '/api/v1/admin/graph/entity/${Uri.encodeComponent(name)}',
      );
      if (mounted) {
        setState(() {
          _nodeDetail = {
            'entity': name,
            'facts': facts['facts'] as List? ?? [],
            'factCount': facts['total'] ?? 0,
            'connections': (graph['edges'] as List?)?.length ?? 0,
          };
        });
      }
    } catch (_) {
      if (mounted) {
        setState(() {
          _nodeDetail = {
            'entity': name,
            'facts': [],
            'factCount': 0,
            'connections': 0,
          };
        });
      }
    }
  }

  @override
  void dispose() {
    _ticker.dispose();
    _searchController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Column(
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(24, 24, 24, 0),
          child: Row(
            children: [
              Text(
                'Knowledge Graph',
                style: theme.textTheme.headlineSmall?.copyWith(
                  fontWeight: FontWeight.bold,
                ),
              ),
              const Spacer(),
              SizedBox(
                width: 300,
                child: TextField(
                  controller: _searchController,
                  onSubmitted: (v) => v.trim().isNotEmpty
                      ? _selectEntity(v.trim())
                      : _clearSelection(),
                  decoration: InputDecoration(
                    hintText: 'Search entity...',
                    prefixIcon: const Icon(Icons.search, size: 20),
                    suffixIcon: _centerEntity != null
                        ? IconButton(
                            icon: const Icon(Icons.close, size: 18),
                            onPressed: _clearSelection,
                          )
                        : null,
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
        if (_loading) const LinearProgressIndicator(),
        Expanded(
          child: LayoutBuilder(
            builder: (context, constraints) {
              final newSize = Size(constraints.maxWidth, constraints.maxHeight);
              if (_canvasSize != newSize) {
                _canvasSize = newSize;
                if (_edges.isNotEmpty) _buildPhysicsNodes(_edges);
              }
              return _centerEntity != null
                  ? _buildAnimatedMindMap(theme)
                  : _buildOverview(theme);
            },
          ),
        ),
      ],
    );
  }

  Widget _buildOverview(ThemeData theme) {
    if (_allEntities.isEmpty) {
      return const Center(
        child: Text(
          'No graph data yet. Capture sessions to build the knowledge graph.',
        ),
      );
    }
    final maxWeight = _allEntities.fold<double>(1, (prev, e) {
      final w = ((e as Map)['totalWeight'] as num?)?.toDouble() ?? 1;
      return w > prev ? w : prev;
    });
    return SingleChildScrollView(
      padding: const EdgeInsets.all(24),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            '${_allEntities.length} entities. Click to explore:',
            style: theme.textTheme.bodyMedium,
          ),
          const SizedBox(height: 16),
          Wrap(
            spacing: 8,
            runSpacing: 8,
            children: _allEntities.map((e) {
              final entity = e as Map<String, dynamic>;
              final name = entity['name'] as String? ?? '';
              final weight = (entity['totalWeight'] as num?)?.toDouble() ?? 1;
              final normalized = (weight / maxWeight).clamp(0.3, 1.0);
              return ActionChip(
                label: Text(
                  name,
                  style: TextStyle(fontSize: 11 + normalized * 5),
                ),
                backgroundColor: theme.colorScheme.primaryContainer.withValues(
                  alpha: normalized,
                ),
                side: BorderSide(
                  color: theme.colorScheme.primary.withValues(
                    alpha: normalized * 0.6,
                  ),
                ),
                onPressed: () => _selectEntity(name),
              );
            }).toList(),
          ),
        ],
      ),
    );
  }

  Widget _buildAnimatedMindMap(ThemeData theme) {
    final cx = _canvasSize.width / 2;
    final cy = _canvasSize.height / 2;

    return Stack(
      children: [
        // Lines and glow painted behind nodes
        CustomPaint(
          size: _canvasSize,
          painter: _AnimatedLinePainter(
            centerX: cx,
            centerY: cy,
            nodes: _nodes,
            theme: theme,
          ),
        ),
        // Center node
        Positioned(
          left: cx - 55,
          top: cy - 20,
          child: Container(
            width: 110,
            height: 40,
            decoration: BoxDecoration(
              color: theme.colorScheme.primary,
              borderRadius: BorderRadius.circular(20),
              boxShadow: [
                BoxShadow(
                  color: theme.colorScheme.primary.withValues(alpha: 0.5),
                  blurRadius: 16,
                  spreadRadius: 2,
                ),
              ],
            ),
            alignment: Alignment.center,
            child: Text(
              _centerEntity!,
              style: const TextStyle(
                color: Colors.white,
                fontWeight: FontWeight.bold,
                fontSize: 14,
              ),
              overflow: TextOverflow.ellipsis,
            ),
          ),
        ),
        // Animated neighbor nodes
        ..._nodes.map((node) {
          final size = 60.0 + node.weight * 40;
          return Positioned(
            left: node.x - size / 2,
            top: node.y - 16,
            child: GestureDetector(
              onTap: () => _showNodeDetail(node.name),
              onDoubleTap: () => _selectEntity(node.name),
              child: MouseRegion(
                cursor: SystemMouseCursors.click,
                child: Container(
                  constraints: BoxConstraints(
                    minWidth: size,
                    maxWidth: size + 30,
                  ),
                  padding: const EdgeInsets.symmetric(
                    horizontal: 10,
                    vertical: 6,
                  ),
                  decoration: BoxDecoration(
                    color: theme.colorScheme.secondaryContainer.withValues(
                      alpha: 0.8 + node.weight * 0.2,
                    ),
                    borderRadius: BorderRadius.circular(16),
                    border: Border.all(
                      color: theme.colorScheme.secondary.withValues(
                        alpha: 0.4 + node.weight * 0.6,
                      ),
                      width: 1 + node.weight,
                    ),
                    boxShadow: [
                      BoxShadow(
                        color: theme.colorScheme.secondary.withValues(
                          alpha: node.weight * 0.3,
                        ),
                        blurRadius: 8,
                      ),
                    ],
                  ),
                  child: Text(
                    node.name,
                    textAlign: TextAlign.center,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(
                      fontSize: 10 + node.weight * 3,
                      fontWeight: node.weight > 0.6
                          ? FontWeight.w600
                          : FontWeight.normal,
                      color: theme.colorScheme.onSecondaryContainer,
                    ),
                  ),
                ),
              ),
            ),
          );
        }),
        // Bottom hint
        Positioned(
          bottom: _nodeDetail != null ? 180 : 8,
          left: 0,
          right: 0,
          child: Center(
            child: Text(
              '${_edges.length} connections • Closer = more relevant • Click for details • Double-click to explore',
              style: theme.textTheme.bodySmall?.copyWith(
                color: theme.colorScheme.onSurfaceVariant,
              ),
            ),
          ),
        ),
        // Detail panel
        if (_nodeDetail != null)
          Positioned(
            bottom: 0,
            left: 0,
            right: 0,
            child: _buildDetailPanel(theme),
          ),
      ],
    );
  }

  Widget _buildDetailPanel(ThemeData theme) {
    final detail = _nodeDetail!;
    final entity = detail['entity'] as String;
    final facts = detail['facts'] as List;
    final factCount = detail['factCount'] as int;
    final connections = detail['connections'] as int;

    return Container(
      height: 170,
      decoration: BoxDecoration(
        color: theme.colorScheme.surfaceContainerHigh,
        borderRadius: const BorderRadius.vertical(top: Radius.circular(16)),
        boxShadow: [
          BoxShadow(
            color: Colors.black.withValues(alpha: 0.3),
            blurRadius: 12,
            offset: const Offset(0, -2),
          ),
        ],
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 12, 16, 0),
            child: Row(
              children: [
                Icon(Icons.hub, size: 18, color: theme.colorScheme.primary),
                const SizedBox(width: 8),
                Text(
                  entity,
                  style: theme.textTheme.titleSmall?.copyWith(
                    fontWeight: FontWeight.bold,
                  ),
                ),
                const Spacer(),
                Text(
                  '$factCount facts • $connections links',
                  style: theme.textTheme.bodySmall,
                ),
                const SizedBox(width: 8),
                TextButton.icon(
                  onPressed: () => _selectEntity(entity),
                  icon: const Icon(Icons.explore, size: 16),
                  label: const Text('Explore'),
                ),
                IconButton(
                  icon: const Icon(Icons.close, size: 16),
                  onPressed: () => setState(() => _nodeDetail = null),
                ),
              ],
            ),
          ),
          const Divider(height: 1),
          Expanded(
            child: facts.isEmpty
                ? Center(
                    child: Text(
                      'No facts recorded for "$entity"',
                      style: theme.textTheme.bodySmall,
                    ),
                  )
                : ListView.builder(
                    padding: const EdgeInsets.symmetric(
                      horizontal: 16,
                      vertical: 4,
                    ),
                    itemCount: facts.length,
                    itemBuilder: (_, i) {
                      final fact = facts[i] as Map<String, dynamic>;
                      return Padding(
                        padding: const EdgeInsets.only(bottom: 4),
                        child: Row(
                          children: [
                            Container(
                              padding: const EdgeInsets.symmetric(
                                horizontal: 6,
                                vertical: 2,
                              ),
                              decoration: BoxDecoration(
                                color: theme.colorScheme.primaryContainer
                                    .withValues(alpha: 0.5),
                                borderRadius: BorderRadius.circular(4),
                              ),
                              child: Text(
                                fact['type'] ?? '',
                                style: TextStyle(
                                  fontSize: 10,
                                  color: theme.colorScheme.primary,
                                ),
                              ),
                            ),
                            const SizedBox(width: 8),
                            Expanded(
                              child: Text(
                                fact['content'] ?? '',
                                style: theme.textTheme.bodySmall,
                                maxLines: 2,
                                overflow: TextOverflow.ellipsis,
                              ),
                            ),
                          ],
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

class _PhysicsNode {
  String name;
  double x, y;
  double vx = 0, vy = 0;
  double weight;
  double idealRadius;
  String relation;

  _PhysicsNode({
    required this.name,
    required this.x,
    required this.y,
    required this.weight,
    required this.idealRadius,
    required this.relation,
  });
}

class _AnimatedLinePainter extends CustomPainter {
  final double centerX, centerY;
  final List<_PhysicsNode> nodes;
  final ThemeData theme;

  _AnimatedLinePainter({
    required this.centerX,
    required this.centerY,
    required this.nodes,
    required this.theme,
  });

  @override
  void paint(Canvas canvas, Size size) {
    final center = Offset(centerX, centerY);

    // Center glow
    canvas.drawCircle(
      center,
      35,
      Paint()..color = theme.colorScheme.primary.withValues(alpha: 0.08),
    );

    for (final node in nodes) {
      final end = Offset(node.x, node.y);

      // Connection line
      final paint = Paint()
        ..color = theme.colorScheme.secondary.withValues(
          alpha: 0.2 + node.weight * 0.5,
        )
        ..strokeWidth = 1.0 + node.weight * 2.5
        ..style = PaintingStyle.stroke
        ..strokeCap = StrokeCap.round;

      canvas.drawLine(center, end, paint);

      // Dot at connection
      canvas.drawCircle(
        end,
        2.5 + node.weight * 2,
        Paint()
          ..color = theme.colorScheme.secondary.withValues(
            alpha: 0.4 + node.weight * 0.4,
          ),
      );
    }
  }

  @override
  bool shouldRepaint(covariant CustomPainter oldDelegate) => true;
}
