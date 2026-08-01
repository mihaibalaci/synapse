import 'dart:convert';

import 'package:http/http.dart' as http;

import 'auth_service.dart';

class ApiService {
  ApiService({required this.auth, http.Client? client})
    : _client = client ?? http.Client();

  final AuthService auth;
  final http.Client _client;

  // Empty means same-origin; nginx proxies /api/ to the Go service.
  static const String baseUrl = String.fromEnvironment(
    'API_URL',
    defaultValue: '',
  );

  Map<String, String> get _headers => {
    'Content-Type': 'application/json',
    if (auth.token != null) 'Authorization': 'Bearer ${auth.token}',
  };

  Future<http.Response> _send(
    String method,
    String path, {
    Map<String, dynamic>? body,
    bool retryAfterRefresh = true,
  }) async {
    final uri = Uri.parse('$baseUrl$path');
    late http.Response response;
    switch (method) {
      case 'GET':
        response = await _client.get(uri, headers: _headers);
        break;
      case 'POST':
        response = await _client.post(
          uri,
          headers: _headers,
          body: jsonEncode(body ?? const <String, dynamic>{}),
        );
        break;
      case 'PUT':
        response = await _client.put(
          uri,
          headers: _headers,
          body: jsonEncode(body ?? const <String, dynamic>{}),
        );
        break;
      case 'DELETE':
        response = await _client.delete(uri, headers: _headers);
        break;
      default:
        throw ArgumentError.value(method, 'method');
    }

    if (response.statusCode == 401 && retryAfterRefresh) {
      if (await auth.refresh()) {
        return _send(method, path, body: body, retryAfterRefresh: false);
      }
      auth.expireSession();
    }
    return response;
  }

  Future<Map<String, dynamic>> get(String path) async {
    final response = await _send('GET', path);
    if (response.statusCode != 200) {
      throw ApiException(response.statusCode, response.body);
    }
    return jsonDecode(response.body) as Map<String, dynamic>;
  }

  Future<Map<String, dynamic>> post(
    String path,
    Map<String, dynamic> body,
  ) async {
    final response = await _send('POST', path, body: body);
    if (response.statusCode >= 400) {
      throw ApiException(response.statusCode, response.body);
    }
    return jsonDecode(response.body) as Map<String, dynamic>;
  }

  Future<Map<String, dynamic>> put(
    String path,
    Map<String, dynamic> body,
  ) async {
    final response = await _send('PUT', path, body: body);
    if (response.statusCode >= 400) {
      throw ApiException(response.statusCode, response.body);
    }
    return jsonDecode(response.body) as Map<String, dynamic>;
  }

  Future<void> delete(String path) async {
    final response = await _send('DELETE', path);
    if (response.statusCode >= 400) {
      throw ApiException(response.statusCode, response.body);
    }
  }

  Future<Map<String, dynamic>> getHealth() => get('/health/ready');

  Future<Map<String, dynamic>> getStats() => get('/api/v1/stats');

  Future<Map<String, dynamic>> getLearningMetrics() =>
      get('/api/v1/stats/learning');

  Future<Map<String, dynamic>> triggerLearningCycle() =>
      post('/api/v1/stats/learning/trigger', {});

  Future<Map<String, dynamic>> getUsers() => get('/api/v1/admin/users');

  Future<Map<String, dynamic>> createUser(Map<String, dynamic> user) =>
      post('/api/v1/admin/users', user);

  Future<Map<String, dynamic>> updateUser(
    String id,
    Map<String, dynamic> data,
  ) => put('/api/v1/admin/users/$id', data);

  Future<void> deleteUser(String id) => delete('/api/v1/admin/users/$id');

  Future<Map<String, dynamic>> getRoles() => get('/api/v1/admin/roles');

  Future<Map<String, dynamic>> getMetrics() => get('/api/v1/stats/metrics');

  Future<Map<String, dynamic>> getLlmSettings() =>
      get('/api/v1/admin/settings/llm');

  Future<Map<String, dynamic>> saveLlmSettings(Map<String, dynamic> settings) =>
      put('/api/v1/admin/settings/llm', settings);

  Future<Map<String, dynamic>> testLlmSettings(Map<String, dynamic> settings) =>
      post('/api/v1/admin/settings/llm/test', settings);

  Future<Map<String, dynamic>> getLlmModels({
    String? provider,
    String? baseUrl,
  }) {
    final params = <String, String>{
      if (provider != null && provider.isNotEmpty) 'provider': provider,
      if (baseUrl != null && baseUrl.isNotEmpty) 'baseUrl': baseUrl,
    };
    final query = params.entries
        .map((entry) => '${entry.key}=${Uri.encodeQueryComponent(entry.value)}')
        .join('&');
    return get(
      '/api/v1/admin/settings/llm/models${query.isEmpty ? '' : '?$query'}',
    );
  }
}

class ApiException implements Exception {
  final int statusCode;
  final String body;
  ApiException(this.statusCode, this.body);

  @override
  String toString() => 'API Error $statusCode: $body';
}
