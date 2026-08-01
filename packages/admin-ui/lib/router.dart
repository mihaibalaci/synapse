import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import 'pages/dashboard/dashboard_page.dart';
import 'pages/login/login_page.dart';
import 'pages/users/users_page.dart';
import 'pages/system/system_page.dart';
import 'pages/activity/activity_page.dart';
import 'pages/settings/settings_page.dart';
import 'services/auth_service.dart';
import 'widgets/shell_scaffold.dart';

GoRouter buildRouter(AuthService auth) {
  return GoRouter(
    initialLocation: '/dashboard',
    refreshListenable: auth,
    redirect: (BuildContext context, GoRouterState state) {
      final loggedIn = auth.isAuthenticated;
      final onLogin = state.matchedLocation == '/login';

      if (!auth.initialized) return null;
      if (!loggedIn && !onLogin) return '/login';
      if (loggedIn && onLogin) return '/dashboard';
      return null;
    },
    routes: [
      GoRoute(
        path: '/login',
        pageBuilder: (context, state) =>
            const NoTransitionPage(child: LoginPage()),
      ),
      ShellRoute(
        builder: (context, state, child) => ShellScaffold(child: child),
        routes: [
          GoRoute(
            path: '/dashboard',
            pageBuilder: (context, state) =>
                const NoTransitionPage(child: DashboardPage()),
          ),
          GoRoute(
            path: '/users',
            pageBuilder: (context, state) =>
                const NoTransitionPage(child: UsersPage()),
          ),
          GoRoute(
            path: '/system',
            pageBuilder: (context, state) =>
                const NoTransitionPage(child: SystemPage()),
          ),
          GoRoute(
            path: '/activity',
            pageBuilder: (context, state) =>
                const NoTransitionPage(child: ActivityPage()),
          ),
          GoRoute(
            path: '/settings',
            pageBuilder: (context, state) =>
                const NoTransitionPage(child: SettingsPage()),
          ),
        ],
      ),
    ],
  );
}
