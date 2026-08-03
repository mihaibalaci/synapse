import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:provider/provider.dart';
import '../services/auth_service.dart';
import '../services/refresh_bus.dart';

class ShellScaffold extends StatelessWidget {
  final Widget child;
  const ShellScaffold({super.key, required this.child});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final currentPath = GoRouterState.of(context).uri.path;

    return Scaffold(
      body: Row(
        children: [
          // Side Navigation Rail
          _SideNav(currentPath: currentPath),
          // Main Content
          Expanded(
            child: Container(
              color: theme.colorScheme.surface,
              child: Column(
                children: [
                  const _TopBar(),
                  Expanded(child: child),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }
}

/// Thin top bar holding the manual refresh control.
class _TopBar extends StatelessWidget {
  const _TopBar();

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final bus = context.watch<RefreshBus>();

    return Container(
      height: 48,
      padding: const EdgeInsets.symmetric(horizontal: 16),
      decoration: BoxDecoration(
        border: Border(
          bottom: BorderSide(
            color: theme.colorScheme.outlineVariant.withValues(alpha: 0.3),
          ),
        ),
      ),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.end,
        children: [
          if (bus.busy)
            const Padding(
              padding: EdgeInsets.only(right: 12),
              child: SizedBox(
                width: 14,
                height: 14,
                child: CircularProgressIndicator(strokeWidth: 2),
              ),
            ),
          Tooltip(
            message: 'Refresh data',
            child: IconButton(
              icon: const Icon(Icons.refresh_rounded, size: 20),
              onPressed: () {
                context.read<RefreshBus>().request();
                ScaffoldMessenger.of(context).showSnackBar(
                  const SnackBar(
                    content: Text('Refreshing…'),
                    duration: Duration(milliseconds: 900),
                    behavior: SnackBarBehavior.floating,
                  ),
                );
              },
            ),
          ),
          const SizedBox(width: 8),
          Tooltip(
            message: 'Sign out',
            child: IconButton(
              icon: const Icon(Icons.logout_rounded, size: 20),
              onPressed: () => context.read<AuthService>().logout(),
            ),
          ),
        ],
      ),
    );
  }
}

class _SideNav extends StatelessWidget {
  final String currentPath;
  const _SideNav({required this.currentPath});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colorScheme = theme.colorScheme;

    return Container(
      width: 240,
      decoration: BoxDecoration(
        color: colorScheme.surfaceContainerLow,
        border: Border(
          right: BorderSide(
            color: colorScheme.outlineVariant.withValues(alpha: 0.3),
          ),
        ),
      ),
      child: Column(
        children: [
          // Logo area
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 24),
            child: Row(
              children: [
                Container(
                  width: 32,
                  height: 32,
                  decoration: BoxDecoration(
                    gradient: LinearGradient(
                      colors: [colorScheme.primary, colorScheme.tertiary],
                    ),
                    borderRadius: BorderRadius.circular(8),
                  ),
                  child: const Icon(Icons.hub, color: Colors.white, size: 18),
                ),
                const SizedBox(width: 12),
                Text(
                  'Synapse',
                  style: theme.textTheme.titleMedium?.copyWith(
                    fontWeight: FontWeight.bold,
                    color: colorScheme.onSurface,
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(height: 8),
          // Nav items
          _NavItem(
            icon: Icons.dashboard_rounded,
            label: 'Dashboard',
            path: '/dashboard',
            currentPath: currentPath,
          ),
          _NavItem(
            icon: Icons.people_rounded,
            label: 'Users & Roles',
            path: '/users',
            currentPath: currentPath,
          ),
          _NavItem(
            icon: Icons.business_rounded,
            label: 'Teams',
            path: '/teams',
            currentPath: currentPath,
          ),
          _NavItem(
            icon: Icons.memory_rounded,
            label: 'System',
            path: '/system',
            currentPath: currentPath,
          ),
          _ExpandableNavGroup(
            icon: Icons.settings_suggest_rounded,
            label: 'System Admin',
            currentPath: currentPath,
            children: [
              _NavItem(
                icon: Icons.timeline_rounded,
                label: 'Activity',
                path: '/activity',
                currentPath: currentPath,
                indent: true,
              ),
              _NavItem(
                icon: Icons.settings_rounded,
                label: 'Configuration',
                path: '/settings',
                currentPath: currentPath,
                indent: true,
              ),
              _NavItem(
                icon: Icons.explore_rounded,
                label: 'Memory',
                path: '/memory',
                currentPath: currentPath,
                indent: true,
              ),
              _NavItem(
                icon: Icons.engineering_rounded,
                label: 'Operations',
                path: '/operations',
                currentPath: currentPath,
                indent: true,
              ),
            ],
          ),
          _NavItem(
            icon: Icons.search_rounded,
            label: 'Search',
            path: '/search',
            currentPath: currentPath,
          ),
          _NavItem(
            icon: Icons.hub_rounded,
            label: 'Graph',
            path: '/graph',
            currentPath: currentPath,
          ),
          _NavItem(
            icon: Icons.vpn_key_rounded,
            label: 'API Keys',
            path: '/keys',
            currentPath: currentPath,
          ),
          const Spacer(),
          // Status indicator
          Padding(
            padding: const EdgeInsets.all(16),
            child: Container(
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
              decoration: BoxDecoration(
                color: Colors.green.withValues(alpha: 0.1),
                borderRadius: BorderRadius.circular(8),
                border: Border.all(color: Colors.green.withValues(alpha: 0.3)),
              ),
              child: Row(
                children: [
                  Container(
                    width: 8,
                    height: 8,
                    decoration: const BoxDecoration(
                      color: Colors.green,
                      shape: BoxShape.circle,
                    ),
                  ),
                  const SizedBox(width: 8),
                  Text(
                    'System Online',
                    style: theme.textTheme.bodySmall?.copyWith(
                      color: Colors.green[300],
                    ),
                  ),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _NavItem extends StatelessWidget {
  final IconData icon;
  final String label;
  final String path;
  final String currentPath;
  final bool indent;

  const _NavItem({
    required this.icon,
    required this.label,
    required this.path,
    required this.currentPath,
    this.indent = false,
  });

  @override
  Widget build(BuildContext context) {
    final isActive = currentPath == path;
    final theme = Theme.of(context);
    final colorScheme = theme.colorScheme;

    return Padding(
      padding: EdgeInsets.only(
        left: indent ? 24 : 12,
        right: 12,
        top: 2,
        bottom: 2,
      ),
      child: Material(
        color: isActive
            ? colorScheme.primaryContainer.withValues(alpha: 0.3)
            : Colors.transparent,
        borderRadius: BorderRadius.circular(10),
        child: InkWell(
          onTap: () => context.go(path),
          borderRadius: BorderRadius.circular(10),
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
            child: Row(
              children: [
                Icon(
                  icon,
                  size: indent ? 16 : 20,
                  color: isActive
                      ? colorScheme.primary
                      : colorScheme.onSurface.withValues(alpha: 0.6),
                ),
                const SizedBox(width: 12),
                Text(
                  label,
                  style: theme.textTheme.bodyMedium?.copyWith(
                    fontSize: indent ? 13 : null,
                    color: isActive
                        ? colorScheme.primary
                        : colorScheme.onSurface.withValues(alpha: 0.8),
                    fontWeight: isActive ? FontWeight.w600 : FontWeight.normal,
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _ExpandableNavGroup extends StatefulWidget {
  final IconData icon;
  final String label;
  final String currentPath;
  final List<_NavItem> children;

  const _ExpandableNavGroup({
    required this.icon,
    required this.label,
    required this.currentPath,
    required this.children,
  });

  @override
  State<_ExpandableNavGroup> createState() => _ExpandableNavGroupState();
}

class _ExpandableNavGroupState extends State<_ExpandableNavGroup> {
  bool _expanded = false;

  @override
  void initState() {
    super.initState();
    // Auto-expand if a child is active
    _expanded = widget.children.any((c) => c.path == widget.currentPath);
  }

  @override
  void didUpdateWidget(covariant _ExpandableNavGroup oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (widget.children.any((c) => c.path == widget.currentPath)) {
      _expanded = true;
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colorScheme = theme.colorScheme;
    final hasActiveChild = widget.children.any(
      (c) => c.path == widget.currentPath,
    );

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 2),
          child: Material(
            color: Colors.transparent,
            borderRadius: BorderRadius.circular(10),
            child: InkWell(
              onTap: () => setState(() => _expanded = !_expanded),
              borderRadius: BorderRadius.circular(10),
              child: Padding(
                padding: const EdgeInsets.symmetric(
                  horizontal: 12,
                  vertical: 10,
                ),
                child: Row(
                  children: [
                    Icon(
                      widget.icon,
                      size: 20,
                      color: hasActiveChild
                          ? colorScheme.primary
                          : colorScheme.onSurface.withValues(alpha: 0.6),
                    ),
                    const SizedBox(width: 12),
                    Expanded(
                      child: Text(
                        widget.label,
                        style: theme.textTheme.bodyMedium?.copyWith(
                          color: hasActiveChild
                              ? colorScheme.primary
                              : colorScheme.onSurface.withValues(alpha: 0.8),
                          fontWeight: hasActiveChild
                              ? FontWeight.w600
                              : FontWeight.normal,
                        ),
                      ),
                    ),
                    Icon(
                      _expanded ? Icons.expand_less : Icons.expand_more,
                      size: 18,
                      color: colorScheme.onSurface.withValues(alpha: 0.4),
                    ),
                  ],
                ),
              ),
            ),
          ),
        ),
        if (_expanded) ...widget.children,
      ],
    );
  }
}
