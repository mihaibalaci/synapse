import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import 'pages/dashboard/dashboard_page.dart';
import 'pages/login/login_page.dart';
import 'pages/graph/graph_page.dart';
import 'pages/keys/keys_page.dart';
import 'pages/memory/memory_page.dart';
import 'pages/onboarding/onboarding_page.dart';
import 'pages/operations/operations_page.dart';
import 'pages/search/search_page.dart';
import 'pages/teams/teams_page.dart';
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
      GoRoute(
        path: '/onboarding',
        pageBuilder: (context, state) =>
            const NoTransitionPage(child: OnboardingPage()),
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
            path: '/teams',
            pageBuilder: (context, state) =>
                const NoTransitionPage(child: TeamsPage()),
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
          GoRoute(
            path: '/memory',
            pageBuilder: (context, state) =>
                const NoTransitionPage(child: MemoryPage()),
          ),
          GoRoute(
            path: '/search',
            pageBuilder: (context, state) =>
                const NoTransitionPage(child: SearchPage()),
          ),
          GoRoute(
            path: '/graph',
            pageBuilder: (context, state) =>
                const NoTransitionPage(child: GraphPage()),
          ),
          GoRoute(
            path: '/keys',
            pageBuilder: (context, state) =>
                const NoTransitionPage(child: ApiKeysPage()),
          ),
          GoRoute(
            path: '/operations',
            pageBuilder: (context, state) =>
                const NoTransitionPage(child: OperationsPage()),
          ),
        ],
      ),
    ],
  );
}
