import 'package:flutter/foundation.dart';

class AuthService extends ChangeNotifier {
  String? _token;
  String? _userId;
  String? _organizationId;

  String? get token => _token;
  String? get userId => _userId;
  String? get organizationId => _organizationId;
  bool get isAuthenticated => _token != null;

  void login({required String token, String? userId, String? organizationId}) {
    _token = token;
    _userId = userId ?? 'admin';
    _organizationId = organizationId ?? 'default';
    notifyListeners();
  }

  void logout() {
    _token = null;
    _userId = null;
    _organizationId = null;
    notifyListeners();
  }

  /// For development: auto-login with a development token
  void devLogin() {
    login(
      token: 'dev-token',
      userId: 'admin',
      organizationId: 'default',
    );
  }
}
