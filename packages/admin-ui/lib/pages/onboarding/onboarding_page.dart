import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:provider/provider.dart';
import '../../services/api_service.dart';

class OnboardingPage extends StatefulWidget {
  const OnboardingPage({super.key});

  @override
  State<OnboardingPage> createState() => _OnboardingPageState();
}

class _OnboardingPageState extends State<OnboardingPage> {
  int _step = 0;
  bool _healthOk = false;
  bool _checking = false;

  @override
  void initState() {
    super.initState();
    _checkHealth();
  }

  Future<void> _checkHealth() async {
    setState(() => _checking = true);
    try {
      final api = context.read<ApiService>();
      final data = await api.getHealth();
      if (mounted) setState(() => _healthOk = data['status'] == 'ready');
    } catch (_) {
      if (mounted) setState(() => _healthOk = false);
    } finally {
      if (mounted) setState(() => _checking = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final steps = [
      _buildWelcome(theme),
      _buildHealthCheck(theme),
      _buildCapture(theme),
      _buildDone(theme),
    ];

    return Scaffold(
      body: Center(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 600),
          child: Padding(
            padding: const EdgeInsets.all(32),
            child: Column(
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                LinearProgressIndicator(value: (_step + 1) / steps.length),
                const SizedBox(height: 32),
                Expanded(child: steps[_step]),
                const SizedBox(height: 24),
                Row(
                  mainAxisAlignment: MainAxisAlignment.spaceBetween,
                  children: [
                    if (_step > 0)
                      TextButton(
                        onPressed: () => setState(() => _step--),
                        child: const Text('Back'),
                      )
                    else
                      const SizedBox(),
                    if (_step < steps.length - 1)
                      FilledButton(
                        onPressed: () => setState(() => _step++),
                        child: const Text('Next'),
                      )
                    else
                      FilledButton(
                        onPressed: () => context.go('/dashboard'),
                        child: const Text('Go to Dashboard'),
                      ),
                  ],
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  Widget _buildWelcome(ThemeData theme) {
    return Column(
      mainAxisAlignment: MainAxisAlignment.center,
      children: [
        Container(
          width: 64,
          height: 64,
          decoration: BoxDecoration(
            gradient: LinearGradient(
              colors: [theme.colorScheme.primary, theme.colorScheme.tertiary],
            ),
            borderRadius: BorderRadius.circular(16),
          ),
          child: const Icon(Icons.hub, color: Colors.white, size: 32),
        ),
        const SizedBox(height: 24),
        Text(
          'Welcome to Synapse',
          style: theme.textTheme.headlineMedium?.copyWith(
            fontWeight: FontWeight.bold,
          ),
        ),
        const SizedBox(height: 12),
        Text(
          'Synapse is your team\'s memory layer. It captures engineering knowledge from AI sessions, '
          'extracts facts, and provides sub-200ms retrieval.',
          textAlign: TextAlign.center,
          style: theme.textTheme.bodyLarge,
        ),
      ],
    );
  }

  Widget _buildHealthCheck(ThemeData theme) {
    return Column(
      mainAxisAlignment: MainAxisAlignment.center,
      children: [
        Icon(
          _healthOk ? Icons.check_circle : Icons.error_outline,
          size: 48,
          color: _healthOk ? Colors.green : Colors.orange,
        ),
        const SizedBox(height: 16),
        Text('System Health', style: theme.textTheme.headlineSmall),
        const SizedBox(height: 12),
        Text(
          _checking
              ? 'Checking connections...'
              : _healthOk
              ? 'All systems connected and ready.'
              : 'Some services are not reachable. Check your configuration.',
          textAlign: TextAlign.center,
        ),
        const SizedBox(height: 16),
        if (!_healthOk)
          OutlinedButton(onPressed: _checkHealth, child: const Text('Retry')),
      ],
    );
  }

  Widget _buildCapture(ThemeData theme) {
    return Column(
      mainAxisAlignment: MainAxisAlignment.center,
      children: [
        const Icon(Icons.code, size: 48),
        const SizedBox(height: 16),
        Text('Start Capturing', style: theme.textTheme.headlineSmall),
        const SizedBox(height: 12),
        Text(
          'Use the MCP server, Python/JS SDK, or REST API to send engineering sessions.\n\n'
          'Example with curl:\n',
          textAlign: TextAlign.center,
        ),
        Container(
          padding: const EdgeInsets.all(12),
          decoration: BoxDecoration(
            color: theme.colorScheme.surfaceContainerHighest,
            borderRadius: BorderRadius.circular(8),
          ),
          child: const SelectableText(
            'curl -X POST http://HOST:3000/api/v1/capture/passive \\\n'
            '  -H "Authorization: Bearer \$TOKEN" \\\n'
            '  -d \'{"messages":[...],"repository":"org/repo"}\'',
            style: TextStyle(fontFamily: 'monospace', fontSize: 12),
          ),
        ),
      ],
    );
  }

  Widget _buildDone(ThemeData theme) {
    return Column(
      mainAxisAlignment: MainAxisAlignment.center,
      children: [
        const Icon(Icons.rocket_launch, size: 48, color: Colors.green),
        const SizedBox(height: 16),
        Text('You\'re Ready!', style: theme.textTheme.headlineSmall),
        const SizedBox(height: 12),
        Text(
          'Your Synapse instance is configured. Start capturing sessions and searching your team\'s knowledge.',
          textAlign: TextAlign.center,
        ),
      ],
    );
  }
}
