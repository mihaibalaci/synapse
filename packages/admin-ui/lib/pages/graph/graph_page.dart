import 'dart:math';
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../../services/api_service.dart';

class GraphPage extends StatefulWidget {
  const GraphPage({super.key});
  @override
  State<GraphPage> createState() => _GraphPageState();
}

class _GraphPageState extends State<GraphPage> {
  final _searchController = TextEditingController();
  List<dynamic> _allEntities = [];
  List<dynamic> _edges = [];
  String? _centerEntity;
  bool _loading = false;

  @override
  void initState() {
    super.initState();
    _loadAll();
  }

  Future<void> _loadAll() async {
    setState(() => _loading = true);
    try {
      final data = await context.read<ApiService>().get(
        '/api/v1/admin/graph/important?limit=100',
      );
      if (mounted)
        setState(() => _allEntities = data['entities'] as List? ?? []);
    } catch (_) {}
    if (mounted) setState(() => _loading = false);
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
      if (mounted) setState(() => _edges = data['edges'] as List? ?? []);
    } catch (_) {
      if (mounted) setState(() => _edges = []);
    }
    if (mounted) setState(() => _loading = false);
  }

  void _clearSelection() {
    setState(() {
      _centerEntity = null;
      _edges = [];
      _searchController.clear();
    });
  }

  void _onSearch(String query) {
    if (query.trim().isEmpty) {
      _clearSelection();
      return;
    }
    _selectEntity(query.trim());
  }

  @override
  void dispose() {
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
                  onSubmitted: _onSearch,
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
          child: _centerEntity != null
              ? _buildMindMap(theme)
              : _buildOverview(theme),
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
            '${_allEntities.length} entities. Click to explore connections:',
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
              final fontSize = 12.0 + (normalized * 6);
              return ActionChip(
                label: Text(name, style: TextStyle(fontSize: fontSize)),
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

  Widget _buildMindMap(ThemeData theme) {
    return LayoutBuilder(
      builder: (context, constraints) {
        return CustomPaint(
          size: Size(constraints.maxWidth, constraints.maxHeight),
          painter: _MindMapPainter(
            center: _centerEntity!,
            edges: _edges,
            theme: theme,
          ),
          child: Stack(
            children: _buildClickableNodes(
              constraints.maxWidth,
              constraints.maxHeight,
              theme,
            ),
          ),
        );
      },
    );
  }

  List<Widget> _buildClickableNodes(
    double width,
    double height,
    ThemeData theme,
  ) {
    final centerX = width / 2;
    final centerY = height / 2;
    final radius = min(width, height) * 0.35;
    final nodes = <Widget>[];

    // Center node
    nodes.add(
      Positioned(
        left: centerX - 55,
        top: centerY - 18,
        child: GestureDetector(
          onTap: () {},
          child: Container(
            width: 110,
            height: 36,
            decoration: BoxDecoration(
              color: theme.colorScheme.primary,
              borderRadius: BorderRadius.circular(18),
              boxShadow: [
                BoxShadow(
                  color: theme.colorScheme.primary.withValues(alpha: 0.4),
                  blurRadius: 12,
                ),
              ],
            ),
            alignment: Alignment.center,
            child: Text(
              _centerEntity!,
              style: const TextStyle(
                color: Colors.white,
                fontWeight: FontWeight.bold,
                fontSize: 13,
              ),
              overflow: TextOverflow.ellipsis,
            ),
          ),
        ),
      ),
    );

    // Connected nodes in a circle
    for (int i = 0; i < _edges.length && i < 12; i++) {
      final edge = _edges[i] as Map<String, dynamic>;
      final name = edge['neighbor'] as String? ?? '';
      final weight = (edge['weight'] as num?)?.toDouble() ?? 0.5;
      final angle = (2 * pi * i / min(_edges.length, 12)) - pi / 2;
      final nodeRadius = radius * (0.7 + weight * 0.3);
      final nx = centerX + nodeRadius * cos(angle) - 45;
      final ny = centerY + nodeRadius * sin(angle) - 14;

      nodes.add(
        Positioned(
          left: nx,
          top: ny,
          child: GestureDetector(
            onTap: () => _selectEntity(name),
            child: MouseRegion(
              cursor: SystemMouseCursors.click,
              child: Container(
                constraints: const BoxConstraints(minWidth: 70, maxWidth: 120),
                padding: const EdgeInsets.symmetric(
                  horizontal: 12,
                  vertical: 6,
                ),
                decoration: BoxDecoration(
                  color: theme.colorScheme.secondaryContainer,
                  borderRadius: BorderRadius.circular(14),
                  border: Border.all(
                    color: theme.colorScheme.secondary.withValues(
                      alpha: 0.5 + weight * 0.5,
                    ),
                  ),
                  boxShadow: [
                    BoxShadow(
                      color: theme.colorScheme.secondary.withValues(alpha: 0.2),
                      blurRadius: 6,
                    ),
                  ],
                ),
                child: Text(
                  name,
                  textAlign: TextAlign.center,
                  style: TextStyle(
                    fontSize: 11 + weight * 2,
                    fontWeight: weight > 0.5
                        ? FontWeight.w600
                        : FontWeight.normal,
                    color: theme.colorScheme.onSecondaryContainer,
                  ),
                  overflow: TextOverflow.ellipsis,
                ),
              ),
            ),
          ),
        ),
      );
    }

    // Hint at bottom
    nodes.add(
      Positioned(
        bottom: 12,
        left: 0,
        right: 0,
        child: Center(
          child: Text(
            '${_edges.length} connections • Click a node to explore deeper',
            style: theme.textTheme.bodySmall?.copyWith(
              color: theme.colorScheme.onSurfaceVariant,
            ),
          ),
        ),
      ),
    );

    return nodes;
  }
}

class _MindMapPainter extends CustomPainter {
  final String center;
  final List<dynamic> edges;
  final ThemeData theme;

  _MindMapPainter({
    required this.center,
    required this.edges,
    required this.theme,
  });

  @override
  void paint(Canvas canvas, Size size) {
    final centerX = size.width / 2;
    final centerY = size.height / 2;
    final radius = min(size.width, size.height) * 0.35;
    final centerPoint = Offset(centerX, centerY);

    for (int i = 0; i < edges.length && i < 12; i++) {
      final edge = edges[i] as Map<String, dynamic>;
      final weight = (edge['weight'] as num?)?.toDouble() ?? 0.5;
      final angle = (2 * pi * i / min(edges.length, 12)) - pi / 2;
      final nodeRadius = radius * (0.7 + weight * 0.3);
      final endPoint = Offset(
        centerX + nodeRadius * cos(angle),
        centerY + nodeRadius * sin(angle),
      );

      final paint = Paint()
        ..color = theme.colorScheme.secondary.withValues(
          alpha: 0.3 + weight * 0.4,
        )
        ..strokeWidth = 1.5 + weight * 2
        ..style = PaintingStyle.stroke;

      canvas.drawLine(centerPoint, endPoint, paint);

      // Draw a small dot at the connection point
      final dotPaint = Paint()
        ..color = theme.colorScheme.secondary.withValues(alpha: 0.5)
        ..style = PaintingStyle.fill;
      canvas.drawCircle(endPoint, 3, dotPaint);
    }

    // Center glow
    final glowPaint = Paint()
      ..color = theme.colorScheme.primary.withValues(alpha: 0.1)
      ..style = PaintingStyle.fill;
    canvas.drawCircle(centerPoint, 30, glowPaint);
  }

  @override
  bool shouldRepaint(covariant CustomPainter oldDelegate) => true;
}
