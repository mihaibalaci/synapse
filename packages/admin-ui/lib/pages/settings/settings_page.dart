import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:provider/provider.dart';
import '../../services/api_service.dart';
import '../../services/refresh_bus.dart';

/// Configuration for the language model used by synthesis features.
///
/// Settings are persisted server side rather than baked into environment
/// variables, so an operator can point Synapse at a different model host
/// without a redeploy. The API key is never sent back to the browser: the form
/// shows a mask, and submitting it unchanged keeps the stored credential.
class SettingsPage extends StatefulWidget {
  const SettingsPage({super.key});

  @override
  State<SettingsPage> createState() => _SettingsPageState();
}

class _SettingsPageState extends State<SettingsPage> {
  static const _providers = ['none', 'ollama', 'openai', 'anthropic'];

  final _formKey = GlobalKey<FormState>();
  final _baseUrlCtrl = TextEditingController();
  final _modelCtrl = TextEditingController();
  final _apiKeyCtrl = TextEditingController();
  final _maxTokensCtrl = TextEditingController();
  final _threadsCtrl = TextEditingController();
  final _timeoutCtrl = TextEditingController();

  String _provider = 'none';
  double _temperature = 0.2;
  bool _enabled = false;

  bool _loading = true;
  bool _saving = false;
  bool _testing = false;
  bool _discovering = false;
  String? _error;
  String? _updatedAt;
  String? _updatedBy;
  List<String> _availableModels = [];
  _TestOutcome? _testOutcome;

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
    _load();
  }

  @override
  void dispose() {
    _bus?.removeListener(_onRefreshRequested);
    _baseUrlCtrl.dispose();
    _modelCtrl.dispose();
    _apiKeyCtrl.dispose();
    _maxTokensCtrl.dispose();
    _threadsCtrl.dispose();
    _timeoutCtrl.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });

    try {
      final data = await context.read<ApiService>().getLlmSettings();
      final s = (data['settings'] as Map?) ?? {};

      if (!mounted) return;
      setState(() {
        _provider = _providers.contains(s['provider']) ? s['provider'] : 'none';
        _baseUrlCtrl.text = (s['baseUrl'] ?? '').toString();
        _modelCtrl.text = (s['model'] ?? '').toString();
        _apiKeyCtrl.text = (s['apiKey'] ?? '').toString();
        _temperature = _asDouble(s['temperature'], 0.2).clamp(0.0, 2.0);
        _maxTokensCtrl.text = _asInt(s['maxTokens'], 1024).toString();
        _threadsCtrl.text = _asInt(s['numThread'], 4).toString();
        _timeoutCtrl.text = _asInt(s['timeoutSeconds'], 120).toString();
        _enabled = s['enabled'] == true;
        _updatedAt = (data['updatedAt'] ?? '').toString();
        _updatedBy = (data['updatedBy'] ?? '').toString();
        _loading = false;
      });

      if (_provider == 'ollama') _discoverModels(silent: true);
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _error = 'Could not load settings: $e';
        _loading = false;
      });
    }
  }

  Map<String, dynamic> _formPayload() => {
    'provider': _provider,
    'baseUrl': _baseUrlCtrl.text.trim(),
    'model': _modelCtrl.text.trim(),
    'apiKey': _apiKeyCtrl.text,
    'temperature': _temperature,
    'maxTokens': _asInt(_maxTokensCtrl.text, 1024),
    'numThread': _asInt(_threadsCtrl.text, 4),
    'timeoutSeconds': _asInt(_timeoutCtrl.text, 120),
    'enabled': _enabled,
  };

  Future<void> _save() async {
    if (!(_formKey.currentState?.validate() ?? false)) return;

    setState(() {
      _saving = true;
      _error = null;
    });

    try {
      await context.read<ApiService>().saveLlmSettings(_formPayload());
      if (!mounted) return;
      setState(() => _saving = false);
      _notify('Configuration saved', Colors.green);
      _load();
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _error = _friendlyError(e);
        _saving = false;
      });
    }
  }

  /// Tests the values currently in the form, not the saved ones, so a change can
  /// be verified before it is committed.
  Future<void> _test() async {
    if (!(_formKey.currentState?.validate() ?? false)) return;

    setState(() {
      _testing = true;
      _testOutcome = null;
      _error = null;
    });

    try {
      final result = await context.read<ApiService>().testLlmSettings(
        _formPayload(),
      );
      if (!mounted) return;
      setState(() {
        _testing = false;
        _testOutcome = _TestOutcome(
          ok: result['ok'] == true,
          message: (result['message'] ?? '').toString(),
          latencyMs: _asInt(result['latencyMs'], 0),
          reply: (result['reply'] ?? '').toString(),
        );
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _testing = false;
        _testOutcome = _TestOutcome(
          ok: false,
          message: _friendlyError(e),
          latencyMs: 0,
          reply: '',
        );
      });
    }
  }

  Future<void> _discoverModels({bool silent = false}) async {
    setState(() => _discovering = true);
    try {
      final result = await context.read<ApiService>().getLlmModels(
        provider: _provider,
        baseUrl: _baseUrlCtrl.text.trim(),
      );
      if (!mounted) return;
      final models = ((result['models'] as List?) ?? [])
          .map((m) => m.toString())
          .toList();
      setState(() {
        _availableModels = models;
        _discovering = false;
      });
      if (!silent) {
        final message = (result['message'] ?? '').toString();
        _notify(
          models.isEmpty
              ? (message.isEmpty ? 'No models found' : message)
              : 'Found ${models.length} model${models.length == 1 ? '' : 's'}',
          models.isEmpty ? Colors.orange : Colors.green,
        );
      }
    } catch (e) {
      if (!mounted) return;
      setState(() => _discovering = false);
      if (!silent) _notify(_friendlyError(e), Colors.red);
    }
  }

  void _notify(String message, Color color) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(message),
        backgroundColor: color,
        behavior: SnackBarBehavior.floating,
        duration: const Duration(seconds: 3),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colorScheme = theme.colorScheme;
    final needsKey = _provider == 'openai' || _provider == 'anthropic';
    final isSelfHosted = _provider == 'ollama';
    final configured = _provider != 'none';

    return SingleChildScrollView(
      padding: const EdgeInsets.all(24),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            'Configuration',
            style: theme.textTheme.headlineSmall?.copyWith(
              fontWeight: FontWeight.bold,
            ),
          ),
          const SizedBox(height: 4),
          Text(
            'Language model used for synthesis features such as reflect',
            style: theme.textTheme.bodyMedium?.copyWith(
              color: colorScheme.onSurface.withValues(alpha: 0.6),
            ),
          ),
          const SizedBox(height: 24),

          if (_loading) const LinearProgressIndicator(minHeight: 2),

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
                  fontSize: 13,
                ),
              ),
            ),

          if (!_loading)
            Form(
              key: _formKey,
              child: ConstrainedBox(
                constraints: const BoxConstraints(maxWidth: 720),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Card(
                      child: Padding(
                        padding: const EdgeInsets.all(20),
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Row(
                              children: [
                                Icon(
                                  Icons.smart_toy_outlined,
                                  size: 20,
                                  color: colorScheme.primary,
                                ),
                                const SizedBox(width: 8),
                                Text(
                                  'Language Model',
                                  style: theme.textTheme.titleMedium?.copyWith(
                                    fontWeight: FontWeight.w600,
                                  ),
                                ),
                                const Spacer(),
                                Switch(
                                  value: _enabled && configured,
                                  onChanged: configured
                                      ? (v) => setState(() => _enabled = v)
                                      : null,
                                ),
                                const SizedBox(width: 4),
                                Text(
                                  _enabled && configured
                                      ? 'Enabled'
                                      : 'Disabled',
                                  style: theme.textTheme.bodySmall,
                                ),
                              ],
                            ),
                            const SizedBox(height: 20),

                            DropdownButtonFormField<String>(
                              initialValue: _provider,
                              decoration: const InputDecoration(
                                labelText: 'Provider',
                                border: OutlineInputBorder(),
                                helperText:
                                    'Self-hosted ollama keeps conversations on your network',
                              ),
                              items: _providers
                                  .map(
                                    (p) => DropdownMenuItem(
                                      value: p,
                                      child: Text(_providerLabel(p)),
                                    ),
                                  )
                                  .toList(),
                              onChanged: (v) {
                                if (v == null) return;
                                setState(() {
                                  _provider = v;
                                  _testOutcome = null;
                                  _availableModels = [];
                                  if (v == 'ollama' &&
                                      _baseUrlCtrl.text.trim().isEmpty) {
                                    _baseUrlCtrl.text =
                                        'http://localhost:11434';
                                  }
                                });
                                if (v == 'ollama')
                                  _discoverModels(silent: true);
                              },
                            ),

                            if (_provider == 'none') ...[
                              const SizedBox(height: 16),
                              Container(
                                padding: const EdgeInsets.all(12),
                                decoration: BoxDecoration(
                                  color: colorScheme.surfaceContainerHighest
                                      .withValues(alpha: 0.4),
                                  borderRadius: BorderRadius.circular(8),
                                ),
                                child: Row(
                                  children: [
                                    Icon(
                                      Icons.info_outline,
                                      size: 18,
                                      color: colorScheme.onSurface.withValues(
                                        alpha: 0.5,
                                      ),
                                    ),
                                    const SizedBox(width: 10),
                                    Expanded(
                                      child: Text(
                                        'No model configured. Search and facts work normally; '
                                        'reflect returns raw memories without synthesis.',
                                        style: theme.textTheme.bodySmall,
                                      ),
                                    ),
                                  ],
                                ),
                              ),
                            ],

                            if (isSelfHosted) ...[
                              const SizedBox(height: 16),
                              TextFormField(
                                controller: _baseUrlCtrl,
                                decoration: const InputDecoration(
                                  labelText: 'Base URL',
                                  border: OutlineInputBorder(),
                                  hintText: 'http://172.16.10.15:11434',
                                  helperText: 'Host running ollama',
                                ),
                                validator: (v) {
                                  final value = (v ?? '').trim();
                                  if (value.isEmpty)
                                    return 'Base URL is required';
                                  if (!value.startsWith('http://') &&
                                      !value.startsWith('https://')) {
                                    return 'Must start with http:// or https://';
                                  }
                                  return null;
                                },
                              ),
                            ],

                            if (configured) ...[
                              const SizedBox(height: 16),
                              Row(
                                crossAxisAlignment: CrossAxisAlignment.start,
                                children: [
                                  Expanded(
                                    child: _availableModels.isEmpty
                                        ? TextFormField(
                                            controller: _modelCtrl,
                                            decoration: const InputDecoration(
                                              labelText: 'Model',
                                              border: OutlineInputBorder(),
                                              hintText: 'qwen2.5-cpu',
                                            ),
                                            validator: (v) =>
                                                (v ?? '').trim().isEmpty
                                                ? 'Model is required'
                                                : null,
                                          )
                                        : DropdownButtonFormField<String>(
                                            initialValue:
                                                _availableModels.contains(
                                                  _modelCtrl.text,
                                                )
                                                ? _modelCtrl.text
                                                : null,
                                            decoration: const InputDecoration(
                                              labelText: 'Model',
                                              border: OutlineInputBorder(),
                                            ),
                                            items: _availableModels
                                                .map(
                                                  (m) => DropdownMenuItem(
                                                    value: m,
                                                    child: Text(m),
                                                  ),
                                                )
                                                .toList(),
                                            onChanged: (v) => setState(
                                              () => _modelCtrl.text = v ?? '',
                                            ),
                                            validator: (v) =>
                                                (v == null || v.isEmpty)
                                                ? 'Select a model'
                                                : null,
                                          ),
                                  ),
                                  if (isSelfHosted) ...[
                                    const SizedBox(width: 8),
                                    Tooltip(
                                      message: 'Discover models on that host',
                                      child: SizedBox(
                                        height: 58,
                                        child: OutlinedButton(
                                          onPressed: _discovering
                                              ? null
                                              : () => _discoverModels(),
                                          child: _discovering
                                              ? const SizedBox(
                                                  width: 16,
                                                  height: 16,
                                                  child:
                                                      CircularProgressIndicator(
                                                        strokeWidth: 2,
                                                      ),
                                                )
                                              : const Icon(
                                                  Icons.refresh,
                                                  size: 18,
                                                ),
                                        ),
                                      ),
                                    ),
                                  ],
                                ],
                              ),
                            ],

                            if (needsKey) ...[
                              const SizedBox(height: 16),
                              TextFormField(
                                controller: _apiKeyCtrl,
                                obscureText: true,
                                decoration: const InputDecoration(
                                  labelText: 'API key',
                                  border: OutlineInputBorder(),
                                  helperText:
                                      'Stored server side. Leave the mask to keep the current key.',
                                ),
                                validator: (v) => (v ?? '').isEmpty
                                    ? 'API key is required for this provider'
                                    : null,
                              ),
                              const SizedBox(height: 8),
                              Row(
                                children: [
                                  Icon(
                                    Icons.warning_amber_rounded,
                                    size: 16,
                                    color: Colors.amber[700],
                                  ),
                                  const SizedBox(width: 8),
                                  Expanded(
                                    child: Text(
                                      'Hosted providers receive your conversation content. '
                                      'Use ollama to keep it on your own network.',
                                      style: theme.textTheme.bodySmall
                                          ?.copyWith(
                                            color: colorScheme.onSurface
                                                .withValues(alpha: 0.6),
                                          ),
                                    ),
                                  ),
                                ],
                              ),
                            ],
                          ],
                        ),
                      ),
                    ),

                    if (configured) ...[
                      const SizedBox(height: 16),
                      Card(
                        child: Padding(
                          padding: const EdgeInsets.all(20),
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Text(
                                'Generation',
                                style: theme.textTheme.titleMedium?.copyWith(
                                  fontWeight: FontWeight.w600,
                                ),
                              ),
                              const SizedBox(height: 16),

                              Row(
                                children: [
                                  SizedBox(
                                    width: 130,
                                    child: Text(
                                      'Temperature',
                                      style: theme.textTheme.bodyMedium,
                                    ),
                                  ),
                                  Expanded(
                                    child: Slider(
                                      value: _temperature,
                                      min: 0,
                                      max: 2,
                                      divisions: 20,
                                      label: _temperature.toStringAsFixed(1),
                                      onChanged: (v) =>
                                          setState(() => _temperature = v),
                                    ),
                                  ),
                                  SizedBox(
                                    width: 40,
                                    child: Text(
                                      _temperature.toStringAsFixed(1),
                                      textAlign: TextAlign.right,
                                      style: theme.textTheme.bodyMedium,
                                    ),
                                  ),
                                ],
                              ),
                              Text(
                                'Low values keep synthesis close to the retrieved material',
                                style: theme.textTheme.bodySmall?.copyWith(
                                  color: colorScheme.onSurface.withValues(
                                    alpha: 0.5,
                                  ),
                                ),
                              ),
                              const SizedBox(height: 20),

                              Row(
                                children: [
                                  Expanded(
                                    child: _numberField(
                                      controller: _maxTokensCtrl,
                                      label: 'Max tokens',
                                      min: 1,
                                      max: 32000,
                                    ),
                                  ),
                                  const SizedBox(width: 12),
                                  Expanded(
                                    child: _numberField(
                                      controller: _timeoutCtrl,
                                      label: 'Timeout (seconds)',
                                      min: 1,
                                      max: 900,
                                      helper: 'CPU inference is slow',
                                    ),
                                  ),
                                  if (isSelfHosted) ...[
                                    const SizedBox(width: 12),
                                    Expanded(
                                      child: _numberField(
                                        controller: _threadsCtrl,
                                        label: 'Threads',
                                        min: 0,
                                        max: 128,
                                        helper: 'Match real core count',
                                      ),
                                    ),
                                  ],
                                ],
                              ),
                            ],
                          ),
                        ),
                      ),
                    ],

                    if (_testOutcome != null) ...[
                      const SizedBox(height: 16),
                      _TestResultCard(outcome: _testOutcome!),
                    ],

                    const SizedBox(height: 20),
                    Row(
                      children: [
                        FilledButton.icon(
                          onPressed: _saving ? null : _save,
                          icon: _saving
                              ? const SizedBox(
                                  width: 16,
                                  height: 16,
                                  child: CircularProgressIndicator(
                                    strokeWidth: 2,
                                  ),
                                )
                              : const Icon(Icons.save_outlined, size: 18),
                          label: Text(_saving ? 'Saving…' : 'Save'),
                        ),
                        const SizedBox(width: 12),
                        OutlinedButton.icon(
                          onPressed: (_testing || !configured) ? null : _test,
                          icon: _testing
                              ? const SizedBox(
                                  width: 16,
                                  height: 16,
                                  child: CircularProgressIndicator(
                                    strokeWidth: 2,
                                  ),
                                )
                              : const Icon(Icons.play_arrow_rounded, size: 18),
                          label: Text(
                            _testing ? 'Testing…' : 'Test connection',
                          ),
                        ),
                        const Spacer(),
                        if ((_updatedAt ?? '').isNotEmpty)
                          Text(
                            'Last changed $_updatedAt by ${_updatedBy!.isEmpty ? 'unknown' : _updatedBy}',
                            style: theme.textTheme.bodySmall?.copyWith(
                              color: colorScheme.onSurface.withValues(
                                alpha: 0.5,
                              ),
                            ),
                          ),
                      ],
                    ),
                  ],
                ),
              ),
            ),
        ],
      ),
    );
  }

  Widget _numberField({
    required TextEditingController controller,
    required String label,
    required int min,
    required int max,
    String? helper,
  }) {
    return TextFormField(
      controller: controller,
      keyboardType: TextInputType.number,
      inputFormatters: [FilteringTextInputFormatter.digitsOnly],
      decoration: InputDecoration(
        labelText: label,
        border: const OutlineInputBorder(),
        helperText: helper,
      ),
      validator: (v) {
        final n = int.tryParse((v ?? '').trim());
        if (n == null) return 'Enter a number';
        if (n < min || n > max) return 'Must be $min–$max';
        return null;
      },
    );
  }

  static String _providerLabel(String p) => switch (p) {
    'none' => 'None (synthesis disabled)',
    'ollama' => 'Ollama (self-hosted)',
    'openai' => 'OpenAI',
    'anthropic' => 'Anthropic',
    _ => p,
  };

  static double _asDouble(dynamic v, double fallback) =>
      v is num ? v.toDouble() : (double.tryParse('$v') ?? fallback);

  static int _asInt(dynamic v, int fallback) =>
      v is num ? v.toInt() : (int.tryParse('$v'.trim()) ?? fallback);

  /// Surfaces the server's validation message rather than a raw status dump.
  static String _friendlyError(Object e) {
    final text = e.toString();
    final match = RegExp(r'"message"\s*:\s*"([^"]+)"').firstMatch(text);
    return match != null ? match.group(1)! : text;
  }
}

