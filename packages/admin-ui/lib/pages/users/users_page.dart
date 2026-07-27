import 'package:flutter/material.dart';

class UsersPage extends StatefulWidget {
  const UsersPage({super.key});

  @override
  State<UsersPage> createState() => _UsersPageState();
}

class _UsersPageState extends State<UsersPage> {
  final List<Map<String, dynamic>> _users = [
    {'id': 'admin', 'name': 'Admin', 'email': 'admin@company.com', 'role': 'admin', 'sessions': 0, 'lastActive': 'Now'},
    {'id': 'dev-1', 'name': 'Alice Chen', 'email': 'alice@company.com', 'role': 'developer', 'sessions': 142, 'lastActive': '2 hours ago'},
    {'id': 'dev-2', 'name': 'Bob Park', 'email': 'bob@company.com', 'role': 'developer', 'sessions': 98, 'lastActive': '1 day ago'},
    {'id': 'dev-3', 'name': 'Carol Singh', 'email': 'carol@company.com', 'role': 'team_lead', 'sessions': 214, 'lastActive': '30 min ago'},
  ];

  final List<Map<String, String>> _roles = [
    {'id': 'admin', 'label': 'Admin', 'description': 'Full system access, user management'},
    {'id': 'team_lead', 'label': 'Team Lead', 'description': 'Team data access, analytics'},
    {'id': 'developer', 'label': 'Developer', 'description': 'Capture, search, own data'},
    {'id': 'viewer', 'label': 'Viewer', 'description': 'Read-only access to shared knowledge'},
  ];

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
                  Text('Users & Roles', style: theme.textTheme.headlineSmall?.copyWith(fontWeight: FontWeight.bold)),
                  const SizedBox(height: 4),
                  Text('Manage team access, roles, and permissions', style: theme.textTheme.bodyMedium?.copyWith(color: colorScheme.onSurface.withValues(alpha: 0.6))),
                ],
              ),
              FilledButton.icon(
                onPressed: _showAddUserDialog,
                icon: const Icon(Icons.person_add, size: 18),
                label: const Text('Add User'),
              ),
            ],
          ),
          const SizedBox(height: 24),

          // Roles section
          Text('Roles', style: theme.textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w600)),
          const SizedBox(height: 12),
          Wrap(
            spacing: 12,
            runSpacing: 12,
            children: _roles.map((role) => _RoleChip(role: role)).toList(),
          ),
          const SizedBox(height: 32),

          // Users table
          Text('Users', style: theme.textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w600)),
          const SizedBox(height: 12),
          Card(
            child: Padding(
              padding: const EdgeInsets.all(4),
              child: DataTable(
                headingRowColor: WidgetStateProperty.all(colorScheme.surfaceContainerHighest.withValues(alpha: 0.3)),
                columns: const [
                  DataColumn(label: Text('User')),
                  DataColumn(label: Text('Role')),
                  DataColumn(label: Text('Sessions'), numeric: true),
                  DataColumn(label: Text('Last Active')),
                  DataColumn(label: Text('Actions')),
                ],
                rows: _users.map((u) => DataRow(cells: [
                      DataCell(Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        mainAxisAlignment: MainAxisAlignment.center,
                        children: [
                          Text(u['name'], style: const TextStyle(fontWeight: FontWeight.w500)),
                          Text(u['email'], style: TextStyle(fontSize: 12, color: colorScheme.onSurface.withValues(alpha: 0.5))),
                        ],
                      )),
                      DataCell(_RoleBadge(role: u['role'])),
                      DataCell(Text('${u['sessions']}')),
                      DataCell(Text(u['lastActive'], style: TextStyle(color: colorScheme.onSurface.withValues(alpha: 0.6)))),
                      DataCell(Row(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          IconButton(icon: const Icon(Icons.edit, size: 18), onPressed: () {}, tooltip: 'Edit'),
                          IconButton(icon: Icon(Icons.delete_outline, size: 18, color: colorScheme.error), onPressed: () {}, tooltip: 'Remove'),
                        ],
                      )),
                    ])).toList(),
              ),
            ),
          ),
        ],
      ),
    );
  }

  void _showAddUserDialog() {
    showDialog(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Add User'),
        content: SizedBox(
          width: 400,
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              TextField(decoration: const InputDecoration(labelText: 'Name', border: OutlineInputBorder())),
              const SizedBox(height: 12),
              TextField(decoration: const InputDecoration(labelText: 'Email', border: OutlineInputBorder())),
              const SizedBox(height: 12),
              DropdownButtonFormField<String>(
                decoration: const InputDecoration(labelText: 'Role', border: OutlineInputBorder()),
                items: _roles.map((r) => DropdownMenuItem(value: r['id'], child: Text(r['label']!))).toList(),
                onChanged: (_) {},
              ),
            ],
          ),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('Cancel')),
          FilledButton(onPressed: () => Navigator.pop(ctx), child: const Text('Create')),
        ],
      ),
    );
  }
}

class _RoleChip extends StatelessWidget {
  final Map<String, String> role;
  const _RoleChip({required this.role});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = {
      'admin': Colors.red,
      'team_lead': Colors.orange,
      'developer': Colors.blue,
      'viewer': Colors.grey,
    };
    final color = colors[role['id']] ?? Colors.grey;

    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.08),
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: color.withValues(alpha: 0.2)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(Icons.shield_outlined, size: 14, color: color),
              const SizedBox(width: 6),
              Text(role['label']!, style: TextStyle(fontWeight: FontWeight.w600, color: color)),
            ],
          ),
          const SizedBox(height: 4),
          Text(role['description']!, style: theme.textTheme.bodySmall?.copyWith(color: theme.colorScheme.onSurface.withValues(alpha: 0.5))),
        ],
      ),
    );
  }
}

class _RoleBadge extends StatelessWidget {
  final String role;
  const _RoleBadge({required this.role});

  @override
  Widget build(BuildContext context) {
    final colors = {'admin': Colors.red, 'team_lead': Colors.orange, 'developer': Colors.blue, 'viewer': Colors.grey};
    final color = colors[role] ?? Colors.grey;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
      decoration: BoxDecoration(color: color.withValues(alpha: 0.15), borderRadius: BorderRadius.circular(4)),
      child: Text(role.replaceAll('_', ' '), style: TextStyle(fontSize: 11, color: color, fontWeight: FontWeight.w600)),
    );
  }
}
