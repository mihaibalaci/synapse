import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../../services/api_service.dart';
import '../../services/refresh_bus.dart';

class UsersPage extends StatefulWidget {
  const UsersPage({super.key});

  @override
  State<UsersPage> createState() => _UsersPageState();
}

class _UsersPageState extends State<UsersPage> {
  List<dynamic> _users = [];
  List<dynamic> _roles = [];
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
        api.getUsers().catchError(
          (_) => <String, dynamic>{'users': [], 'total': 0},
        ),
        api.getRoles().catchError((_) => <String, dynamic>{'roles': []}),
      ]);
      if (mounted) {
        setState(() {
          _users = results[0]['users'] as List? ?? [];
          _roles = results[1]['roles'] as List? ?? [];
        });
      }
    } catch (_) {}
    if (mounted) setState(() => _loading = false);
  }

  @override
  void dispose() {
    _bus?.removeListener(_onRefresh);
    super.dispose();
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
                  Text(
                    'Users & Roles',
                    style: theme.textTheme.headlineSmall?.copyWith(
                      fontWeight: FontWeight.bold,
                    ),
                  ),
                  const SizedBox(height: 4),
                  Text(
                    'Manage team access, roles, and permissions',
                    style: theme.textTheme.bodyMedium?.copyWith(
                      color: colorScheme.onSurface.withValues(alpha: 0.6),
                    ),
                  ),
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
          if (_loading) const LinearProgressIndicator(),

          // Roles section
          Text(
            'Roles',
            style: theme.textTheme.titleMedium?.copyWith(
              fontWeight: FontWeight.w600,
            ),
          ),
          const SizedBox(height: 12),
          Wrap(
            spacing: 12,
            runSpacing: 12,
            children: _roles.map((role) {
              final r = role as Map<String, dynamic>;
              return _RoleChip(role: r);
            }).toList(),
          ),
          const SizedBox(height: 32),

          // Users table
          Row(
            children: [
              Text(
                'Users (${_users.length})',
                style: theme.textTheme.titleMedium?.copyWith(
                  fontWeight: FontWeight.w600,
                ),
              ),
              const Spacer(),
              IconButton(
                icon: const Icon(Icons.refresh, size: 18),
                onPressed: _load,
                tooltip: 'Refresh',
              ),
            ],
          ),
          const SizedBox(height: 12),
          if (_users.isEmpty && !_loading)
            const Padding(
              padding: EdgeInsets.all(24),
              child: Text('No users found'),
            )
          else
            Card(
              child: Padding(
                padding: const EdgeInsets.all(4),
                child: DataTable(
                  headingRowColor: WidgetStateProperty.all(
                    colorScheme.surfaceContainerHighest.withValues(alpha: 0.3),
                  ),
                  columns: const [
                    DataColumn(label: Text('User')),
                    DataColumn(label: Text('Role')),
                    DataColumn(label: Text('Status')),
                    DataColumn(label: Text('Last Login')),
                    DataColumn(label: Text('Actions')),
                  ],
                  rows: _users.map((u) {
                    final user = u as Map<String, dynamic>;
                    final roles =
                        (user['roles'] as List?)?.join(', ') ?? 'viewer';
                    final disabled = user['disabled'] == true;
                    return DataRow(
                      cells: [
                        DataCell(
                          Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            mainAxisAlignment: MainAxisAlignment.center,
                            children: [
                              Text(
                                user['displayName'] ?? user['email'] ?? '',
                                style: const TextStyle(
                                  fontWeight: FontWeight.w500,
                                ),
                              ),
                              Text(
                                user['email'] ?? '',
                                style: TextStyle(
                                  fontSize: 12,
                                  color: colorScheme.onSurface.withValues(
                                    alpha: 0.5,
                                  ),
                                ),
                              ),
                            ],
                          ),
                        ),
                        DataCell(_RoleBadge(role: roles)),
                        DataCell(
                          Text(
                            disabled ? 'Disabled' : 'Active',
                            style: TextStyle(
                              color: disabled ? Colors.red : Colors.green,
                            ),
                          ),
                        ),
                        DataCell(
                          Text(
                            user['lastLoginAt'] ?? 'Never',
                            style: TextStyle(
                              color: colorScheme.onSurface.withValues(
                                alpha: 0.6,
                              ),
                            ),
                          ),
                        ),
                        DataCell(
                          Row(
                            mainAxisSize: MainAxisSize.min,
                            children: [
                              IconButton(
                                icon: const Icon(Icons.edit, size: 18),
                                onPressed: () => _showEditUserDialog(user),
                                tooltip: 'Edit',
                              ),
                              IconButton(
                                icon: const Icon(Icons.block, size: 18),
                                onPressed: () => _toggleDisable(user),
                                tooltip: disabled ? 'Enable' : 'Disable',
                              ),
                              IconButton(
                                icon: Icon(
                                  Icons.delete_outline,
                                  size: 18,
                                  color: colorScheme.error,
                                ),
                                onPressed: () => _deleteUser(user),
                                tooltip: 'Delete',
                              ),
                            ],
                          ),
                        ),
                      ],
                    );
                  }).toList(),
                ),
              ),
            ),
        ],
      ),
    );
  }

  void _showAddUserDialog() {
    final emailCtrl = TextEditingController();
    final nameCtrl = TextEditingController();
    final passCtrl = TextEditingController();
    String selectedRole = 'developer';

    showDialog(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Add User'),
        content: SizedBox(
          width: 400,
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              TextField(
                controller: nameCtrl,
                decoration: const InputDecoration(
                  labelText: 'Display Name',
                  border: OutlineInputBorder(),
                ),
              ),
              const SizedBox(height: 12),
              TextField(
                controller: emailCtrl,
                decoration: const InputDecoration(
                  labelText: 'Email',
                  border: OutlineInputBorder(),
                ),
              ),
              const SizedBox(height: 12),
              TextField(
                controller: passCtrl,
                obscureText: true,
                decoration: const InputDecoration(
                  labelText: 'Password (12+ chars)',
                  border: OutlineInputBorder(),
                ),
              ),
              const SizedBox(height: 12),
              StatefulBuilder(
                builder: (ctx, setInner) {
                  return DropdownButtonFormField<String>(
                    initialValue: selectedRole,
                    decoration: const InputDecoration(
                      labelText: 'Role',
                      border: OutlineInputBorder(),
                    ),
                    items: const [
                      DropdownMenuItem(value: 'admin', child: Text('Admin')),
                      DropdownMenuItem(
                        value: 'team_lead',
                        child: Text('Team Lead'),
                      ),
                      DropdownMenuItem(
                        value: 'developer',
                        child: Text('Developer'),
                      ),
                      DropdownMenuItem(value: 'viewer', child: Text('Viewer')),
                    ],
                    onChanged: (v) =>
                        setInner(() => selectedRole = v ?? 'developer'),
                  );
                },
              ),
            ],
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx),
            child: const Text('Cancel'),
          ),
          FilledButton(
            onPressed: () async {
              Navigator.pop(ctx);
              await _createUser(
                emailCtrl.text,
                nameCtrl.text,
                passCtrl.text,
                selectedRole,
              );
            },
            child: const Text('Create'),
          ),
        ],
      ),
    );
  }

  Future<void> _createUser(
    String email,
    String name,
    String password,
    String role,
  ) async {
    try {
      await context.read<ApiService>().createUser({
        'email': email.trim(),
        'displayName': name.trim(),
        'password': password,
        'roles': [role],
      });
      _load();
      if (mounted) {
        ScaffoldMessenger.of(
          context,
        ).showSnackBar(const SnackBar(content: Text('User created')));
      }
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(
          context,
        ).showSnackBar(SnackBar(content: Text('Failed: $e')));
      }
    }
  }

  Future<void> _toggleDisable(Map<String, dynamic> user) async {
    final disabled = user['disabled'] == true;
    try {
      await context.read<ApiService>().updateUser(user['id'], {
        'disabled': !disabled,
      });
      _load();
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(
          context,
        ).showSnackBar(SnackBar(content: Text('Failed: $e')));
      }
    }
  }

  void _showEditUserDialog(Map<String, dynamic> user) {
    final nameCtrl = TextEditingController(text: user['displayName'] ?? '');
    final passCtrl = TextEditingController();
    String selectedRole =
        (user['roles'] as List?)?.first?.toString() ?? 'viewer';

    showDialog(
      context: context,
      builder: (ctx) {
        return StatefulBuilder(
          builder: (ctx, setDialogState) {
            return AlertDialog(
              title: Text('Edit ${user['email']}'),
              content: SizedBox(
                width: 400,
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    TextField(
                      controller: nameCtrl,
                      decoration: const InputDecoration(
                        labelText: 'Display Name',
                        border: OutlineInputBorder(),
                      ),
                    ),
                    const SizedBox(height: 12),
                    DropdownButtonFormField<String>(
                      initialValue: selectedRole,
                      decoration: const InputDecoration(
                        labelText: 'Role',
                        border: OutlineInputBorder(),
                      ),
                      items: const [
                        DropdownMenuItem(value: 'admin', child: Text('Admin')),
                        DropdownMenuItem(
                          value: 'team_lead',
                          child: Text('Team Lead'),
                        ),
                        DropdownMenuItem(
                          value: 'developer',
                          child: Text('Developer'),
                        ),
                        DropdownMenuItem(
                          value: 'viewer',
                          child: Text('Viewer'),
                        ),
                      ],
                      onChanged: (v) => setDialogState(
                        () => selectedRole = v ?? selectedRole,
                      ),
                    ),
                    const SizedBox(height: 12),
                    TextField(
                      controller: passCtrl,
                      obscureText: true,
                      decoration: const InputDecoration(
                        labelText: 'New Password (leave empty to keep)',
                        border: OutlineInputBorder(),
                      ),
                    ),
                  ],
                ),
              ),
              actions: [
                TextButton(
                  onPressed: () => Navigator.pop(ctx),
                  child: const Text('Cancel'),
                ),
                FilledButton(
                  onPressed: () async {
                    Navigator.pop(ctx);
                    await _updateUser(
                      user['id'],
                      nameCtrl.text,
                      selectedRole,
                      passCtrl.text,
                    );
                  },
                  child: const Text('Save'),
                ),
              ],
            );
          },
        );
      },
    );
  }

  Future<void> _updateUser(
    String id,
    String name,
    String role,
    String password,
  ) async {
    final updates = <String, dynamic>{
      'displayName': name.trim(),
      'roles': [role],
    };
    if (password.isNotEmpty) {
      if (password.length < 12) {
        if (mounted) {
          ScaffoldMessenger.of(context).showSnackBar(
            const SnackBar(
              content: Text('Password must be at least 12 characters'),
            ),
          );
        }
        return;
      }
      updates['password'] = password;
    }
    try {
      await context.read<ApiService>().updateUser(id, updates);
      _load();
      if (mounted) {
        ScaffoldMessenger.of(
          context,
        ).showSnackBar(const SnackBar(content: Text('User updated')));
      }
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(
          context,
        ).showSnackBar(SnackBar(content: Text('Failed: $e')));
      }
    }
  }

  Future<void> _deleteUser(Map<String, dynamic> user) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Delete User?'),
        content: Text('Are you sure you want to delete ${user['email']}?'),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx, false),
            child: const Text('Cancel'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(ctx, true),
            child: const Text('Delete'),
          ),
        ],
      ),
    );
    if (confirmed != true) return;
    if (!mounted) return;
    try {
      await context.read<ApiService>().deleteUser(user['id']);
      _load();
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(
          context,
        ).showSnackBar(SnackBar(content: Text('Failed: $e')));
      }
    }
  }
}

class _RoleChip extends StatelessWidget {
  final Map<String, dynamic> role;
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
    final id = role['id'] as String? ?? '';
    final color = colors[id] ?? Colors.grey;

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
              Text(
                role['label'] ?? id,
                style: TextStyle(fontWeight: FontWeight.w600, color: color),
              ),
            ],
          ),
          const SizedBox(height: 4),
          Text(
            role['description'] ?? '',
            style: theme.textTheme.bodySmall?.copyWith(
              color: theme.colorScheme.onSurface.withValues(alpha: 0.5),
            ),
          ),
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
    final colors = {
      'admin': Colors.red,
      'team_lead': Colors.orange,
      'developer': Colors.blue,
      'viewer': Colors.grey,
    };
    final color = colors[role] ?? Colors.grey;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.15),
        borderRadius: BorderRadius.circular(4),
      ),
      child: Text(
        role.replaceAll('_', ' '),
        style: TextStyle(
          fontSize: 11,
          color: color,
          fontWeight: FontWeight.w600,
        ),
      ),
    );
  }
}
