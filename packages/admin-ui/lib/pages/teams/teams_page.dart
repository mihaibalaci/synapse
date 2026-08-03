import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../../services/api_service.dart';
import '../../services/refresh_bus.dart';

class TeamsPage extends StatefulWidget {
  const TeamsPage({super.key});
  @override
  State<TeamsPage> createState() => _TeamsPageState();
}

class _TeamsPageState extends State<TeamsPage> {
  List<dynamic> _organizations = [];
  List<dynamic> _teams = [];
  List<dynamic> _users = [];
  bool _loading = false;
  String? _selectedTeamId;
  List<dynamic> _members = [];
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
        api
            .get('/api/v1/admin/organizations')
            .catchError((_) => <String, dynamic>{'organizations': []}),
        api
            .get('/api/v1/admin/teams')
            .catchError((_) => <String, dynamic>{'teams': []}),
        api.getUsers().catchError((_) => <String, dynamic>{'users': []}),
      ]);
      if (mounted) {
        setState(() {
          _organizations = results[0]['organizations'] as List? ?? [];
          _teams = results[1]['teams'] as List? ?? [];
          _users = results[2]['users'] as List? ?? [];
        });
      }
    } catch (_) {}
    if (mounted) setState(() => _loading = false);
  }

  Future<void> _loadMembers(String teamId) async {
    setState(() => _selectedTeamId = teamId);
    try {
      final data = await context.read<ApiService>().get(
        '/api/v1/admin/teams/$teamId/members',
      );
      if (mounted) setState(() => _members = data['members'] as List? ?? []);
    } catch (_) {
      if (mounted) setState(() => _members = []);
    }
  }

  Future<void> _createOrg() async {
    final idCtrl = TextEditingController();
    final nameCtrl = TextEditingController();
    final descCtrl = TextEditingController();
    final result = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Create Organization'),
        content: SizedBox(
          width: 400,
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              TextField(
                controller: idCtrl,
                decoration: const InputDecoration(
                  labelText: 'ID (lowercase, no spaces)',
                  border: OutlineInputBorder(),
                ),
              ),
              const SizedBox(height: 12),
              TextField(
                controller: nameCtrl,
                decoration: const InputDecoration(
                  labelText: 'Name',
                  border: OutlineInputBorder(),
                ),
              ),
              const SizedBox(height: 12),
              TextField(
                controller: descCtrl,
                decoration: const InputDecoration(
                  labelText: 'Description',
                  border: OutlineInputBorder(),
                ),
              ),
            ],
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx, false),
            child: const Text('Cancel'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(ctx, true),
            child: const Text('Create'),
          ),
        ],
      ),
    );
    if (result != true) {
      return;
    }
    if (!mounted) return;
    try {
      await context.read<ApiService>().post('/api/v1/admin/organizations', {
        'id': idCtrl.text.trim().toLowerCase(),
        'name': nameCtrl.text.trim(),
        'description': descCtrl.text.trim(),
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

  Future<void> _createTeam() async {
    final nameCtrl = TextEditingController();
    final descCtrl = TextEditingController();
    final result = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Create Team'),
        content: SizedBox(
          width: 400,
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              TextField(
                controller: nameCtrl,
                decoration: const InputDecoration(
                  labelText: 'Team Name (e.g. Engineering, HR, Sales)',
                  border: OutlineInputBorder(),
                ),
              ),
              const SizedBox(height: 12),
              TextField(
                controller: descCtrl,
                decoration: const InputDecoration(
                  labelText: 'Description',
                  border: OutlineInputBorder(),
                ),
              ),
            ],
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx, false),
            child: const Text('Cancel'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(ctx, true),
            child: const Text('Create'),
          ),
        ],
      ),
    );
    if (result != true) {
      return;
    }
    if (!mounted) return;
    try {
      await context.read<ApiService>().post('/api/v1/admin/teams', {
        'name': nameCtrl.text.trim(),
        'description': descCtrl.text.trim(),
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

  Future<void> _addMember(String teamId, String role) async {
    final userId = await showDialog<String>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text('Add ${role == "lead" ? "Lead" : "Member"}'),
        content: SizedBox(
          width: 400,
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: _users.map((u) {
              final user = u as Map<String, dynamic>;
              return ListTile(
                title: Text(user['displayName'] ?? user['email'] ?? ''),
                subtitle: Text(user['email'] ?? ''),
                onTap: () => Navigator.pop(ctx, user['id']),
              );
            }).toList(),
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx),
            child: const Text('Cancel'),
          ),
        ],
      ),
    );
    if (userId == null) {
      return;
    }
    if (!mounted) return;
    try {
      await context.read<ApiService>().post(
        '/api/v1/admin/teams/$teamId/members',
        {'userId': userId, 'role': role},
      );
      _loadMembers(teamId);
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(
          context,
        ).showSnackBar(SnackBar(content: Text('Failed: $e')));
      }
    }
  }

  Future<void> _removeMember(String teamId, String userId) async {
    try {
      await context.read<ApiService>().delete(
        '/api/v1/admin/teams/$teamId/members/$userId',
      );
      _loadMembers(teamId);
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
            'Organizations & Teams',
            style: theme.textTheme.headlineSmall?.copyWith(
              fontWeight: FontWeight.bold,
            ),
          ),
          const SizedBox(height: 4),
          Text(
            'Define your company structure before assigning users',
            style: theme.textTheme.bodyMedium?.copyWith(
              color: theme.colorScheme.onSurfaceVariant,
            ),
          ),
          if (_loading) const LinearProgressIndicator(),
          const SizedBox(height: 24),

          // Organizations
          Row(
            children: [
              Text(
                'Organizations',
                style: theme.textTheme.titleMedium?.copyWith(
                  fontWeight: FontWeight.w600,
                ),
              ),
              const Spacer(),
              FilledButton.tonal(
                onPressed: _createOrg,
                child: const Text('+ Organization'),
              ),
            ],
          ),
          const SizedBox(height: 8),
          Wrap(
            spacing: 12,
            runSpacing: 12,
            children: _organizations.map((o) {
              final org = o as Map<String, dynamic>;
              return Card(
                child: Padding(
                  padding: const EdgeInsets.all(16),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        org['name'] ?? '',
                        style: theme.textTheme.titleSmall?.copyWith(
                          fontWeight: FontWeight.w600,
                        ),
                      ),
                      if ((org['description'] ?? '').toString().isNotEmpty)
                        Text(
                          org['description'],
                          style: theme.textTheme.bodySmall,
                        ),
                      Text(
                        'ID: ${org['id']}',
                        style: theme.textTheme.labelSmall,
                      ),
                    ],
                  ),
                ),
              );
            }).toList(),
          ),
          const SizedBox(height: 32),

          // Teams
          Row(
            children: [
              Text(
                'Teams',
                style: theme.textTheme.titleMedium?.copyWith(
                  fontWeight: FontWeight.w600,
                ),
              ),
              const Spacer(),
              FilledButton.tonal(
                onPressed: _createTeam,
                child: const Text('+ Team'),
              ),
            ],
          ),
          const SizedBox(height: 12),
          if (_teams.isEmpty)
            const Text(
              'No teams yet. Create teams like Engineering, HR, Sales, Marketing.',
            )
          else
            ..._teams.map((t) {
              final team = t as Map<String, dynamic>;
              final isSelected = team['id'] == _selectedTeamId;
              return Card(
                color: isSelected
                    ? theme.colorScheme.primaryContainer.withValues(alpha: 0.3)
                    : null,
                child: InkWell(
                  onTap: () => _loadMembers(team['id']),
                  child: Padding(
                    padding: const EdgeInsets.all(16),
                    child: Row(
                      children: [
                        Expanded(
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Text(
                                team['name'] ?? '',
                                style: theme.textTheme.titleSmall?.copyWith(
                                  fontWeight: FontWeight.w600,
                                ),
                              ),
                              if ((team['description'] ?? '')
                                  .toString()
                                  .isNotEmpty)
                                Text(
                                  team['description'],
                                  style: theme.textTheme.bodySmall,
                                ),
                              Text(
                                '${team['memberCount'] ?? 0} members${(team['leads'] ?? '').toString().isNotEmpty ? ' • Leads: ${team['leads']}' : ''}',
                                style: theme.textTheme.labelSmall,
                              ),
                            ],
                          ),
                        ),
                        IconButton(
                          icon: const Icon(Icons.person_add, size: 18),
                          tooltip: 'Add Member',
                          onPressed: () => _addMember(team['id'], 'member'),
                        ),
                        IconButton(
                          icon: const Icon(
                            Icons.star,
                            size: 18,
                            color: Colors.amber,
                          ),
                          tooltip: 'Add Lead',
                          onPressed: () => _addMember(team['id'], 'lead'),
                        ),
                      ],
                    ),
                  ),
                ),
              );
            }),

          // Members of selected team
          if (_selectedTeamId != null) ...[
            const SizedBox(height: 24),
            Text(
              'Team Members',
              style: theme.textTheme.titleMedium?.copyWith(
                fontWeight: FontWeight.w600,
              ),
            ),
            const SizedBox(height: 8),
            if (_members.isEmpty)
              const Text('No members yet')
            else
              ..._members.map((m) {
                final member = m as Map<String, dynamic>;
                return ListTile(
                  leading: CircleAvatar(
                    child: Text((member['displayName'] ?? '?')[0]),
                  ),
                  title: Text(member['displayName'] ?? member['email'] ?? ''),
                  subtitle: Text('${member['email']} • ${member['role']}'),
                  trailing: IconButton(
                    icon: const Icon(Icons.remove_circle_outline, size: 18),
                    onPressed: () =>
                        _removeMember(_selectedTeamId!, member['id']),
                  ),
                );
              }),
          ],
        ],
      ),
    );
  }
}
