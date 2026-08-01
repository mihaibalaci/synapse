import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:http/http.dart' as http;

class AuthUser {
  final String id;
  final String email;
  final String displayName;
  final String organizationId;
  final List<String> roles;

  const AuthUser({
    required this.id,
    required this.email,
    required this.displayName,
    required this.organizationId,
    required this.roles,
  });

  factory AuthUser.fromJson(Map<String, dynamic> value) => AuthUser(
    id: value['id'] as String? ?? '',
    email: value['email'] as String? ?? '',
    displayName: value['displayName'] as String? ?? '',
    organizationId: value['organizationId'] as String? ?? '',
    roles: (value['roles'] as List<dynamic>? ?? const [])
        .whereType<String>()
        .toList(growable: false),
  );
}

class AuthService extends ChangeNotifier {
  AuthService({http.Client? client}) : _client = client ?? http.Client();

  static const String baseUrl = String.fromEnvironment(
    'API_URL',
    defaultValue: '',
  );

  final http.Client _client;
  String? _token;
  AuthUser? _user;
  bool _initialized = false;
  bool _busy = false;
  String? _error;
  Future<bool>? _refreshInFlight;

  String? get token => _token;
  AuthUser? get user => _user;
  String? get userId => _user?.id;
  String? get organizationId => _user?.organizationId;
  bool get isAuthenticated => _token != null && _user != null;
  bool get initialized => _initialized;
  bool get busy => _busy;
  String? get error => _error;

  Future<void> initialize() async {
    if (_initialized) return;
    await refresh();
    _initialized = true;
    notifyListeners();
  }

  Future<bool> login({
    required String email,
    required String password,
    required String organizationId,
  }) async {
    _busy = true;
    _error = null;
    notifyListeners();
    try {
      final response = await _client.post(
        Uri.parse('$baseUrl/api/v1/auth/login'),
        headers: const {'Content-Type': 'application/json'},
        body: jsonEncode({
          'email': email.trim(),
          'password': password,
          'organizationId': organizationId.trim(),
        }),
      );
      if (response.statusCode != 200) {
        _clearSession();
        _error = _messageFrom(response.body, 'Login failed');
        return false;
      }
      _applySession(jsonDecode(response.body) as Map<String, dynamic>);
      return true;
    } catch (_) {
      _clearSession();
      _error = 'Authentication service is unavailable';
      return false;
    } finally {
      _initialized = true;
      _busy = false;
      notifyListeners();
    }
  }

  Future<bool> refresh() {
    final current = _refreshInFlight;
    if (current != null) return current;
    final operation = _performRefresh();
    _refreshInFlight = operation;
    operation.whenComplete(() => _refreshInFlight = null);
    return operation;
  }

  Future<bool> _performRefresh() async {
    try {
      final response = await _client.post(
        Uri.parse('$baseUrl/api/v1/auth/refresh'),
        headers: const {'Content-Type': 'application/json'},
      );
      if (response.statusCode != 200) {
        _clearSession();
        return false;
      }
      _applySession(jsonDecode(response.body) as Map<String, dynamic>);
      return true;
    } catch (_) {
      _clearSession();
      return false;
    } finally {
      notifyListeners();
    }
  }

  Future<void> logout() async {
    final accessToken = _token;
    _clearSession();
    notifyListeners();
    try {
      await _client.post(
        Uri.parse('$baseUrl/api/v1/auth/logout'),
        headers: {
          'Content-Type': 'application/json',
          if (accessToken != null) 'Authorization': 'Bearer $accessToken',
        },
      );
    } catch (_) {
      // Local logout is authoritative even if server revocation is unavailable.
    }
  }

  void expireSession() {
    if (_token == null && _user == null) return;
    _clearSession();
    notifyListeners();
  }

  void _applySession(Map<String, dynamic> value) {
    final token = value['accessToken'] as String?;
    final userValue = value['user'];
    if (token == null || token.isEmpty || userValue is! Map<String, dynamic>) {
      throw const FormatException('Invalid authentication response');
    }
    _token = token;
    _user = AuthUser.fromJson(userValue);
    _error = null;
  }

  void _clearSession() {
    _token = null;
    _user = null;
  }

  String _messageFrom(String body, String fallback) {
    try {
      final value = jsonDecode(body) as Map<String, dynamic>;
      return value['message'] as String? ?? fallback;
    } catch (_) {
      return fallback;
    }
  }

  /// Used only by isolated widget tests that supply a mocked API service.
  void devLogin() {
    _initialized = true;
    _token = 'test-only-token';
    _user = const AuthUser(
      id: 'admin',
      email: 'admin@example.test',
      displayName: 'Test Administrator',
      organizationId: 'default',
      roles: ['admin'],
    );
    notifyListeners();
  }
}