class _TestOutcome {
  final bool ok;
  final String message;
  final int latencyMs;
  final String reply;
  const _TestOutcome({
    required this.ok,
    required this.message,
    required this.latencyMs,
    required this.reply,
  });
}

class _TestResultCard extends StatelessWidget {
  final _TestOutcome outcome;
  const _TestResultCard({required this.outcome});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final color = outcome.ok ? Colors.green : Colors.red;

    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.08),
        border: Border.all(color: color.withValues(alpha: 0.35)),
        borderRadius: BorderRadius.circular(8),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(
                outcome.ok ? Icons.check_circle_outline : Icons.error_outline,
                size: 18,
                color: color,
              ),
              const SizedBox(width: 8),
              Text(
                outcome.ok ? 'Connection succeeded' : 'Connection failed',
                style: theme.textTheme.titleSmall?.copyWith(
                  fontWeight: FontWeight.w600,
                  color: color,
                ),
              ),
              const Spacer(),
              if (outcome.latencyMs > 0)
                Text(
                  '${outcome.latencyMs} ms',
                  style: theme.textTheme.bodySmall,
                ),
            ],
          ),
          if (outcome.message.isNotEmpty) ...[
            const SizedBox(height: 8),
            Text(outcome.message, style: theme.textTheme.bodySmall),
          ],
          if (outcome.reply.isNotEmpty) ...[
            const SizedBox(height: 8),
            Text(
              'Model replied: "${outcome.reply}"',
              style: theme.textTheme.bodySmall?.copyWith(
                fontFamily: 'monospace',
              ),
            ),
          ],
        ],
      ),
    );
  }
}
