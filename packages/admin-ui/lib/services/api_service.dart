import 'dart:convert';
import 'package:http/http.dart' as http;
import 'auth_service.dart';

class ApiService {
  final AuthService auth;
  // Default to localhost; override via environment or settings
  static String baseUrl = const String.fromEnvironment(
    'API_URL',
    defaultValue: 'http://172.16.10.85:3000',
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
}

class ApiException implements Exception {
  final int statusCode;
  final String body;
  ApiException(this.statusCode, this.body);

  @override
  String toString() => 'API Error $statusCode: $body';
}
