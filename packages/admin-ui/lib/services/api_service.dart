import 'dart:convert';
import 'package:http/http.dart' as http;
import 'auth_service.dart';

class ApiService {
  final AuthService auth;
  // Use relative URL when served from the same origin (nginx proxies /api/ to Go)
  // This ensures the JWT token is injected by nginx automatically
  static String baseUrl = const String.fromEnvironment(
    'API_URL',
    defaultValue: '',  // Empty = same origin (relative URLs)
  );

  ApiService({required this.auth});

  Map<String, String> get _headers => {
        'Content-Type': 'application/json',
        if (auth.token != null) 'Authorization': 'Bearer ${auth.token}',
      };

  Future<Map<String, dynamic>> get(String path) async {
    final res = await http.get(Uri.parse('$baseUrl$path'), headers: _headers);
    if (res.statusCode != 200) throw ApiException(res.statusCode, res.body);
    return jsonDecode(res.body);
  }

  Future<Map<String, dynamic>> post(String path, Map<String, dynamic> body) async {
    final res = await http.post(
      Uri.parse('$baseUrl$path'),
      headers: _headers,
      body: jsonEncode(body),
    );
    if (res.statusCode >= 400) throw ApiException(res.statusCode, res.body);
    return jsonDecode(res.body);
  }

  Future<Map<String, dynamic>> put(String path, Map<String, dynamic> body) async {
    final res = await http.put(
      Uri.parse('$baseUrl$path'),
      headers: _headers,
      body: jsonEncode(body),
    );
    if (res.statusCode >= 400) throw ApiException(res.statusCode, res.body);
    return jsonDecode(res.body);
  }

  Future<void> delete(String path) async {
    final res = await http.delete(Uri.parse('$baseUrl$path'), headers: _headers);
    if (res.statusCode >= 400) throw ApiException(res.statusCode, res.body);
  }

  // ─── Specific API Methods ──────────────────────────────────────────────

  Future<Map<String, dynamic>> getHealth() => get('/health/ready');

  Future<Map<String, dynamic>> getStats() => get('/api/v1/stats');

  Future<Map<String, dynamic>> getLearningMetrics() => get('/api/v1/stats/learning');

  Future<Map<String, dynamic>> triggerLearningCycle() =>
      post('/api/v1/stats/learning/trigger', {});

  Future<Map<String, dynamic>> getUsers() => get('/api/v1/admin/users');

  Future<Map<String, dynamic>> createUser(Map<String, dynamic> user) =>
      post('/api/v1/admin/users', user);

  Future<Map<String, dynamic>> updateUser(String id, Map<String, dynamic> data) =>
      put('/api/v1/admin/users/$id', data);

  Future<void> deleteUser(String id) => delete('/api/v1/admin/users/$id');

  Future<Map<String, dynamic>> getRoles() => get('/api/v1/admin/roles');

  Future<Map<String, dynamic>> getMetrics() => get('/api/v1/stats/metrics');

  // ─── LLM Configuration ─────────────────────────────────────────────────

  Future<Map<String, dynamic>> getLlmSettings() =>
      get('/api/v1/admin/settings/llm');

  Future<Map<String, dynamic>> saveLlmSettings(Map<String, dynamic> settings) =>
      put('/api/v1/admin/settings/llm', settings);

  /// Probes the provider with a real completion. Returns ok/message/latencyMs.
  /// Passing the unsaved form lets the operator test before committing.
  Future<Map<String, dynamic>> testLlmSettings(Map<String, dynamic> settings) =>
      post('/api/v1/admin/settings/llm/test', settings);

  /// Lists models the provider has available, for the model picker.
  Future<Map<String, dynamic>> getLlmModels({
    String? provider,
    String? baseUrl,
  }) {
    final params = <String, String>{
      if (provider != null && provider.isNotEmpty) 'provider': provider,
      if (baseUrl != null && baseUrl.isNotEmpty) 'baseUrl': baseUrl,
    };
    final query = params.entries
        .map((e) => '${e.key}=${Uri.encodeQueryComponent(e.value)}')
        .join('&');
    return get('/api/v1/admin/settings/llm/models${query.isEmpty ? '' : '?$query'}');
  }
}

class ApiException implements Exception {
  final int statusCode;
  final String body;
  ApiException(this.statusCode, this.body);
  @override
  String toString() => 'API Error $statusCode: $body';
}
